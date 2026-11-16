import type { GlossaryEntry } from "../services/settings.service";

/** Build the LLM translation system prompt. Hard format contract: the
 *  user message is JSON.stringify(texts); the model must answer with
 *  ONLY a JSON array of exactly N strings. The glossary keeps domain
 *  terminology consistent across the corpus. */
export function buildTranslatePrompt(
  source: string,
  target: string,
  n: number,
  glossary: GlossaryEntry[],
): string {
  const lines = [
    `你是专业笔译员，把输入 JSON 数组中的每个字符串从${source === "" ? "自动识别的源语言" : source}翻译为${target}。`,
    `输出要求：只返回一个 JSON 数组，恰好包含 ${n} 个翻译后的字符串，顺序与输入一致；不要输出任何解释、编号或 markdown。`,
    "保持原文的换行与段落结构；数字、代码、专有名词原样保留。",
  ];
  const terms = glossary.filter((g) => g.src.trim() && g.dst.trim());
  if (terms.length > 0) {
    lines.push("术语表（必须严格遵守）：");
    for (const t of terms.slice(0, 200)) {
      lines.push(`- ${t.src} -> ${t.dst}`);
    }
  }
  return lines.join("\n");
}
