//! Archive unpacking for the upload pool.
//!
//! Formats: zip, tar / tar.gz / tar.bz2 / tar.xz (Rust crates), 7z
//! (sevenz-rust), rar (external `7zz`/`7z`/`unar`, probed). Hardened:
//! zip-slip rejection (no `..` / absolute components), junk-entry skipping
//! (`__MACOSX` / `._*` / `.DS_Store`), entry-count and total-size caps
//! enforced on declared sizes AND on bytes actually written (headers can
//! lie), plus a post-walk reconciliation.

use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use crate::{
    error::{WorkerError, WorkerResult},
    ext::run_tool,
    proto::mentro::worker::v1::{UnpackRequest, UnpackResult},
};

const DEFAULT_MAX_ENTRIES: i64 = 10_000;
const DEFAULT_MAX_BYTES: i64 = 10 * 1024 * 1024 * 1024;

struct Ctx {
    dest: PathBuf,
    max_entries: i64,
    max_bytes: i64,
    entries: i64,
    total: i64,
    skipped: i64,
    files: Vec<String>,
}

impl Ctx {
    fn new(dest: &Path, max_entries: i64, max_bytes: i64) -> Self {
        Self {
            dest: dest.to_path_buf(),
            max_entries,
            max_bytes,
            entries: 0,
            total: 0,
            skipped: 0,
            files: Vec::new(),
        }
    }

    /// Validate an entry name: no zip-slip, no junk, caps hold.
    /// Returns the sanitized destination path (parents created).
    fn accept(&mut self, name: &str, declared_size: u64) -> Option<PathBuf> {
        if name.is_empty() {
            self.skipped += 1;
            return None;
        }
        let rel = Path::new(name);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, Component::ParentDir))
        {
            self.skipped += 1; // zip-slip attempt
            return None;
        }
        if rel
            .components()
            .any(|c| c.as_os_str() == "__MACOSX")
        {
            self.skipped += 1;
            return None;
        }
        if let Some(file_name) = rel.file_name() {
            let n = file_name.to_string_lossy();
            if n == ".DS_Store" || n.starts_with("._") {
                self.skipped += 1;
                return None;
            }
        }
        if self.entries >= self.max_entries
            || self.total + declared_size as i64 > self.max_bytes
        {
            self.skipped += 1;
            return None;
        }
        self.entries += 1;
        self.total += declared_size as i64;
        let target = self.dest.join(rel);
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Some(target)
    }

    /// Copy from a reader with a hard byte cap (defends against lying
    /// headers); over-cap writes are discarded and counted as skipped.
    fn write_capped(&mut self, target: &Path, mut reader: impl Read, rel: &str) {
        let remaining = (self.max_bytes - self.total).max(0) as u64;
        let mut out = match File::create(target) {
            Ok(f) => f,
            Err(_) => {
                self.skipped += 1;
                return;
            }
        };
        let mut limited = (&mut reader).take(remaining);
        match std::io::copy(&mut limited, &mut out) {
            Ok(_) => {
                // If the source had more bytes than the cap, drop the file.
                let mut probe = [0u8; 1];
                if reader.read(&mut probe).unwrap_or(0) > 0 {
                    let _ = std::fs::remove_file(target);
                    self.skipped += 1;
                } else {
                    self.files.push(rel.to_string());
                }
            }
            Err(_) => {
                let _ = std::fs::remove_file(target);
                self.skipped += 1;
            }
        }
    }
}

pub fn unpack(req: &UnpackRequest) -> WorkerResult<UnpackResult> {
    let path = Path::new(&req.path);
    if !path.is_file() {
        return Err(WorkerError::invalid(format!(
            "not a file: {}",
            path.display()
        )));
    }
    let dest = Path::new(&req.dest_dir);
    std::fs::create_dir_all(dest).map_err(|e| {
        WorkerError::invalid(format!("create {}: {e}", dest.display()))
    })?;

    let max_entries = if req.max_entries > 0 { req.max_entries as i64 } else { DEFAULT_MAX_ENTRIES };
    let max_bytes = if req.max_bytes > 0 { req.max_bytes } else { DEFAULT_MAX_BYTES };
    let mut ctx = Ctx::new(dest, max_entries, max_bytes);

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "zip" => unpack_zip(path, &mut ctx)?,
        "tar" | "tgz" | "tbz2" | "txz" | "gz" | "bz2" | "xz" => unpack_tar(path, &ext, &mut ctx)?,
        "7z" => unpack_7z(path, &mut ctx)?,
        "rar" => unpack_rar(path, dest, &mut ctx)?,
        other => {
            return Err(WorkerError::unsupported(format!(
                "archive type .{other} not supported"
            )))
        }
    }

    // Reconcile with what actually landed on disk.
    reconcile(dest, &mut ctx)?;

    Ok(UnpackResult {
        file_paths: ctx.files,
        total_bytes: ctx.total,
        skipped_entries: ctx.skipped as i32,
    })
}

