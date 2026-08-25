/**
 * Chinese-aware segmentation shared by FTS indexing and query building.
 * Falls back to identity (FTS5 unicode61 tokenizes CJK per character, so
 * phrase matching still works) when jieba-wasm is unavailable.
 */
let cutFn: ((text: string) => string[]) | null = null;
let initialized = false;

interface JiebaModule {
  init?: () => Promise<unknown> | unknown;
  cut?: (text: string, hmm?: boolean) => string[];
  default?: JiebaModule;
}

export async function initSegmenter(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const mod = (await import("jieba-wasm")) as JiebaModule;
    // The module shape varies across jieba-wasm versions: sometimes the
    // API hangs off `default`, sometimes init() is required first.
    const api =
      mod.default && (mod.default.cut || mod.default.init) ? mod.default : mod;
    if (typeof api.init === "function") await api.init();
    if (typeof api.cut !== "function")
      throw new Error("cut() not found on module");
    cutFn = (text: string) => api.cut!(text, true);
  } catch (err) {
    console.warn(
      "[search] jieba-wasm unavailable, falling back to identity:",
      err,
    );
  }
}

export function segment(text: string): string {
  if (!cutFn) return text;
  try {
    return cutFn(text).join(" ");
  } catch {
    return text;
  }
}

/** Build an FTS5 MATCH expression: tokens quoted, space-joined (AND). */
export function ftsMatchExpr(query: string): string {
  const source = cutFn ? segment(query) : query;
  const tokens = source
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return tokens.join(" ");
}
