//! Directory scan: parallel walk, ignore rules (built-in + `.mentroignore`
//! at the source root), content sniffing, blake3 hashing under the size
//! cap. Oversized files are recorded but never hashed.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use globset::{Glob, GlobSet, GlobSetBuilder};

use crate::{error::WorkerResult, kind::classify, proto::mentro::worker::v1::CMsgFileRecord};

/// Directory names always skipped (on top of dot-entries, which jwalk's
/// `skip_hidden` already removes).
const BUILTIN_IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "data", "__MACOSX"];

/// Default cap: 5 GB; overridable via MENTRO_MAX_FILE_SIZE (bytes).
pub const DEFAULT_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024 * 1024;

pub fn max_file_size() -> u64 {
    std::env::var("MENTRO_MAX_FILE_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_FILE_SIZE)
}

/// Simplified gitignore-style patterns from `.mentroignore`: each line is
/// a glob matched against the path relative to the source root (and
/// against the file name for patterns without a `/`). No negation.
struct IgnoreRules {
    set: GlobSet,
}

impl IgnoreRules {
    fn load(root: &Path) -> Self {
        let mut builder = GlobSetBuilder::new();
        if let Ok(text) = std::fs::read_to_string(root.join(".mentroignore")) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Ok(glob) = Glob::new(line) {
                    builder.add(glob);
                }
            }
        }
        Self {
            set: builder.build().unwrap_or_default(),
        }
    }

    fn is_ignored(&self, relative: &str, file_name: &str) -> bool {
        self.set.is_match(relative) || self.set.is_match(file_name)
    }
}

fn hash_blake3(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                hasher.update(&buf[..n]);
            }
            Err(_) => return None,
        }
    }
    Some(hasher.finalize().to_hex().to_string())
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Walk `root` and produce one record per non-ignored file.
pub fn scan_root(root: &Path) -> WorkerResult<Vec<CMsgFileRecord>> {
    if !root.is_dir() {
        return Err(crate::error::WorkerError::invalid(format!(
            "not a directory: {}",
            root.display()
        )));
    }
    let cap = max_file_size();
    let rules = IgnoreRules::load(root);
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    // Serial walk (walkdir): the hot cost is blake3 hashing, not traversal,
    // and jwalk's shared rayon pool wedged under the threaded dispatcher
    // (worker hung at 0% CPU with all requests stalled).
    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.depth() > 0
                && (name.starts_with('.') || BUILTIN_IGNORED_DIRS.contains(&name.as_ref())))
        });

    let mut records = Vec::new();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // unreadable entries are skipped, not fatal
        };
        let path: PathBuf = entry.path().to_path_buf();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if rules.is_ignored(&relative, name) {
            continue;
        }

        let Ok(md) = std::fs::metadata(&path) else {
            continue;
        };
        let size = md.len();
        let oversized = size > cap;
        let mime = if oversized {
            None
        } else {
            infer::get_from_path(&path)
                .ok()
                .flatten()
                .map(|t| t.mime_type().to_string())
        };
        let kind = classify(mime.as_deref(), &path);
        let content_hash = if oversized {
            String::new()
        } else {
            hash_blake3(&path).unwrap_or_default()
        };

        records.push(CMsgFileRecord {
            path: path.to_string_lossy().to_string(),
            size_bytes: size as i64,
            mtime_ms: mtime_ms(&md),
            mime: mime.unwrap_or_default(),
            kind: kind as i32,
            oversized,
            content_hash,
        });
    }

    records.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(records)
}
