import { ulid } from "ulid";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppDataSource } from "./db/data-source";
import { Asset, ContentUnit, Job } from "./db/entities";
import { authGuard } from "./auth/guards";
import { countEmbeddings } from "./search/embeddings";
import { createExportJob } from "./routes/export";
import { hybridSearch } from "./routes/search";
import type { WorkerClient } from "./worker/client";
import { canRead } from "./auth/perm";

/**
 * MCP (Model Context Protocol) endpoint — the Agent Tool API exposed in
 * the protocol Claude Code / MCP clients speak natively. Transport:
 * streamable HTTP (POST /mcp, JSON responses; no server-push SSE stream,
 * so GET returns 405 per spec). Stateless: no session id required.
 * Auth: the same JWT Bearer token as the HTTP API.
 *
 * Tools mirror /api/agent/* one-to-one — one implementation surface.
 */

const PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_VERSIONS = new Set(["2025-03-26", "2024-11-05"]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    request: FastifyRequest,
  ) => Promise<unknown>;
}

function str(
  args: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

function num(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function unitRefsOf(
  args: Record<string, unknown>,
): Array<{ assetId: string; ordinal: number }> {
  const units = args.units;
  if (!Array.isArray(units)) return [];
  return units.flatMap((u) => {
    if (typeof u === "object" && u !== null) {
      const ref = u as Record<string, unknown>;
      if (typeof ref.assetId === "string" && typeof ref.ordinal === "number") {
        return [{ assetId: ref.assetId, ordinal: ref.ordinal }];
      }
    }
    return [];
  });
}

function buildTools(worker: WorkerClient): ToolDef[] {
  return [
    {
      name: "mentro_search",
      description:
        "Search the knowledge base (PDF pages, PPT slides, transcripts, image OCR text). " +
        "Hybrid mode merges keyword (FTS) and semantic (embedding) rankings; fts is exact-keyword only.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search text (English or Chinese)",
          },
          mode: { type: "string", enum: ["hybrid", "fts", "semantic"] },
          kind: {
            type: "string",
            description: "Filter by asset kind (pdf/presentation/video/...)",
          },
          limit: { type: "number", default: 20 },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const hits = await hybridSearch(
          worker,
          str(args, "query"),
          Math.min(50, Math.max(1, num(args, "limit", 20))),
          str(args, "mode", "hybrid") === "fts" ||
            str(args, "mode") === "semantic"
            ? (str(args, "mode") as "fts" | "semantic")
            : "hybrid",
        );
        const kind = str(args, "kind");
        return { hits: kind ? hits.filter((h) => h.kind === kind) : hits };
      },
    },
    {
      name: "mentro_get_asset",
      description:
        "Get one asset (file) with its content units: page/slide count, titles, time ranges, text previews.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
      },
      handler: async (args, request) => {
        const asset = await AppDataSource.getRepository(Asset).findOneBy({
          id: str(args, "assetId"),
        });
        if (!asset) return { error: "asset not found" };
        if (!(await canRead(request.user!, asset.id))) {
          return { error: "forbidden" };
        }
        const units = await AppDataSource.getRepository(ContentUnit).find({
          where: { assetId: asset.id },
          order: { ordinal: "ASC" },
        });
        return {
          asset: {
            id: asset.id,
            path: asset.path,
            kind: asset.kind,
            sizeBytes: asset.sizeBytes,
          },
          units: units.map((u) => ({
            unitId: u.id,
            ordinal: u.ordinal,
            unitType: u.unitType,
            title: u.title,
            startMs: u.startMs,
            endMs: u.endMs,
            textPreview: (u.text ?? "").slice(0, 300),
          })),
        };
      },
    },
    {
      name: "mentro_get_unit",
      description:
        "Get one content unit (page/slide/transcript window) with its full text.",
      inputSchema: {
        type: "object",
        properties: { unitId: { type: "string" } },
        required: ["unitId"],
      },
      handler: async (args, request) => {
        const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
          id: str(args, "unitId"),
        });
        if (!unit) return { error: "unit not found" };
        if (!(await canRead(request.user!, unit.assetId))) {
          return { error: "forbidden" };
        }
        return {
          unit,
          fileUrl: `/api/assets/${unit.assetId}/file`,
          thumbnailUrl: unit.thumbPath ? `/api/thumbs/${unit.id}` : null,
        };
      },
    },
    {
      name: "mentro_get_context",
      description:
        "Neighboring units of one unit inside the same asset (before/after by ordinal) — e.g. surrounding slides or transcript windows.",
      inputSchema: {
        type: "object",
        properties: {
          unitId: { type: "string" },
          before: { type: "number", default: 1 },
          after: { type: "number", default: 1 },
        },
        required: ["unitId"],
      },
      handler: async (args, request) => {
        const unit = await AppDataSource.getRepository(ContentUnit).findOneBy({
          id: str(args, "unitId"),
        });
        if (!unit) return { error: "unit not found" };
        if (!(await canRead(request.user!, unit.assetId))) {
          return { error: "forbidden" };
        }
        const before = Math.min(10, Math.max(0, num(args, "before", 1)));
        const after = Math.min(10, Math.max(0, num(args, "after", 1)));
        return {
          units: await AppDataSource.getRepository(ContentUnit)
            .createQueryBuilder("cu")
            .where("cu.asset_id = :assetId", { assetId: unit.assetId })
            .andWhere("cu.ordinal BETWEEN :lo AND :hi", {
              lo: Math.max(1, unit.ordinal - before),
              hi: unit.ordinal + after,
            })
            .orderBy("cu.ordinal", "ASC")
            .getMany(),
        };
      },
    },
    {
      name: "mentro_export",
      description:
        "Compose a new document from selected units. PDF merges pages across files (office " +
        "pages render through the PDF cache); PPTX cuts selected slides from ONE presentation " +
        "with byte-verbatim fidelity. Returns a jobId — poll it, then download via /api/export/{id}/file.",
      inputSchema: {
        type: "object",
        properties: {
          units: {
            type: "array",
            description: "Ordered unit refs",
            items: {
              type: "object",
              properties: {
                assetId: { type: "string" },
                ordinal: {
                  type: "number",
                  description: "1-based page/slide number",
                },
              },
              required: ["assetId", "ordinal"],
            },
          },
          format: { type: "string", enum: ["pdf", "pptx"] },
          nameHint: { type: "string" },
        },
        required: ["units", "format"],
      },
      handler: async (args, request) => {
        const outcome = await createExportJob(request, {
          units: unitRefsOf(args),
          format: str(args, "format", "pdf") === "pptx" ? "pptx" : "pdf",
          nameHint: str(args, "nameHint"),
        });
        return outcome;
      },
    },
    {
      name: "mentro_transcribe",
      description:
        "Enqueue speech-to-text for an audio/video asset (faster-whisper sidecar). " +
        "Transcript lands as time-positioned units; poll the asset or its jobs.",
      inputSchema: {
        type: "object",
        properties: { assetId: { type: "string" } },
        required: ["assetId"],
      },
      handler: async (args, request) => {
        const asset = await AppDataSource.getRepository(Asset).findOneBy({
          id: str(args, "assetId"),
        });
        if (!asset) return { error: "asset not found" };
        if (!(await canRead(request.user!, asset.id))) {
          return { error: "forbidden" };
        }
        if (asset.kind !== "audio" && asset.kind !== "video") {
          return { error: `kind ${asset.kind} has no audio track` };
        }
        const jobRepo = AppDataSource.getRepository(Job);
        const existing = await jobRepo.findOne({
          where: { kind: "transcribe", assetId: asset.id, status: "pending" },
        });
        if (existing) return { jobId: existing.id, status: "pending" };
        const jobId = ulid();
        await jobRepo.insert({
          id: jobId,
          assetId: asset.id,
          kind: "transcribe",
          status: "pending",
        });
        return { jobId, status: "pending" };
      },
    },
    {
      name: "mentro_status",
      description:
        "Corpus + backend status: asset counts by kind, embedding coverage.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const counts = (await AppDataSource.query(
          "SELECT kind, COUNT(*) AS n FROM assets GROUP BY kind ORDER BY n DESC",
        )) as Array<{ kind: string; n: number }>;
        return {
          assets: counts,
          embeddings: await countEmbeddings(),
          workerCapabilities: worker.ready?.capabilities ?? [],
        };
      },
    },
  ];
}

