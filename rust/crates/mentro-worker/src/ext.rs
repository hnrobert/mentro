//! Subprocess wrapper for external tools (poppler, ffmpeg, ...).
//!
//! Contract: bounded output capture (16 MB), hard timeout with kill,
//! typed error mapping. Stdout is returned as lossy UTF-8.

pub mod container;
pub mod gotenberg;

use std::{
    io::Read,
    process::{Command, Stdio},
    time::Duration,
};

use wait_timeout::ChildExt;

use crate::{
    error::{WorkerError, WorkerResult},
    proto::mentro::worker::v1::EErrorCode,
};

const OUTPUT_CAP: u64 = 16 * 1024 * 1024;

fn read_capped(mut reader: impl Read) -> String {
    let mut buf = String::new();
    let mut limited = (&mut reader).take(OUTPUT_CAP);
    let _ = limited.read_to_string(&mut buf);
    buf
}

/// Run an external tool, returning its stdout.
pub fn run_tool(program: &str, args: &[&str], timeout: Duration) -> WorkerResult<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WorkerError::new(
                    EErrorCode::ToolMissing,
                    format!("`{program}` not found on PATH"),
                    false,
                )
            } else {
                WorkerError::internal(format!("spawn `{program}`: {e}"))
            }
        })?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let out_handle = std::thread::spawn(move || read_capped(stdout));
    let err_handle = std::thread::spawn(move || read_capped(stderr));

    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            let out = out_handle.join().unwrap_or_default();
            let err = err_handle.join().unwrap_or_default();
            if status.success() {
                Ok(out)
            } else {
                Err(WorkerError::new(
                    EErrorCode::ToolNonZeroExit,
                    format!(
                        "`{program}` exited with {status}: {}",
                        err.lines().take(3).collect::<Vec<_>>().join(" | ")
                    ),
                    true,
                ))
            }
        }
        Ok(None) => {
            // Timed out: kill and reap, then report.
            let _ = child.kill();
            let _ = child.wait();
            Err(WorkerError::new(
                EErrorCode::ToolTimeout,
                format!("`{program}` exceeded {:?}", timeout),
                true,
            ))
        }
        Err(e) => Err(WorkerError::internal(format!("wait `{program}`: {e}"))),
    }
}
