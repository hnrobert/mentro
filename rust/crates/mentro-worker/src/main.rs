mod embed;
mod error;
mod export;
mod ext;
mod extract;
mod kind;
mod ocr;
mod proto;
mod scan;
mod serve;
mod shell;
mod tools;
mod transcribe;
mod unpack;
mod watch;

use clap::{Parser, Subcommand};
use shell::Shell;

use crate::proto::mentro::worker::v1::{CMsgContentUnit, CMsgFileRecord, EAssetKind};

/// Exit codes: 0 ok, 1 usage error, 101 internal failure, 130 interrupted.
const EXIT_FAILURE: i32 = 101;

#[derive(Parser)]
#[command(
    name = "mentro-worker",
    version,
    about = "Mentro extraction worker: standalone CLI + protobuf serve mode"
)]
struct Cli {
    #[arg(long, global = true, value_enum, default_value_t = ColorChoice::Auto)]
    color: ColorChoice,

    #[arg(short = 'v', long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    #[arg(short = 'q', long, global = true, conflicts_with = "verbose")]
    quiet: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(clap::ValueEnum, Clone, Copy)]
enum ColorChoice {
    Auto,
    Always,
    Never,
}

#[derive(Subcommand)]
enum Command {
    /// Protobuf length-delimited frame loop on stdio (spawned by mentro-server).
    Serve,
    /// Extract a single file; JSON result to stdout.
    Extract { path: std::path::PathBuf },
    /// Walk a root; JSON file records to stdout (one per line).
    Scan { root: std::path::PathBuf },
    /// Probe external tools; JSON availability to stdout.
    Doctor,
    /// Unpack an archive into a directory; JSON summary to stdout.
    Unpack {
        path: std::path::PathBuf,
        /// Output directory (created if missing).
        #[arg(short, long)]
        out: std::path::PathBuf,
    },
    /// OCR a single image; JSON result to stdout.
    Ocr { path: std::path::PathBuf },
    /// Transcribe an audio/video file; JSON segments to stdout.
    Transcribe { path: std::path::PathBuf },
    /// Embed texts (one per stdin line); JSON vectors to stdout.
    Embed,
    /// Compose a document from selected units; JSON artifact path to
    /// stdout. UNITS are `path:ordinal` (1-based page/slide).
    Export {
        #[arg(short, long)]
        format: String,
        /// Output file (under MENTRO_DATA/exports when relative).
        #[arg(short, long)]
        out: String,
        units: Vec<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    let shell = Shell {
        verbose: cli.verbose,
        quiet: cli.quiet,
    };

    let code = match cli.command {
        Command::Serve => serve::run(),
        Command::Doctor => doctor(&shell),
        Command::Scan { root } => scan_cli(&shell, &root),
        Command::Extract { path } => extract_cli(&shell, &path),
        Command::Unpack { path, out } => unpack_cli(&shell, &path, &out),
        Command::Ocr { .. } => todo_later(&shell, "ocr", "M5"),
        Command::Transcribe { path } => transcribe_cli(&shell, &path),
        Command::Embed => embed_cli(&shell),
        Command::Export { format, out, units } => export_cli(&shell, &format, &out, &units),
    };
    std::process::exit(code);
}

fn todo_later(shell: &Shell, cmd: &str, milestone: &str) -> i32 {
    shell.warn(&format!("`{cmd}` lands in {milestone}"));
    EXIT_FAILURE
}

fn unpack_cli(shell: &Shell, path: &std::path::Path, out: &std::path::Path) -> i32 {
    let req = proto::mentro::worker::v1::UnpackRequest {
        path: path.to_string_lossy().to_string(),
        dest_dir: out.to_string_lossy().to_string(),
        max_entries: 0,
        max_bytes: 0,
    };
    match unpack::unpack(&req) {
        Ok(result) => {
            shell.status(&format!(
                "Unpacked {} file(s), {} skipped",
                result.file_paths.len(),
                result.skipped_entries
            ));
            shell.result(&serde_json::json!({
                "files": result.file_paths,
                "totalBytes": result.total_bytes,
                "skippedEntries": result.skipped_entries,
            }));
            0
        }
        Err(e) => {
            shell.warn(&format!("unpack failed: {e}"));
            EXIT_FAILURE
        }
    }
}

fn doctor(shell: &Shell) -> i32 {
    shell.status("Checking external tools");
    let tools = tools::probe_all();
    shell.result(&serde_json::json!({ "protocol": 1, "tools": tools }));
    0
}

fn record_json(record: &CMsgFileRecord) -> serde_json::Value {
    let kind = EAssetKind::try_from(record.kind)
        .map(|k| format!("{k:?}"))
        .unwrap_or_else(|_| "Unspecified".to_string());
    serde_json::json!({
        "path": record.path,
        "sizeBytes": record.size_bytes,
        "mtimeMs": record.mtime_ms,
        "mime": record.mime,
        "kind": kind,
        "oversized": record.oversized,
        "contentHash": record.content_hash,
    })
}

fn scan_cli(shell: &Shell, root: &std::path::Path) -> i32 {
    match scan::scan_root(root) {
        Ok(records) => {
            shell.status(&format!("Scanned {} file(s)", records.len()));
            for record in &records {
                println!("{}", record_json(record));
            }
            0
        }
        Err(e) => {
            shell.warn(&format!("scan failed: {e}"));
            EXIT_FAILURE
        }
    }
}

fn unit_json(unit: &CMsgContentUnit) -> serde_json::Value {
    serde_json::json!({
        "ordinal": unit.ordinal,
        "unitType": unit.unit_type,
        "title": unit.title,
        "text": unit.text,
        "startMs": unit.start_ms,
        "endMs": unit.end_ms,
    })
}

fn extract_cli(shell: &Shell, path: &std::path::Path) -> i32 {
    let mime = infer::get_from_path(path)
        .ok()
        .flatten()
        .map(|t| t.mime_type().to_string());
    let req = proto::mentro::worker::v1::ExtractRequest {
        asset_id: String::new(),
        path: path.to_string_lossy().to_string(),
        content_hash: String::new(),
        kind: kind::classify(mime.as_deref(), path) as i32,
        want: Vec::new(),
        options: None,
    };
    match extract::extract(&req) {
        Ok(result) => {
            shell.status(&format!("Extracted {} unit(s)", result.units.len()));
            let units: Vec<_> = result.units.iter().map(unit_json).collect();
            shell.result(&serde_json::json!({
                "assetId": result.asset_id,
                "contentHash": result.content_hash,
                "units": units,
            }));
            0
        }
        Err(e) => {
            shell.warn(&format!("extract failed: {e}"));
            EXIT_FAILURE
        }
    }
}

fn transcribe_cli(shell: &Shell, path: &std::path::Path) -> i32 {
    let req = proto::mentro::worker::v1::TranscribeRequest {
        asset_id: String::new(),
        path: path.to_string_lossy().to_string(),
        content_hash: String::new(),
    };
    match transcribe::transcribe(&req) {
        Ok(result) => {
            shell.status(&format!("Transcribed {} segment(s)", result.segments.len()));
            let segments: Vec<_> = result
                .segments
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "startMs": s.start_ms,
                        "endMs": s.end_ms,
                        "text": s.text,
                    })
                })
                .collect();
            shell.result(&serde_json::json!({ "segments": segments }));
            0
        }
        Err(e) => {
            shell.warn(&format!("transcribe failed: {e}"));
            EXIT_FAILURE
        }
    }
}

