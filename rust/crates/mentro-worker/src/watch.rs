//! Filesystem watching via the `notify` crate. Reports raw events; the
//! server-side debounces and enqueues extraction jobs.

use std::{path::Path, sync::mpsc};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::proto::mentro::worker::v1::FsMessage;

/// Manages multiple source watchers. The serve loop creates one hub and
/// feeds it watch/unwatch requests; the hub drains events to the caller.
pub struct WatchHub {
    watchers: Vec<RecommendedWatcher>,
    sources: Vec<(String, String)>,
    receivers: Vec<(mpsc::Receiver<notify::Result<notify::Event>>, String)>,
}

impl WatchHub {
    pub fn new() -> Self {
        Self {
            watchers: Vec::new(),
            sources: Vec::new(),
            receivers: Vec::new(),
        }
    }

    pub fn watch(&mut self, source_id: &str, root: &str) -> Result<(), String> {
        self.unwatch(source_id);

        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let sid = source_id.to_string();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;

        watcher
            .watch(Path::new(root), RecursiveMode::Recursive)
            .map_err(|e| format!("watch {root}: {e}"))?;

        self.watchers.push(watcher);
        self.sources.push((sid.clone(), root.to_string()));
        self.receivers.push((rx, sid));
        Ok(())
    }

    pub fn unwatch(&mut self, source_id: &str) {
        if let Some(pos) = self.sources.iter().position(|(sid, _)| sid == source_id) {
            self.watchers.remove(pos);
            self.sources.remove(pos);
            self.receivers.remove(pos);
        }
    }

    /// Drain all pending events across all watchers (non-blocking).
    /// Returns FsMessage frames ready to send to the server.
    pub fn drain(&mut self) -> Vec<FsMessage> {
        use notify::event::ModifyKind;
        let mut out = Vec::new();
        for (rx, sid) in &self.receivers {
            while let Ok(event) = rx.try_recv() {
                if let Ok(ev) = event {
                    // Metadata-only modifies are read noise: reading a
                    // file through a read-only mount still bumps the
                    // host atime, which would flood the watcher and
                    // starve the server-side debounce during indexing.
                    if matches!(ev.kind, EventKind::Modify(ModifyKind::Metadata(_))) {
                        continue;
                    }
                    for path in &ev.paths {
                        if let Some(p) = path.to_str() {
                            out.push(FsMessage {
                                source_id: sid.clone(),
                                path: p.to_string(),
                                kind: classify(&ev.kind),
                            });
                        }
                    }
                }
            }
        }
        out
    }

    #[allow(dead_code)]
    pub fn watched(&self) -> Vec<(String, String)> {
        self.sources.clone()
    }
}

/// Map a notify event kind to protocol enum value.
fn classify(kind: &EventKind) -> i32 {
    use notify::event::*;
    match kind {
        EventKind::Create(_) => crate::proto::mentro::worker::v1::EFsEventKind::Created as i32,
        EventKind::Modify(_) => crate::proto::mentro::worker::v1::EFsEventKind::Modified as i32,
        EventKind::Remove(_) => crate::proto::mentro::worker::v1::EFsEventKind::Removed as i32,
        _ => crate::proto::mentro::worker::v1::EFsEventKind::Modified as i32,
    }
}
