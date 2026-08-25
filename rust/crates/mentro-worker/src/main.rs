mod proto;
mod shell;

use clap::{Parser, Subcommand};
use shell::Shell;

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

    #[arg(short = 'v', long, action = clap::ArgAction::Count, global = true)]
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
    /// Walk a root; JSON file records to stdout.
    Scan { root: std::path::PathBuf },
    /// Probe external tools; JSON availability to stdout.
    Doctor,
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
        Command::Doctor => doctor(&shell),
        Command::Serve => todo_m1(&shell, "serve"),
        Command::Extract { .. } => todo_m1(&shell, "extract"),
        Command::Scan { .. } => todo_m1(&shell, "scan"),
        Command::Ocr { .. } => todo_m1(&shell, "ocr"),
    };
    std::process::exit(code);
}

fn todo_m1(shell: &Shell, cmd: &str) -> i32 {
    shell.warn(&format!("`{cmd}` lands in M1 — not implemented yet"));
    EXIT_FAILURE
}

/// Probe external tools with their version probes; report JSON to stdout.
fn doctor(shell: &Shell) -> i32 {
    shell.status("Checking external tools");
    let probes: &[(&str, &str, &str)] = &[
        ("poppler.pdftotext", "pdftotext", "-v"),
        ("poppler.pdftoppm", "pdftoppm", "-v"),
        ("poppler.pdfinfo", "pdfinfo", "-v"),
        ("ffmpeg", "ffmpeg", "-version"),
        ("ffprobe", "ffprobe", "-version"),
        ("container.docker", "docker", "--version"),
    ];

    let mut tools = serde_json::Map::new();
    for (name, program, arg) in probes {
        let value = match std::process::Command::new(program).arg(arg).output() {
            Ok(out) => {
                let text = String::from_utf8_lossy(if out.stdout.is_empty() {
                    &out.stderr
                } else {
                    &out.stdout
                });
                let first_line = text.lines().next().unwrap_or_default().trim();
                if out.status.success() || !first_line.is_empty() {
                    first_line.to_string()
                } else {
                    "absent".to_string()
                }
            }
            Err(_) => "absent".to_string(),
        };
        tools.insert((*name).to_string(), serde_json::Value::String(value));
    }

    let report = serde_json::json!({
        "protocol": 1,
        "tools": tools,
    });
    shell.result(&report);
    0
}
