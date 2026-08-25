//! External tool probing, shared by `doctor` and the serve handshake.

use std::collections::BTreeMap;

/// (logical name, program, version arg)
pub const PROBES: &[(&str, &str, &str)] = &[
    ("poppler.pdftotext", "pdftotext", "-v"),
    ("poppler.pdftoppm", "pdftoppm", "-v"),
    ("poppler.pdfinfo", "pdfinfo", "-v"),
    ("ffmpeg", "ffmpeg", "-version"),
    ("ffprobe", "ffprobe", "-version"),
    ("container.docker", "docker", "--version"),
    ("archive.7zz", "7zz", "i"),
    ("archive.unar", "unar", ""),
];

pub fn probe_all() -> BTreeMap<String, String> {
    let mut tools = BTreeMap::new();
    for (name, program, arg) in PROBES {
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
        tools.insert((*name).to_string(), value);
    }
    tools
}
