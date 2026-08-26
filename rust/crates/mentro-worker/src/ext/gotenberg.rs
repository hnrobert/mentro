//! Gotenberg office-rendering container client: convert Office documents
//! to PDF over HTTP (`POST /forms/libreoffice/convert`). Container is
//! lazily ensured by §7.6 rules (probe → start → create → health).

use std::{path::Path, time::Duration};

use crate::{
    error::{WorkerError, WorkerResult},
    ext::run_tool,
    proto::mentro::worker::v1::EErrorCode,
};

const CONTAINER_NAME: &str = "mentro-office";
// Ready-made LibreOffice-only variant of the official Gotenberg image.
const DEFAULT_IMAGE: &str = "gotenberg/gotenberg:8.32.0-libreoffice";
const HOST_PORT: u16 = 9400;

/// 0 = idle, 1 = ready, 2 = unavailable.
static STATE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
static WARNED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn image() -> String {
    std::env::var("MENTRO_OFFICE_IMAGE").unwrap_or_else(|_| DEFAULT_IMAGE.to_string())
}

fn port() -> u16 {
    std::env::var("MENTRO_OFFICE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(HOST_PORT)
}

fn warn_once(msg: &str) {
    if WARNED.swap(1, std::sync::atomic::Ordering::Relaxed) == 0 {
        eprintln!("[office] {msg} — Office rendering disabled for this session");
    }
}

/// Ensure the container is up; returns the base URL or None.
pub fn ensure() -> Option<String> {
    use std::sync::atomic::Ordering;
    match STATE.load(Ordering::Relaxed) {
        1 => return Some(format!("http://127.0.0.1:{}", port())),
        2 => return None,
        _ => {}
    }

    let ps = run_tool(
        "docker",
        &[
            "ps",
            "--filter",
            &format!("name={CONTAINER_NAME}"),
            "--format",
            "{{.Names}}",
        ],
        Duration::from_secs(10),
    );
    let running = matches!(&ps, Ok(out) if out.contains(CONTAINER_NAME));
    if !running {
        if let Err(e) = &ps
            && e.code == EErrorCode::ToolMissing
        {
            warn_once("no container runtime found");
            STATE.store(2, Ordering::Relaxed);
            return None;
        }
        let _ = run_tool(
            "docker",
            &["start", CONTAINER_NAME],
            Duration::from_secs(30),
        );
        let ps2 = run_tool(
            "docker",
            &[
                "ps",
                "--filter",
                &format!("name={CONTAINER_NAME}"),
                "--format",
                "{{.Names}}",
            ],
            Duration::from_secs(10),
        );
        if !matches!(&ps2, Ok(out) if out.contains(CONTAINER_NAME)) {
            let port_map = format!("127.0.0.1:{}:3000", port());
            eprintln!("[office] creating container (image {})", image());
            let created = run_tool(
                "docker",
                &[
                    "run",
                    "-d",
                    "--name",
                    CONTAINER_NAME,
                    "-p",
                    &port_map,
                    &image(),
                ],
                Duration::from_secs(900),
            );
            if let Err(e) = created {
                warn_once(&format!("failed to start office container: {e}"));
                STATE.store(2, Ordering::Relaxed);
                return None;
            }
        }
    }

    // Health poll (up to 120s).
    let base = format!("http://127.0.0.1:{}", port());
    for _ in 0..60 {
        if let Ok(resp) = ureq::get(&format!("{base}/health"))
            .timeout(Duration::from_secs(2))
            .call()
            && resp.status() >= 200
            && resp.status() < 300
        {
            STATE.store(1, Ordering::Relaxed);
            return Some(base);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    warn_once("office container did not become healthy in 120s");
    STATE.store(2, Ordering::Relaxed);
    None
}

/// Convert an Office document to PDF; returns the PDF bytes.
pub fn convert_to_pdf(path: &Path) -> WorkerResult<Vec<u8>> {
    let Some(base) = ensure() else {
        return Err(WorkerError::new(
            EErrorCode::ToolMissing,
            "office rendering container unavailable",
            false,
        ));
    };
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());
    let bytes = std::fs::read(path)
        .map_err(|e| WorkerError::invalid(format!("read {}: {e}", path.display())))?;

    // multipart/form-data: "files" field + "timeout" field (Gotenberg's
    // default 30s kills large-deck conversions).
    let boundary = "mentro-office-boundary-7f3a9c2d";
    let timeout_sec: u32 = std::env::var("MENTRO_OFFICE_TIMEOUT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(240);
    let body: Vec<u8> = {
        let mut b = Vec::new();
        b.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        b.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"files\"; filename=\"{file_name}\"\r\n")
                .as_bytes(),
        );
        b.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        b.extend_from_slice(&bytes);
        b.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
        b.extend_from_slice(b"Content-Disposition: form-data; name=\"timeout\"\r\n\r\n");
        b.extend_from_slice(format!("{timeout_sec}s").as_bytes());
        b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        b
    };

    let resp = ureq::post(&format!("{base}/forms/libreoffice/convert"))
        .timeout(Duration::from_secs(300))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&body)
        .map_err(|e| WorkerError::new(EErrorCode::ToolTimeout, format!("gotenberg: {e}"), true))?;
    if resp.status() >= 400 {
        return Err(WorkerError::new(
            EErrorCode::ToolNonZeroExit,
            format!("gotenberg returned {}", resp.status()),
            true,
        ));
    }
    let mut pdf = Vec::new();
    use std::io::Read;
    resp.into_reader()
        .take(128 * 1024 * 1024)
        .read_to_end(&mut pdf)
        .map_err(|e| {
            WorkerError::new(
                EErrorCode::ToolTimeout,
                format!("gotenberg body: {e}"),
                true,
            )
        })?;
    Ok(pdf)
}
