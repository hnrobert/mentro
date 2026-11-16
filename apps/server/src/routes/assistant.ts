/** Assistant routes: SSE transport over the assistant service. Deltas
 *  and the terminal sources event stream out as `data:` frames. */

import type { FastifyInstance } from "fastify";
import {
  prepareAsk,
  prepareDeepread,
  preparePlan,
  prepareSummarize,
  type AssistantBody,
} from "../services/assistant.service";
import { llmConfig, llmStream, LLM_ENV_HINT } from "../llm";
import { ServiceError } from "../services/errors";
import type { WorkerClient } from "../worker/client";

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
            ? await prepareSummarize(request.user!, worker, body)
            : body.task === "ask"
              ? await prepareAsk(request.user!, worker, body)
              : body.task === "plan"
                ? await preparePlan(request.user!, worker, body)
                : body.task === "deepread"
                  ? await prepareDeepread(request.user!, body)
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
        if (err instanceof ServiceError) {
          return reply.code(err.code).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
