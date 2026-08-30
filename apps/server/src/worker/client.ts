import { spawn, type ChildProcess } from "node:child_process";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ulid } from "ulid";
import {
  EmbedRequestSchema,
  ExportRequestSchema,
  ExtractRequestSchema,
  RequestSchema,
  ScanRequestSchema,
  TranscribeRequestSchema,
  UnwatchRequestSchema,
  WatchRequestSchema,
  WorkerFrameSchema,
  type FsMessage,
  type ReadyMessage,
  type Request,
  type Response,
  type WorkerFrame,
} from "@mentro/protocol";

export type ReqBody = NonNullable<Request["body"]>;

/** Reads length-delimited (varint-prefixed) protobuf frames from chunks. */
class FrameReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (bytes: Uint8Array) => void,
    private readonly onEnd: (err?: Error) => void,
  ) {}

  push = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let len = 0;
      let shift = 0;
      let i = 0;
      for (;;) {
        if (i >= this.buffer.length) return; // incomplete varint
        const byte = this.buffer[i++];
        len += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 63) {
          this.onEnd(new Error("varint overflow"));
          return;
        }
      }
      if (this.buffer.length < i + len) return; // incomplete frame
      const frame = this.buffer.subarray(i, i + len);
      this.buffer = this.buffer.subarray(i + len);
      this.onFrame(frame);
    }
  };
}

function encodeFrame(frame: WorkerFrame): Buffer {
  const body = toBinary(WorkerFrameSchema, frame);
  const varint: number[] = [];
  let len = body.byteLength;
  for (;;) {
    let byte = len & 0x7f;
    len = Math.floor(len / 128);
    if (len !== 0) byte |= 0x80;
    varint.push(byte);
    if (len === 0) break;
  }
  return Buffer.concat([Buffer.from(varint), Buffer.from(body)]);
}

interface Waiter {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}

export interface WorkerEvents {
  onLog?: (level: number, message: string) => void;
  onFs?: (event: FsMessage) => void;
}

export class WorkerClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, Waiter>();
  private readyPromise: Promise<ReadyMessage> | null = null;
  ready: ReadyMessage | null = null;

  constructor(
    private readonly binPath: string,
    private readonly events: WorkerEvents = {},
  ) {}

  start(): Promise<ReadyMessage> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<ReadyMessage>((resolve, reject) => {
      let settled = false;
      const settleReady = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const child = spawn(this.binPath, ["serve"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      this.child = child;

      const reader = new FrameReader(
        (bytes) => {
          let frame: WorkerFrame;
          try {
            frame = fromBinary(WorkerFrameSchema, bytes);
          } catch {
            console.warn("[worker] undecodable frame dropped");
            return;
          }
          switch (frame.body.case) {
            case "ready": {
              const ready = frame.body.value;
              this.ready = ready;
              settleReady(() => resolve(ready));
              break;
            }
            case "response": {
              const waiter = this.pending.get(frame.body.value.id);
              if (waiter) {
                this.pending.delete(frame.body.value.id);
                waiter.resolve(frame.body.value);
              } else {
                console.warn(
                  `[worker] response with unknown id=${frame.body.value.id} (pending: ${[...this.pending.keys()].length})`,
                );
              }
              break;
            }
            case "log":
              this.events.onLog?.(
                frame.body.value.level,
                frame.body.value.message,
              );
              break;
            case "fs":
              this.events.onFs?.(frame.body.value);
              break;
            default:
              break; // progress/fs/ocrStatus arrive in later milestones
          }
        },
        (err) => {
          this.failAll(err ?? new Error("worker stream ended"));
          settleReady(() =>
            reject(new Error("worker exited before handshake")),
          );
        },
      );

      child.stdout!.on("data", reader.push);
      child.stdout!.on("end", () => {
        this.failAll(new Error("worker stdout closed"));
        settleReady(() =>
          reject(new Error("worker stdout closed before handshake")),
        );
      });
      child.on("exit", (code) => {
        this.failAll(new Error(`worker exited with code ${code}`));
        settleReady(() =>
          reject(new Error(`worker exited (${code}) before handshake`)),
        );
      });
      child.on("error", (err) => {
        this.failAll(err);
        settleReady(() => reject(err));
      });
    });
    return this.readyPromise;
  }

  private failAll(err: Error) {
    for (const [, w] of this.pending) w.reject(err);
    this.pending.clear();
  }

  /** Typed helpers. */
  async scan(root: string, timeoutMs?: number): Promise<Response> {
    return this.request(
      { case: "scan", value: create(ScanRequestSchema, { root }) },
      timeoutMs,
    );
  }

  async extract(
    fields: {
      assetId: string;
      path: string;
      contentHash: string;
      kind: number;
      want?: number[];
    },
    timeoutMs?: number,
  ): Promise<Response> {
    return this.request(
      {
        case: "extract",
        value: create(ExtractRequestSchema, { want: [], ...fields }),
      },
      timeoutMs,
    );
  }

  async watch(
    sourceId: string,
    root: string,
    timeoutMs?: number,
  ): Promise<Response> {
    return this.request(
      { case: "watch", value: create(WatchRequestSchema, { sourceId, root }) },
      timeoutMs,
    );
  }

  async unwatch(sourceId: string, timeoutMs?: number): Promise<Response> {
    return this.request(
      {
        case: "unwatch",
        value: create(UnwatchRequestSchema, { sourceId }),
      },
      timeoutMs,
    );
  }

  async transcribe(
    fields: { assetId: string; path: string; contentHash: string },
    timeoutMs?: number,
  ): Promise<Response> {
    return this.request(
      {
        case: "transcribe",
        value: create(TranscribeRequestSchema, fields),
      },
      timeoutMs,
    );
  }

  async embed(texts: string[], timeoutMs?: number): Promise<Response> {
    return this.request(
      { case: "embed", value: create(EmbedRequestSchema, { texts }) },
      timeoutMs,
    );
  }

  async exportUnits(
    fields: {
      units: Array<{ assetId: string; ordinal: number; path: string }>;
      format: number;
      nameHint: string;
    },
    timeoutMs?: number,
  ): Promise<Response> {
    return this.request(
      { case: "export", value: create(ExportRequestSchema, fields) },
      timeoutMs,
    );
  }

  /** Send a request; resolves with the worker's Response. */
  async request(body: ReqBody, timeoutMs = 15 * 60 * 1000): Promise<Response> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("worker not started");
    const id = ulid();
    const frame = create(WorkerFrameSchema, {
      body: {
        case: "request",
        value: create(RequestSchema, { id, body }),
      },
    });
    const payload = encodeFrame(frame);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll(new Error("worker stopped"));
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
