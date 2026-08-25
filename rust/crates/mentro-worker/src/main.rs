mod error;
mod ext;
mod extract;
mod kind;
mod proto;
mod scan;
mod serve;
mod shell;
mod tools;
mod unpack;

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