export function registerMcp(
  app: FastifyInstance,
  opts: { jwtSecret: Uint8Array; worker: WorkerClient },
): void {
  const guard = authGuard({ jwtSecret: opts.jwtSecret });
  const tools = buildTools(opts.worker);

  // Stateless streamable HTTP: POST carries every client message.
  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    await guard(request, reply);
    if (reply.sent) return reply;

    const rpc = request.body as JsonRpcRequest | JsonRpcRequest[];
    const single = async (
      message: JsonRpcRequest,
    ): Promise<Record<string, unknown> | undefined> => {
      const { method, id } = message;
      // Notifications (no id) get no response body.
      if (id === undefined || id === null) return undefined;
      const replyWith = (result: Record<string, unknown>) => ({
        jsonrpc: "2.0" as const,
        id,
        result,
      });
      try {
        switch (method) {
          case "initialize":
            return replyWith({
              protocolVersion: SUPPORTED_VERSIONS.has(
                String(message.params?.protocolVersion),
              )
                ? String(message.params?.protocolVersion)
                : PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "mentro", version: "1.0.0" },
              instructions:
                "Search the local knowledge base, read units with context, transcribe media, " +
                "and compose selected pages/slides into new PDF/PPTX files.",
            });
          case "ping":
            return replyWith({});
          case "tools/list":
            return replyWith({
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            });
          case "tools/call": {
            const name = String(message.params?.name ?? "");
            const args =
              (message.params?.arguments as Record<string, unknown>) ?? {};
            const tool = tools.find((t) => t.name === name);
            if (!tool) {
              return {
                jsonrpc: "2.0" as const,
                id,
                error: { code: -32602, message: `unknown tool: ${name}` },
              };
            }
            const result = await tool.handler(args, request);
            const isError =
              typeof result === "object" &&
              result !== null &&
              "error" in result &&
              typeof (result as { error: unknown }).error === "string";
            return replyWith({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
              isError,
            });
          }
          default:
            return {
              jsonrpc: "2.0" as const,
              id,
              error: { code: -32601, message: `method not found: ${method}` },
            };
        }
      } catch (err) {
        return {
          jsonrpc: "2.0" as const,
          id,
          error: { code: -32603, message: String(err) },
        };
      }
    };

    const responses = Array.isArray(rpc)
      ? (await Promise.all(rpc.map(single))).filter(Boolean)
      : [await single(rpc)].filter(Boolean);

    if (responses.length === 0) return reply.code(202).send();
    reply.header("content-type", "application/json");
    return reply.send(Array.isArray(rpc) ? responses : responses[0]);
  });

  // No server-push stream: per spec, respond 405.
  app.get("/mcp", async (_request, reply) =>
    reply.code(405).send({ error: "SSE stream not supported; POST only" }),
  );
  app.delete("/mcp", async (_request, reply) =>
    reply
      .code(405)
      .send({ error: "stateless server; no session to terminate" }),
  );
}