fn embed_cli(shell: &Shell) -> i32 {
    use std::io::BufRead;
    let texts: Vec<String> = std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .collect();
    let req = proto::mentro::worker::v1::EmbedRequest { texts };
    match embed::embed(&req) {
        Ok(result) => {
            shell.status(&format!("Embedded {} text(s)", result.embeddings.len()));
            let vectors: Vec<_> = result
                .embeddings
                .iter()
                .map(|e| serde_json::json!({ "dim": e.vector.len() }))
                .collect();
            shell.result(&serde_json::json!({ "embeddings": vectors }));
            0
        }
        Err(e) => {
            shell.warn(&format!("embed failed: {e}"));
            EXIT_FAILURE
        }
    }
}

fn export_cli(shell: &Shell, format: &str, out: &str, units: &[String]) -> i32 {
    let format = match format.to_ascii_lowercase().as_str() {
        "pdf" => proto::mentro::worker::v1::EExportFormat::Pdf as i32,
        "pptx" => proto::mentro::worker::v1::EExportFormat::Pptx as i32,
        other => {
            shell.warn(&format!("unknown format `{other}` (pdf | pptx)"));
            return 1;
        }
    };
    let mut parsed = Vec::new();
    for unit in units {
        let Some((path, ordinal)) = unit.rsplit_once(':') else {
            shell.warn(&format!("unit `{unit}` must be path:ordinal"));
            return 1;
        };
        let Ok(ordinal) = ordinal.parse::<i32>() else {
            shell.warn(&format!("unit `{unit}` ordinal is not a number"));
            return 1;
        };
        parsed.push(proto::mentro::worker::v1::CMsgUnitRef {
            asset_id: String::new(),
            ordinal,
            path: path.to_string(),
        });
    }
    let req = proto::mentro::worker::v1::ExportRequest {
        units: parsed,
        format,
        name_hint: out
            .trim_end_matches(".pdf")
            .trim_end_matches(".pptx")
            .to_string(),
    };
    match export::export(&req) {
        Ok(result) => {
            shell.status(&format!("Exported to {}", result.path));
            shell.result(&serde_json::json!({ "path": result.path }));
            0
        }
        Err(e) => {
            shell.warn(&format!("export failed: {e}"));
            EXIT_FAILURE
        }
    }
}
