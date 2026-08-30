//! Text embeddings through the bge-m3 sidecar container (docker/embedding,
//! self-built thin image exposing an OpenAI-compatible POST /embeddings).
//! Vectors are consumed by the server (semantic search); the worker only
//! owns the container lifecycle and the HTTP hop — every Mentro-side
//! container concern stays in the worker.

use std::time::Duration;

use once_cell::sync::Lazy;

use crate::{
    error::{WorkerError, WorkerResult},
    ext::container,
    proto::mentro::worker::v1::{CMsgEmbedding, EmbedRequest, EmbedResult},
};

static SPEC: Lazy<container::ContainerSpec> = Lazy::new(|| container::ContainerSpec {
    log_tag: "embed",
    name: "mentro-embed",
    image: "mentro-embed:latest",
    host_port: 9600,
    container_port: 8000,
    url_env: "MENTRO_EMBED_URL",
    off_env: "MENTRO_EMBED",
    extra_env: &[],
    health_path: "/health",
    // bge-m3 is ~2 GB; first boot downloads it.
    health_timeout_sec: 600,
});
static GUARD: Lazy<container::Guard> = Lazy::new(container::Guard::new);

/// Batch cap: keeps single requests (and the response frame) modest.
const BATCH_CAP: usize = 64;

pub fn embed(req: &EmbedRequest) -> WorkerResult<EmbedResult> {
    if req.texts.is_empty() {
        return Err(WorkerError::invalid("embed needs at least one text"));
    }
    if req.texts.len() > BATCH_CAP {
        return Err(WorkerError::invalid(format!(
            "embed batch cap is {BATCH_CAP} texts, got {}",
            req.texts.len()
        )));
    }
    let Some(base) = container::ensure(&SPEC, &GUARD) else {
        // Unavailable: empty result, the server degrades to FTS-only.
        return Ok(EmbedResult {
            embeddings: Vec::new(),
        });
    };

    let resp = ureq::post(&format!("{base}/embeddings"))
        .timeout(Duration::from_secs(300))
        .send_json(ureq::json!({ "input": req.texts }))
        .map_err(|e| {
            WorkerError::new(
                crate::proto::mentro::worker::v1::EErrorCode::ToolNonZeroExit,
                format!("embedding backend: {e}"),
                true,
            )
        })?;
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| WorkerError::invalid(format!("embedding response decode: {e}")))?;

    let mut embeddings = Vec::new();
    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        // OpenAI-compatible order: data[i].index == i.
        let mut by_index: Vec<Option<Vec<f32>>> = vec![None; req.texts.len()];
        for item in data {
            let index = item.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            if let Some(vector) = item.get("embedding").and_then(|v| v.as_array()) {
                let parsed: Vec<f32> = vector
                    .iter()
                    .filter_map(|f| f.as_f64().map(|f| f as f32))
                    .collect();
                if index < by_index.len() {
                    by_index[index] = Some(parsed);
                }
            }
        }
        for slot in by_index {
            match slot {
                Some(vector) => embeddings.push(CMsgEmbedding { vector }),
                None => {
                    return Err(WorkerError::internal(
                        "embedding backend returned incomplete batch",
                    ));
                }
            }
        }
    }
    if embeddings.len() != req.texts.len() {
        return Err(WorkerError::internal(
            "embedding backend returned wrong batch size",
        ));
    }
    Ok(EmbedResult { embeddings })
}
