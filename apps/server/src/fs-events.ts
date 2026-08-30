/** Debounced fs event consumer: worker raw events → debounced → reconcile. */

import { AppDataSource } from "./db/data-source";
import { Source } from "./db/entities";
import { runSourceScan } from "./pipeline/scan";
import { publish } from "./bus";
import type { WorkerClient } from "./worker/client";

/** Path → last event timestamp. Multiple events for the same path within
 *  the debounce window collapse into a single action. */
const pending = new Map<string, number>();

const DEBOUNCE_MS = 2000;

export interface FsEvent {
  sourceId: string;
  path: string;
  kind: number;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Handle a raw fs event from the worker. Debounces rapid-fire writes
 *  (editor saves). After the debounce, triggers an incremental scan of
 *  the source (cheapest correct reconcile: diff-hash, enqueue, prune). */
export function onFsEvent(event: FsEvent, worker: WorkerClient): void {
  pending.set(event.path, Date.now());

  // Reset the timer for this source on every event.
  const existing = timers.get(event.sourceId);
  if (existing) clearTimeout(existing);

  timers.set(
    event.sourceId,
    setTimeout(() => void reconcile(event.sourceId, worker), DEBOUNCE_MS),
  );
}

async function reconcile(
  sourceId: string,
  worker: WorkerClient,
): Promise<void> {
  timers.delete(sourceId);

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
