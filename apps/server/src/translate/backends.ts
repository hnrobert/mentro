import { create } from "@bufbuild/protobuf";
import {
  TranslateBackendSchema,
  type TranslateBackend,
  TranslateBaiduSchema,
  TranslateDeeplSchema,
  TranslateGoogleSchema,
  TranslateLibreSchema,
  TranslateLlmSchema,
} from "@mentro/protocol";
import { translateLlmConfig } from "../lib/llm";
import type { Settings } from "../services/settings.service";

/** Resolve the ordered backend chain from settings + env. Unconfigured
 *  members are skipped. Each entry carries the proto oneof value and
 *  the segment batch size the caller should use for it. */

export interface ResolvedBackend {
  name: string;
  batchSize: number;
  build: () => TranslateBackend;
}

export function resolveBackends(settings: Settings): ResolvedBackend[] {
  const out: ResolvedBackend[] = [];
  for (const name of settings.translateBackendOrder) {
    switch (name) {
      case "llm": {
        const cfg = translateLlmConfig();
        if (!cfg) break;
        const extraJson = (process.env.MENTRO_TRANSLATE_LLM_EXTRA ?? "").trim();
        out.push({
          name: "llm",
          batchSize: 8,
          build: () =>
            create(TranslateBackendSchema, {
              kind: {
                case: "llm",
                value: create(TranslateLlmSchema, {
                  baseUrl: cfg.baseUrl,
                  apiKey: cfg.apiKey,
                  model: cfg.model,
                  extraJson,
                }),
              },
            }),
        });
        break;
      }
      case "deepl":
        if (!settings.translateDeeplKey) break;
        out.push({
          name: "deepl",
          batchSize: 24,
          build: () =>
            create(TranslateBackendSchema, {
              kind: {
                case: "deepl",
                value: create(TranslateDeeplSchema, {
                  key: settings.translateDeeplKey,
                  pro: settings.translateDeeplPro,
                }),
              },
            }),
        });
        break;
      case "baidu":
        if (!settings.translateBaiduAppid || !settings.translateBaiduKey) break;
        out.push({
          name: "baidu",
          batchSize: 16,
          build: () =>
            create(TranslateBackendSchema, {
              kind: {
                case: "baidu",
                value: create(TranslateBaiduSchema, {
                  appid: settings.translateBaiduAppid,
                  key: settings.translateBaiduKey,
                }),
              },
            }),
        });
        break;
      case "google":
        if (!settings.translateGoogleKey) break;
        out.push({
          name: "google",
          batchSize: 32,
          build: () =>
            create(TranslateBackendSchema, {
              kind: {
                case: "google",
                value: create(TranslateGoogleSchema, {
                  key: settings.translateGoogleKey,
                }),
              },
            }),
        });
        break;
      case "libre":
        if (!settings.translateLibreUrl) break;
        out.push({
          name: "libre",
          batchSize: 16,
          build: () =>
            create(TranslateBackendSchema, {
              kind: {
                case: "libre",
                value: create(TranslateLibreSchema, {
                  url: settings.translateLibreUrl,
                  key: settings.translateLibreKey,
                }),
              },
            }),
        });
        break;
      default:
        break;
    }
  }
  return out;
}