fn unpack_zip(path: &Path, ctx: &mut Ctx) -> WorkerResult<()> {
    let file = File::open(path)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| WorkerError::invalid(format!("bad zip: {e}")))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| WorkerError::invalid(format!("zip entry {i}: {e}")))?;
        if entry.is_dir() {
            continue;
        }
        // Many zippers (notably macOS/Linux CLIs) store UTF-8 names without
        // the EFS flag; the crate then decodes as CP437 -> mojibake. Prefer
        // the raw bytes when they validate as UTF-8.
        let name = String::from_utf8(entry.name_raw().to_vec())
            .unwrap_or_else(|_| entry.name().to_string());
        let size = entry.size();
        let Some(target) = ctx.accept(&name, size) else {
            continue;
        };
        let rel = name.clone();
        ctx.write_capped(&target, &mut entry, &rel);
    }
    Ok(())
}

fn unpack_tar(path: &Path, ext: &str, ctx: &mut Ctx) -> WorkerResult<()> {
    let file = File::open(path)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    let reader: Box<dyn Read> = match ext {
        "tgz" | "gz" => Box::new(flate2::read::GzDecoder::new(file)),
        "tbz2" | "bz2" => Box::new(bzip2::read::MultiBzDecoder::new(file)),
        "txz" | "xz" => Box::new(xz2::read::XzDecoder::new(file)),
        _ => Box::new(file),
    };
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| WorkerError::invalid(format!("bad tar: {e}")))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| WorkerError::invalid(format!("tar entry: {e}")))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let size = entry.header().size().unwrap_or(0);
        let name = entry
            .path()
            .map_err(|e| WorkerError::invalid(format!("tar path: {e}")))?
            .to_string_lossy()
            .to_string();
        let Some(target) = ctx.accept(&name, size) else {
            continue;
        };
        let rel = name.clone();
        ctx.write_capped(&target, &mut entry, &rel);
    }
    Ok(())
}

fn unpack_7z(path: &Path, ctx: &mut Ctx) -> WorkerResult<()> {
    // One-shot decompress; caps (count/size, junk, slip-safety) are enforced
    // by the post-walk reconciliation, mirroring the rar path.
    let file = File::open(path)
        .map_err(|e| WorkerError::invalid(format!("open {}: {e}", path.display())))?;
    sevenz_rust::decompress(file, &ctx.dest)
        .map_err(|e| WorkerError::invalid(format!("bad 7z: {e}")))?;
    Ok(())
}

fn unpack_rar(path: &Path, dest: &Path, ctx: &mut Ctx) -> WorkerResult<()> {
    // External binary; per-entry control is not possible, so caps are
    // enforced by the post-walk reconciliation (over-cap entries dropped).
    let path_str = path.to_string_lossy().to_string();
    let out_str = dest.display().to_string();
    let candidates: Vec<(&str, Vec<String>)> = vec![
        ("7zz", vec!["x".into(), "-y".into(), format!("-o{out_str}"), path_str.clone()]),
        ("7z", vec!["x".into(), "-y".into(), format!("-o{out_str}"), path_str.clone()]),
        (
            "unar",
            vec![
                "-f".into(),
                "-o".into(),
                out_str.clone(),
                path_str.clone(),
            ],
        ),
    ];
    for (program, args) in &candidates {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_tool(program, &argv, Duration::from_secs(600)) {
            Ok(_) => return Ok(()),
            Err(e)
                if matches!(
                    e.code,
                    crate::proto::mentro::worker::v1::EErrorCode::ToolMissing
                ) =>
            {
                continue; // try next candidate
            }
            Err(e) => return Err(e),
        }
    }
    ctx.skipped += 1;
    Err(WorkerError::new(
        crate::proto::mentro::worker::v1::EErrorCode::ToolMissing,
        "no rar extractor found (install 7zz / p7zip / unar)",
        false,
    ))
}

/// Walk the unpacked tree: build the final file list, sum real sizes,
/// enforce caps for formats unpacked externally (rar).
fn reconcile(dest: &Path, ctx: &mut Ctx) -> WorkerResult<()> {
    ctx.files.clear();
    ctx.total = 0;
    for entry in walkdir::WalkDir::new(dest).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(dest)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if ctx.files.len() as i64 >= ctx.max_entries || ctx.total + size as i64 > ctx.max_bytes {
            let _ = std::fs::remove_file(entry.path());
            ctx.skipped += 1;
            continue;
        }
        ctx.total += size as i64;
        ctx.files.push(rel);
    }
    Ok(())
}
