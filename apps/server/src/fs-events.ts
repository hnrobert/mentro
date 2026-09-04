/** Debounced fs event consumer: worker raw events → debounced → reconcile. */

import { AppDataSource } from "./db/data-source";
import { Source } from "./db/entities";
import { runSourceScan } from "./pipeline/scan";
import { publish } from "./bus";
import type { WorkerClient } from "./worker/client";

/** Path → last event timestamp. Multiple events for the same path within
 * the debounce window collapse into a single action. */
const pending = new Map<string, number>();

/** Source → first pending event timestamp (max-wait guard). */
const firstSeen = new Map<string, number>();

const DEBOUNCE_MS = 2000;
/** Hard deadline: a reconcile fires at most this long after a source's
 * first pending event, so an event storm (bulk reads, archive unpacks)
 * cannot keep resetting the quiet-window debounce forever. */
const MAX_WAIT_MS = 5000;

export interface FsEvent {
  sourceId: string;
  path: string;
  kind: number;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Handle a raw fs event from the worker. Debounces rapid-fire writes
 * (editor saves). After the debounce, triggers an incremental scan of
 * the source (cheapest correct reconcile: diff-hash, enqueue, prune). */
export function onFsEvent(event: FsEvent, worker: WorkerClient): void {
  const now = Date.now();
  pending.set(event.path, now);
  if (!firstSeen.has(event.sourceId)) firstSeen.set(event.sourceId, now);

  // Reset the quiet-window timer for this source on every event, but
  // never wait longer than MAX_WAIT after the first pending one.
  const existing = timers.get(event.sourceId);
  if (existing) clearTimeout(existing);
  const waited = now - (firstSeen.get(event.sourceId) ?? now);
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited));

  timers.set(
    event.sourceId,
    setTimeout(() => void reconcile(event.sourceId, worker), delay),
  );
}

async function reconcile(
  sourceId: string,
  worker: WorkerClient,
): Promise<void> {
  timers.delete(sourceId);
  firstSeen.delete(sourceId);

  // Prune entries older than the debounce window.
  const cutoff = Date.now() - DEBOUNCE_MS;
  for (const [path, ts] of pending) {
    if (ts < cutoff) pending.delete(path);
  }
  if (pending.size === 0) return;

  pending.clear();

  const source = await AppDataSource.getRepository(Source).findOneBy({
    id: sourceId,
  });
  if (!source) return;

  try {
    const outcome = await runSourceScan(source, worker);
    publish({ event: "scan.finished", sourceId, ...outcome });
  } catch (err) {
    console.error("[fs] reconcile failed:", err);
  }
}
