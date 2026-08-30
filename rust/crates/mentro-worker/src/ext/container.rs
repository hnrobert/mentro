//! Lazy singleton-container lifecycle shared by the M6 sidecars
//! (whisper transcription, text embeddings). Same §7.6 rules as the
//! office/OCR containers: probe runtime -> start existing -> create ->
//! health poll; one warning when unavailable, then stay out of the way.
//!
//! Unlike the older ocr/gotenberg managers this supports
//! `MENTRO_*_URL` overrides so compose deployments can point at sibling
//! services instead of docker-managed containers (the app container has
//! no docker socket).

use std::{
    sync::atomic::{AtomicU8, Ordering},
    time::Duration,
};

use crate::{error::WorkerResult, ext::run_tool, proto::mentro::worker::v1::EErrorCode};

pub struct ContainerSpec {
    /// Tag used in log lines ("[whisper] ...").
    pub log_tag: &'static str,
    /// Container name to own.
    pub name: &'static str,
    /// Image to create from when nothing exists.
    pub image: &'static str,
    /// Host port for the 127.0.0.1 binding (container listens on
    /// `container_port`).
    pub host_port: u16,
    pub container_port: u16,
    /// Env var that, when set to a URL, bypasses container management
    /// entirely (compose: point it at the service).
    pub url_env: &'static str,
    /// Env var that disables the backend ("off").
    pub off_env: &'static str,
    /// Extra `docker run -e KEY=VALUE` assignments (model config etc.).
    pub extra_env: &'static [(&'static str, &'static str)],
    /// Health-check path under the service root.
    pub health_path: &'static str,
    /// Seconds to wait for the health endpoint (model download/first
    /// boot can be slow).
    pub health_timeout_sec: u64,
}

/// 0 = idle, 1 = ready, 2 = unavailable. One static per sidecar.
pub struct Guard {
    state: AtomicU8,
    warned: AtomicU8,
}

impl Guard {
    pub const fn new() -> Self {
        Self {
            state: AtomicU8::new(0),
            warned: AtomicU8::new(0),
        }
    }
}

/// Ensure the container is up; returns the base URL or None.
/// `None` means "unavailable, degrade gracefully" — never an error.
pub fn ensure(spec: &ContainerSpec, guard: &Guard) -> Option<String> {
    if let Ok(url) = std::env::var(spec.url_env)
        && !url.is_empty()
    {
        return Some(url.trim_end_matches('/').to_string());
    }
    if std::env::var(spec.off_env)
        .map(|v| v == "off")
        .unwrap_or(false)
    {
        warn_once(spec, guard, "disabled via env");
        return None;
    }
    match guard.state.load(Ordering::Relaxed) {
        1 => return Some(format!("http://127.0.0.1:{}", spec.host_port)),
        2 => return None,
        _ => {}
    }

    let ps = run_tool(
        "docker",
        &[
            "ps",
            "--filter",
            &format!("name={}", spec.name),
            "--format",
            "{{.Names}}",
        ],
        Duration::from_secs(10),
    );
    let running = matches!(&ps, Ok(out) if out.contains(spec.name));
    if !running {
        if let Err(e) = &ps
            && e.code == EErrorCode::ToolMissing
        {
            warn_once(spec, guard, "no container runtime found");
            return None;
        }
        let _ = run_tool("docker", &["start", spec.name], Duration::from_secs(30));
        let ps2 = run_tool(
            "docker",
            &[
                "ps",
                "--filter",
                &format!("name={}", spec.name),
                "--format",
                "{{.Names}}",
            ],
            Duration::from_secs(10),
        );
        if !matches!(&ps2, Ok(out) if out.contains(spec.name)) {
            let port_map = format!("127.0.0.1:{}:{}", spec.host_port, spec.container_port);
            eprintln!(
                "[{}] creating container (image {})",
                spec.log_tag, spec.image
            );
            let mut args: Vec<String> = vec![
                "run".into(),
                "-d".into(),
                "--name".into(),
                spec.name.into(),
                "-p".into(),
                port_map,
            ];
            for (key, value) in spec.extra_env {
                args.push("-e".into());
                args.push(format!("{key}={value}"));
            }
            args.push(spec.image.into());
            let created = run_tool(
                "docker",
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
                Duration::from_secs(900),
            );
            if let Err(e) = created {
                // The container may exist but have exited after the start
                // probe above (crash/OOM loop): one more start attempt
                // before giving up, so the guard self-heals.
                let _ = run_tool("docker", &["start", spec.name], Duration::from_secs(60));
                let ps3 = run_tool(
                    "docker",
                    &[
                        "ps",
                        "--filter",
                        &format!("name={}", spec.name),
                        "--format",
                        "{{.Names}}",
                    ],
                    Duration::from_secs(10),
                );
                if !matches!(&ps3, Ok(out) if out.contains(spec.name)) {
                    warn_once(spec, guard, &format!("failed to start container: {e}"));
                    return None;
                }
            }
        }
    }

    let base = format!("http://127.0.0.1:{}", spec.host_port);
    let polls = (spec.health_timeout_sec / 2).max(1);
    for _ in 0..polls {
        if let Ok(resp) = ureq::get(&format!("{base}{}", spec.health_path))
            .timeout(Duration::from_secs(2))
            .call()
            && resp.status() >= 200
            && resp.status() < 300
        {
            guard.state.store(1, Ordering::Relaxed);
            return Some(base);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    warn_once(
        spec,
        guard,
        &format!(
            "container did not become healthy in {}s",
            spec.health_timeout_sec
        ),
    );
    guard.state.store(2, Ordering::Relaxed);
    None
}

fn warn_once(spec: &ContainerSpec, guard: &Guard, msg: &str) {
    if guard.warned.swap(1, Ordering::Relaxed) == 0 {
        eprintln!(
            "[{}] {msg} — feature degraded for this session",
            spec.log_tag
        );
    }
    guard.state.store(2, Ordering::Relaxed);
}

/// POST multipart/form-data with a single file field; returns the JSON
/// response body. Errors degrade to Ok(None) when the backend is down.
pub fn post_file_multipart(
    url: &str,
    field: &str,
    file_name: &str,
    bytes: &[u8],
    timeout: Duration,
) -> WorkerResult<Option<serde_json::Value>> {
    let boundary = "mentro-sidecar-boundary-3d8f1a6b";
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{field}\"; filename=\"{file_name}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let resp = match ureq::post(url)
        .timeout(timeout)
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&body)
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[sidecar] request failed: {e}");
            return Ok(None);
        }
    };
    match resp.into_json() {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            eprintln!("[sidecar] response decode failed: {e}");
            Ok(None)
        }
    }
}
