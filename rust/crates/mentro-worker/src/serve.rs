//! Protobuf serve mode: length-delimited WorkerFrame loop on stdio.
//! Requests are processed sequentially (server-side concurrency is
//! achieved by running a pool of worker processes — one worker stays
//! single-threaded and deadlock-free). stdout carries frames only.

use std::{
    collections::HashMap,
    io::{self, Read, Write},
    path::Path,
    sync::Mutex,
};

use prost::Message;

use crate::{
    embed,
    error::{WorkerError, WorkerResult},
    export, extract,
    proto::mentro::worker::v1::{
        ECapability, ErrorInfo, ReadyMessage, Request, Response, ScanResult, WorkerFrame,
        request::Body as ReqBody, response, worker_frame::Body,
    },
    scan, tools, transcribe, unpack, watch,
};

static WATCH_HUB: once_cell::sync::Lazy<Mutex<watch::WatchHub>> =
    once_cell::sync::Lazy::new(|| Mutex::new(watch::WatchHub::new()));

/// Hard frame cap: 32 MB.
const FRAME_CAP: usize = 32 * 1024 * 1024;

fn read_varint(reader: &mut impl Read) -> io::Result<u64> {
    let mut value: u64 = 0;
    for shift in (0..64).step_by(7) {
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)?;
        value |= u64::from(byte[0] & 0x7f) << shift;
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "varint overflow",
    ))
}

fn read_frame(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let len = read_varint(reader)? as usize;
    if len > FRAME_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame {len} bytes exceeds cap {FRAME_CAP}"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    let mut len = bytes.len() as u64;
    loop {
        let mut byte = (len & 0x7f) as u8;
        len >>= 7;
        if len != 0 {
            byte |= 0x80;
        }
        writer.write_all(&[byte])?;
        if len == 0 {
            break;
        }
    }
    writer.write_all(bytes)?;
    writer.flush()
}

fn handle(req: Request) -> WorkerResult<response::Result> {
    match req.body {
        Some(ReqBody::Scan(r)) => {
            let records = scan::scan_root(Path::new(&r.root))?;
            Ok(response::Result::ScanResult(ScanResult { records }))
        }
        Some(ReqBody::Extract(r)) => {
            let result = extract::extract(&r)?;
            Ok(response::Result::ExtractResult(result))
        }
        Some(ReqBody::Unpack(r)) => {
            let result = unpack::unpack(&r)?;
            Ok(response::Result::UnpackResult(result))
        }
        Some(ReqBody::Export(r)) => {
            let result = export::export(&r)?;
            Ok(response::Result::ExportResult(result))
        }
        Some(ReqBody::Transcribe(r)) => {
            let result = transcribe::transcribe(&r)?;
            Ok(response::Result::TranscribeResult(result))
        }
        Some(ReqBody::Embed(r)) => {
            let result = embed::embed(&r)?;
            Ok(response::Result::EmbedResult(result))
        }
        Some(ReqBody::Stat(r)) => {
            let stats: Vec<_> = r
                .paths
                .iter()
                .map(|p| {
                    let md = std::fs::metadata(p);
                    crate::proto::mentro::worker::v1::CMsgFileStat {
                        path: p.clone(),
                        exists: md.is_ok(),
                        size_bytes: md.as_ref().map(|m| m.len() as i64).unwrap_or(0),
                        mtime_ms: md
                            .as_ref()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0),
                    }
                })
                .collect();
            Ok(response::Result::StatResult(
                crate::proto::mentro::worker::v1::StatResult { stats },
            ))
        }
        Some(ReqBody::Watch(r)) => {
            WATCH_HUB
                .lock()
                .map_err(|e| WorkerError::internal(e.to_string()))?
                .watch(&r.source_id, &r.root)
                .map_err(WorkerError::internal)?;
            Ok(response::Result::StatResult(
                crate::proto::mentro::worker::v1::StatResult { stats: vec![] },
            ))
        }
        Some(ReqBody::Unwatch(r)) => {
            if let Ok(mut hub) = WATCH_HUB.lock() {
                hub.unwatch(&r.source_id);
            }
            Ok(response::Result::StatResult(
                crate::proto::mentro::worker::v1::StatResult { stats: vec![] },
            ))
        }
        Some(other) => Err(WorkerError::unsupported(format!(
            "{other:?} lands in a later milestone"
        ))),
        None => Err(WorkerError::invalid("request without body")),
    }
}

fn respond(req: Request) -> WorkerFrame {
    let id = req.id.clone();
    let outcome = handle(req);
    let response = match outcome {
        Ok(result) => Response {
            id,
            ok: true,
            error: None,
            result: Some(result),
        },
        Err(e) => Response {
            id,
            ok: false,
            error: Some(ErrorInfo {
                code: e.code as i32,
                message: e.message,
                retryable: e.retryable,
            }),
            result: None,
        },
    };
    WorkerFrame {
        body: Some(Body::Response(response)),
    }
}

fn encode_frame(frame: WorkerFrame) -> Vec<u8> {
    let mut bytes = Vec::new();
    frame
        .encode(&mut bytes)
        .expect("encoding into a Vec never fails");
    bytes
}

/// Serve loop. Returns the process exit code.
pub fn run() -> i32 {
    let tools: HashMap<String, String> = tools::probe_all().into_iter().collect();
    let ready = ReadyMessage {
        protocol: 1,
        capabilities: vec![
            ECapability::Scan as i32,
            ECapability::Watch as i32,
            ECapability::ExtractText as i32,
            ECapability::ExtractPdf as i32,
            ECapability::ExtractOffice as i32,
            ECapability::ExtractImage as i32,
            ECapability::ExtractMedia as i32,
            ECapability::Render as i32,
            ECapability::Unpack as i32,
            ECapability::Export as i32,
            ECapability::Transcribe as i32,
            ECapability::Embed as i32,
        ],
        tools,
    };
    {
        let mut out = io::stdout().lock();
        if write_frame(
            &mut out,
            &encode_frame(WorkerFrame {
                body: Some(Body::Ready(ready)),
            }),
        )
        .is_err()
        {
            eprintln!("[worker] handshake write failed");
            return 101;
        }
    }

    loop {
        let bytes = match read_frame(&mut io::stdin().lock()) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                eprintln!("[worker] frame read failed: {e}");
                return 101;
            }
        };

        let frame = match WorkerFrame::decode(bytes.as_slice()) {
            Ok(frame) => frame,
            Err(e) => {
                eprintln!("[worker] undecodable frame ({} bytes): {e}", bytes.len());
                continue;
            }
        };

        let Some(Body::Request(req)) = frame.body else {
            eprintln!("[worker] ignoring non-request frame");
            continue;
        };

        let out_frame = respond(req);
        let mut out = io::stdout().lock();
        if let Err(e) = write_frame(&mut out, &encode_frame(out_frame)) {
            eprintln!("[worker] frame write failed: {e}");
            return 101;
        }
        drop(out);

        // Drain pending fs events after each request. This is a natural
        // tick point; with read blocking, events accumulate between reads.
        let fs_events = WATCH_HUB
            .lock()
            .map(|mut hub| hub.drain())
            .unwrap_or_default();
        if !fs_events.is_empty() {
            let mut out = io::stdout().lock();
            for ev in fs_events {
                let frame = WorkerFrame {
                    body: Some(Body::Fs(ev)),
                };
                if let Err(e) = write_frame(&mut out, &encode_frame(frame)) {
                    eprintln!("[worker] fs event write failed: {e}");
                    break;
                }
            }
        }
    }

    0
}
