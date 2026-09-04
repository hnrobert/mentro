import os from "node:os";
import { WorkerClient, type WorkerEvents } from "./client";
import type { ReadyMessage } from "@mentro/protocol";

/**
 * Pool of worker processes — the serve loop inside each worker is
 * single-threaded by design (deadlock-free), so throughput comes from
 * running N of them. Job execution goes through claim/release (each
 * long job owns one worker); watch/fs events are pinned to the primary
 * (worker 0) because WATCH_HUB state is per-process. Crashed workers
 * are replaced automatically.
 */

export function defaultPoolSize(): number {
  const cores = os.availableParallelism();
  return Math.max(2, Math.min(8, Math.floor(cores / 2)));
}

interface Waiter {
  resolve: (worker: WorkerClient) => void;
}

export class WorkerPool {
  private clients: Array<WorkerClient | null> = [];
  private idle: WorkerClient[] = [];
  private waiters: Waiter[] = [];

  private constructor(
    private readonly binPath: string,
    private readonly events: WorkerEvents,
  ) {}

  static async start(
    binPath: string,
    events: WorkerEvents,
    size: number,
  ): Promise<WorkerPool> {
    const pool = new WorkerPool(binPath, events);
    pool.clients = Array.from({ length: size }, () => null);
    await pool.startAll();
    return pool;
  }

  private async startAll(): Promise<void> {
    await Promise.all(this.clients.map((_c, i) => this.startWorker(i)));
  }

  private async startWorker(i: number): Promise<void> {
    // Primary (i=0) is the only client wired for fs events; a respawned
    // primary keeps that role.
    const events: WorkerEvents =
      i === 0 ? this.events : { onLog: this.events.onLog };
    const client = new WorkerClient(this.binPath, events);
    try {
      await client.start();
    } catch (err) {
      console.error(`[pool] worker ${i} failed to start:`, err);
      // Retry in the background; claims wait until it's up.
      setTimeout(() => void this.startWorker(i), 2000);
      return;
    }
    client.onExit(() => {
      console.error(`[pool] worker ${i} exited — replacing`);
      this.idle = this.idle.filter((w) => w !== client);
      this.clients[i] = null;
      setTimeout(() => void this.startWorker(i), 2000);
    });
    this.clients[i] = client;
    this.idle.push(client);
    this.drainWaiters();
  }

  get size(): number {
    return this.clients.length;
  }

  get ready(): ReadyMessage | null {
    return this.clients[0]?.ready ?? null;
  }

  /** The watch-owning client (routes/fs-events keep using it directly). */
  primary(): WorkerClient {
    const primary = this.clients[0];
    if (!primary) {
      throw new Error("primary worker not running (respawning)");
    }
    return primary;
  }

  idleCount(): number {
    return this.idle.length;
  }

  /** Synchronous claim when a worker is idle; null otherwise. */
  tryClaim(): WorkerClient | null {
    return this.idle.pop() ?? null;
  }

  /** Claim a worker, waiting until one is idle. */
  async claim(): Promise<WorkerClient> {
    const now = this.tryClaim();
    if (now) return now;
    return new Promise<WorkerClient>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  release(worker: WorkerClient): void {
    if (!this.clients.includes(worker)) return; // dead/removed
    this.idle.push(worker);
    this.drainWaiters();
  }

  /** Run a one-off operation on any idle worker. */
  async run<T>(fn: (worker: WorkerClient) => Promise<T>): Promise<T> {
    const worker = await this.claim();
    try {
      return await fn(worker);
    } finally {
      this.release(worker);
    }
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop();
      const waiter = this.waiters.shift();
      if (worker && waiter) waiter.resolve(worker);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.clients.map(async (c) => {
        if (c) await c.stop();
      }),
    );
  }
}
