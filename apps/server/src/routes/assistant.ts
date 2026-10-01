import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppDataSource } from "../db/data-source";
import { ContentUnit } from "../db/entities";
import { hybridSearch, readableOf } from "./search";
import type { SearchHit } from "../search/fts";
import { llmConfig, llmStream, LLM_ENV_HINT, type LlmMessage } from "../llm";
import { canRead } from "../auth/perm";
import type { WorkerClient } from "../worker/client";

/**
 * AI assistant (search-page card): server-driven RAG over the same
 * hybrid search the UI uses. Four tasks —
 *   summarize  synthesize the CURRENT search results (scope/groups kept)
 *   ask        free-form question answered from the library
 *   plan       stepwise research plan for a topic (QUERY: lines become
 *              clickable search buttons in the UI)
 *   deepread   explain one unit plus its neighbours
 * Output is SSE: {"delta"} chunks, then {"sources"}, then [DONE].
 * Citations are 【i】 indices into the sources list.
 */

type Task = "summarize" | "ask" | "plan" | "deepread";

interface AssistantBody {
  task?: Task;
  q?: string; // summarize: the current query
  scope?: string; // summarize: content|everywhere|filename
  groups?: string; // summarize: comma-separated ids
  question?: string; // ask
  topic?: string; // plan
  unitId?: string; // deepread
}

export interface AssistantSource {
  i: number;
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  fileName: string;
  title: string | null;
}

const SYSTEM_PROMPT = [
  "你是知识库检索助手 Mentro AI，服务于一个内部资料库（PPT/PDF/Word 等）。",
  "回答使用简体中文；输出纯文本，不要使用 markdown 符号（星号、井号、反引号）；列表用「- 」开头。",
  "引用资料时用【编号】标注，例如【1】【3】。",
  "资料是检索结果，可能与问题无关：无关内容不要引用，也不要编造库里不存在的资料。",
  "资料不足以回答时，明确说明库里没有相关内容。",
].join("\n");

/** "[foo] bar" FTS snippets -> plain text. */
function cleanSnippet(s: string | null): string {
  return (s ?? "").replaceAll("[", "").replaceAll("]", "").trim();
}

function hitFileName(h: SearchHit): string {
  return h.assetPath.split("/").pop() ?? h.fileName;
}

function sourcesOf(hits: SearchHit[]): AssistantSource[] {
  return hits.map((h, i) => ({
    i: i + 1,
    unitId: h.unitId,
    assetId: h.assetId,
    ordinal: h.ordinal,
    unitType: h.unitType,
    fileName: hitFileName(h),
    title: h.title,
  }));
}

function hitsContext(hits: SearchHit[], perHitChars: number): string {
  return hits
    .map((h, i) => {
      const snippet = cleanSnippet(h.snippet).slice(0, perHitChars);
      return `[${i + 1}] 《${hitFileName(h)}》${h.unitType} ${h.ordinal}：${h.title ?? ""}\n${snippet}`;
    })
    .join("\n\n");
}

/** Free-text inputs capped server-side: the 4 MB body limit would
 *  otherwise push megabyte strings into jieba + the LLM prompt. */
const INPUT_CAP = 200;

function cap(s: string | undefined): string {
  return (s ?? "").trim().slice(0, INPUT_CAP);
}

// --- per-task prompt + context assembly -----------------------------------

interface Prepared {
  messages: LlmMessage[];
  sources: AssistantSource[];
  maxTokens: number;
}

async function prepareSummarize(
  request: FastifyRequest,
  worker: WorkerClient,
  body: AssistantBody,
): Promise<Prepared> {
  const q = cap(body.q);
  const scope =
    body.scope === "content" || body.scope === "filename"
      ? body.scope
      : "everywhere";
  const groups = body.groups
    ? new Set(body.groups.split(",").filter(Boolean))
    : undefined;
  const hits = await hybridSearch(worker, q, 12, "hybrid", {
    scope,
    groups,
    readable: await readableOf(request),
  });
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `检索词：${q}`,
          `检索结果（编号供引用）：`,
          hitsContext(hits, 600),
          "",
          "请综合以上检索结果写一份综述：",
          "1. 先用一两句话概括这些资料整体在讲什么",
          "2. 分点提炼关键信息，每点标注来源【i】",
          "3. 最后指出资料之间的矛盾、缺口或值得深入的方向",
          "全文控制在 400 字左右。",
        ].join("\n"),
      },
    ],
    sources: sourcesOf(hits),
    maxTokens: 800,
  };
}

async function prepareAsk(
  request: FastifyRequest,
  worker: WorkerClient,
  body: AssistantBody,
): Promise<Prepared> {
  const question = cap(body.question);
  const hits = await hybridSearch(worker, question, 10, "hybrid", {
    readable: await readableOf(request),
  });
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `问题：${question}`,
          "库内相关资料（编号供引用）：",
          hitsContext(hits, 700),
          "",
          "请回答问题：优先使用资料中的信息并标注【i】；资料未覆盖的部分可以基于常识补充，但必须注明「（资料外）」。",
        ].join("\n"),
      },
    ],
    sources: sourcesOf(hits),
    maxTokens: 900,
  };
}

