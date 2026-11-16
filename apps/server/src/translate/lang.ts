/** Language detection (cheap script classifier) and code mapping.
 *  Detection only routes targets and source hints — the LLM
 *  auto-detects regardless, and the API backends accept auto. */

export type Lang = "zh" | "en" | "ja" | "ko" | "de" | "fr" | "ru" | "es" | null;

/** Dominant script of a text sample; null when there is too little
 *  lettering to classify (numbers/symbols-only units are skipped). */
export function detectScript(text: string): Lang {
  let kana = 0;
  let hangul = 0;
  let han = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7a3) hangul++;
    else if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0xc0 && c <= 0x24f) // latin letters incl. accents
    )
      latin++;
  }
  const letters = kana + hangul + han + cyrillic + latin;
  if (letters < 2) return null;
  if (kana > 0) return "ja";
  if (hangul > 0 && hangul >= han) return "ko";
  // Dominant-script routing: an English deck with Chinese terms stays
  // "en" (its translation target is zh — the desired direction), and
  // vice versa for a Chinese deck with English terms.
  if (han > 0 && han >= latin) return "zh";
  if (cyrillic > 0 && cyrillic >= latin) return "ru";
  return "en";
}
