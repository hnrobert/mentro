/**
 * OpenAI-compatible LLM client (chat/completions, streaming). Endpoint,
 * key and model come from env — see docker-compose.yml:
 *   MENTRO_LLM_BASE_URL  e.g. https://api.deepseek.com/v1
 *   MENTRO_LLM_API_KEY
 *   MENTRO_LLM_MODEL     e.g. deepseek-chat
 * Unset -> null and every assistant feature degrades to a clear 501.
 */

export interface LlmConfig {
  baseUrl: string; // no trailing slash
  apiKey: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function llmConfig(): LlmConfig | null {
  const baseUrl = (process.env.MENTRO_LLM_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.MENTRO_LLM_API_KEY ?? "").trim();
  const model = (process.env.MENTRO_LLM_MODEL ?? "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

/** Human-readable hint for the "not configured" error. */
export const LLM_ENV_HINT =
  "set MENTRO_LLM_BASE_URL, MENTRO_LLM_API_KEY and MENTRO_LLM_MODEL";

/**
 * Stream chat deltas from the backend. Yields plain text chunks.
 * Non-2xx responses throw with the backend's message where available.
 */
export async function* llmStream(
  messages: LlmMessage[],
  opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
): AsyncGenerator<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error(`LLM not configured (${LLM_ENV_HINT})`);

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      detail =
        (JSON.parse(text) as { error?: { message?: string } }).error?.message ??
        detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`LLM backend ${res.status}: ${detail}`);
  }

  // SSE framing: newline-separated `data: {...}` events, `[DONE]` ends.
  // ONE decoder across chunks — {stream:true} keeps partial-multibyte
  // state per instance, so a per-chunk decoder corrupts CJK sequences
  // that straddle TCP chunk boundaries.
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = function* (line: string): Generator<string> {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const ev = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      /* skip malformed keepalive/comment lines */
    }
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "data: [DONE]") return;
      yield* handleLine(line);
    }
  }
  // Flush: trailing decoder state + a final line lacking its newline
  // (e.g. truncated upstream) still deserves a look.
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail && tail !== "data: [DONE]") {
    yield* handleLine(tail);
  }
}