async function preparePlan(
  request: FastifyRequest,
  worker: WorkerClient,
  body: AssistantBody,
): Promise<Prepared> {
  const topic = cap(body.topic);
  const hits = await hybridSearch(worker, topic, 15, "hybrid", {
    readable: await readableOf(request),
  });
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `研究主题：${topic}`,
          "库内已有相关资料（编号供引用）：",
          hitsContext(hits, 300),
          "",
          "请提出一份分步研究计划：",
          "1. 先评估：库内资料覆盖了什么、缺什么（引用【i】）",
          "2. 给出 3-6 个步骤，每步写明目标和建议动作",
          "3. 每一步的检索建议必须单独成行，格式固定为「QUERY: 检索词」（前端会把这种行渲染成可点击按钮）",
          "4. 最后给出推荐阅读顺序（引用【i】）",
        ].join("\n"),
      },
    ],
    sources: sourcesOf(hits),
    maxTokens: 1000,
  };
}

async function prepareDeepread(
  request: FastifyRequest,
  body: AssistantBody,
): Promise<Prepared> {
  const unitId = (body.unitId ?? "").trim();
  const repo = AppDataSource.getRepository(ContentUnit);
  const unit = await repo.findOneBy({ id: unitId });
  if (!unit) throw new HttpError(404, "unit not found");
  if (!(await canRead(request.user!, unit.assetId))) {
    throw new HttpError(403, "forbidden");
  }
  const neighbours = await repo
    .createQueryBuilder("cu")
    .where("cu.asset_id = :assetId AND cu.ordinal BETWEEN :lo AND :hi", {
      assetId: unit.assetId,
      lo: Math.max(1, unit.ordinal - 1),
      hi: unit.ordinal + 1,
    })
    .orderBy("cu.ordinal", "ASC")
    .getMany();
  // Current page first so citations naturally point at 【1】.
  const ordered = [unit, ...neighbours.filter((n) => n.id !== unit.id)];
  const assetNameRow = (await AppDataSource.query(
    "SELECT path FROM assets WHERE id = ?",
    [unit.assetId],
  )) as Array<{ path: string }>;
  const fileName = assetNameRow[0]?.path.split("/").pop() ?? "";

  const context = ordered
    .map(
      (u, i) =>
        `[${i + 1}] ${u.id === unit.id ? "（当前页）" : `（${u.ordinal < unit.ordinal ? "前一页" : "后一页"}）`}《${fileName}》${u.unitType} ${u.ordinal}：${u.title ?? ""}\n${(u.text ?? "").slice(0, 3000)}`,
    )
    .join("\n\n");

  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `用户正在深读《${fileName}》的${unit.unitType} ${unit.ordinal}，当前页标记为【1】，相邻页供参考：`,
          context,
          "",
          "请深入讲解当前页【1】：",
          "1. 内容概述",
          "2. 关键术语解释（中英对照）",
          "3. 与前后页的逻辑关系",
          "4. 可能的应用场景或值得注意的问题",
        ].join("\n"),
      },
    ],
    sources: ordered.map((u, i) => ({
      i: i + 1,
      unitId: u.id,
      assetId: u.assetId,
      ordinal: u.ordinal,
      unitType: u.unitType,
      fileName,
      title: u.title,
    })),
    maxTokens: 1000,
  };
}

// --- plumbing --------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function registerAssistantRoutes(
  app: FastifyInstance,
  worker: WorkerClient,
) {
  app.post<{ Body: AssistantBody }>(
    "/api/assistant",
    // Billable third-party call per request — the only such endpoint, so
    // it gets its own budget (mirrors the login route's opt-in).
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!llmConfig()) {
        return reply.code(501).send({
          error: "LLM not configured",
          hint: LLM_ENV_HINT,
        });
      }
      const body = request.body ?? {};
      try {
        const prepared =
          body.task === "summarize"
            ? await prepareSummarize(request, worker, body)
            : body.task === "ask"
              ? await prepareAsk(request, worker, body)
              : body.task === "plan"
                ? await preparePlan(request, worker, body)
                : body.task === "deepread"
                  ? await prepareDeepread(request, body)
                  : null;
        if (!prepared) {
          return reply.code(400).send({ error: "unknown task" });
        }

        // Stream out as SSE. Client-disconnect abort hooks the RESPONSE
        // (Node >=16 fires request 'close' at body consumption, not at
        // disconnect — hooking the request never fires here); the
        // writableEnded check separates normal completion from abort.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (obj: unknown): void => {
          raw.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        const controller = new AbortController();
        raw.on("close", () => {
          if (!raw.writableEnded) controller.abort();
        });

        try {
          for await (const delta of llmStream(prepared.messages, {
            signal: controller.signal,
            maxTokens: prepared.maxTokens,
          })) {
            send({ delta });
          }
          send({ sources: prepared.sources });
        } catch (err) {
          send({ error: String(err instanceof Error ? err.message : err) });
        } finally {
          raw.write("data: [DONE]\n\n");
          raw.end();
        }
      } catch (err) {
        if (err instanceof HttpError) {
          return reply.code(err.code).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
