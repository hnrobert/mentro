//! Protobuf serve mode: length-delimited WorkerFrame loop on stdio.
//! Requests are processed sequentially (server-side concurrency is
//! achieved by running a pool of worker processes — one worker stays
//! single-threaded and deadlock-free). stdout carries frames only.

use std::{
    collections::HashMap,
    io::{self, Read, Write},
    path::Path,
};

use prost::Message;

use crate::{
    error::{WorkerError, WorkerResult},
    extract,
    proto::mentro::worker::v1::{
        ECapability, ErrorInfo, ReadyMessage, Request, Response, ScanResult, WorkerFrame,
        request::Body as ReqBody, response, worker_frame::Body,
    },
    scan, tools, unpack,
};

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
            ECapability::ExtractText as i32,
            ECapability::ExtractPdf as i32,
            ECapability::Unpack as i32,
        ],
        tools,
    };
    {
        let mut out = io::stdout().lock();
        if write_frame(&mut out, &encode_frame(WorkerFrame {
            body: Some(Body::Ready(ready)),
        }))
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
    }

    0
}
