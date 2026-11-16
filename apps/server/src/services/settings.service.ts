import { findSettings, upsertSetting } from "../repositories/misc.repository";

/** App-wide settings persisted in the settings table. Complex values
 *  are JSON-encoded; credential values are masked on read (see
 *  MASKED_KEYS) and a masked value on update means "unchanged". */

export interface GlossaryEntry {
  src: string;
  dst: string;
}

export interface Settings {
  allowRegistration: boolean;
  /** Extra translation targets beyond the always-on zh<->en pair
   *  (subset of EXTRA_LANGS). */
  translateEnabledLangs: string[];
  /** Fallback chain order; unconfigured members are skipped. */
  translateBackendOrder: string[];
  /** Translation pacing (units/min). */
  translateRatePerMin: number;
  /** Domain glossary injected into LLM translation prompts. */
  translateGlossary: GlossaryEntry[];
  translateDeeplKey: string;
  translateDeeplPro: boolean;
  translateBaiduAppid: string;
  translateBaiduKey: string;
  translateGoogleKey: string;
  translateLibreUrl: string;
  translateLibreKey: string;
}

/** Languages admin can enable beyond zh/en. */
export const EXTRA_LANGS = ["ja", "ko", "de", "fr", "ru", "es"] as const;
export const BASE_LANGS = ["zh", "en"] as const;

const SECRET = "__set__";
const MASKED_KEYS = [
  "translateDeeplKey",
  "translateBaiduAppid",
  "translateBaiduKey",
  "translateGoogleKey",
  "translateLibreKey",
] as const;

const DEFAULTS: Settings = {
  allowRegistration: true,
  translateEnabledLangs: [],
  translateBackendOrder: ["llm", "deepl", "baidu", "google", "libre"],
  translateRatePerMin: 30,
  translateGlossary: [],
  translateDeeplKey: "",
  translateDeeplPro: false,
  translateBaiduAppid: "",
  translateBaiduKey: "",
  translateGoogleKey: "",
  translateLibreUrl: "",
  translateLibreKey: "",
};

function decodeValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** All translation target languages for a settings snapshot: zh/en are
 *  always on (bidirectional), extras come from the checkbox list. */
export function targetLangsOf(settings: Settings): string[] {
  const extras = settings.translateEnabledLangs.filter((l) =>
    (EXTRA_LANGS as readonly string[]).includes(l),
  );
  return [...BASE_LANGS, ...extras];
}

export async function getSettings(): Promise<Settings> {
  const rows = await findSettings();
  const out: Settings = { ...DEFAULTS };
  for (const row of rows) {
    switch (row.key) {
      case "allowRegistration":
        out.allowRegistration = row.value === "true";
        break;
      case "translateEnabledLangs":
        out.translateEnabledLangs = decodeValue(row.value, []);
        break;
      case "translateBackendOrder":
        out.translateBackendOrder = decodeValue(
          row.value,
          DEFAULTS.translateBackendOrder,
        );
        break;
      case "translateRatePerMin":
        out.translateRatePerMin = decodeValue(
          row.value,
          DEFAULTS.translateRatePerMin,
        );
        break;
      case "translateGlossary":
        out.translateGlossary = decodeValue(row.value, []);
        break;
      case "translateDeeplPro":
        out.translateDeeplPro = row.value === "true";
        break;
      default:
        if (row.key in out) {
          (out as unknown as Record<string, string>)[row.key] = row.value;
        }
        break;
    }
  }
  return out;
}

/** Masked view for the admin API: secrets show only whether set. */
export function maskSettings(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  for (const key of MASKED_KEYS) {
    const v = settings[key];
    out[key] = v ? SECRET : "";
  }
  return out;
}

/** Persist a patch. Masked secret values are treated as "unchanged"
 *  (the UI sends the mask back when the field was not edited). */
export async function updateSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((MASKED_KEYS as readonly string[]).includes(key) && value === SECRET) {
      continue;
    }
    const encoded =
      typeof value === "boolean"
        ? String(value)
        : typeof value === "number"
          ? JSON.stringify(value)
          : Array.isArray(value) || typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    await upsertSetting(key, encoded);
  }
  return getSettings();
}
