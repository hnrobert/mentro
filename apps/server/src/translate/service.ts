import { ulid } from "ulid";
import { create } from "@bufbuild/protobuf";
import { TranslateRequestSchema } from "@mentro/protocol";
import { AppDataSource } from "../db/data-source";
import { Job, UnitTranslation } from "../db/entities";
import {
  getSettings,
  targetLangsOf,
  type Settings,
} from "../services/settings.service";
import { publish } from "../lib/bus";
import {
  invalidateEmbeddingCache,
  embedTexts,
  unitEmbeddingInput,
  storeTranslationEmbeddings,
} from "../search/embeddings";
import { ftsReplaceTranslations } from "../search/fts";
import type { WorkerClient } from "../worker/client";
import { detectScript } from "./lang";
import { resolveBackends, type ResolvedBackend } from "./backends";
import { buildTranslatePrompt } from "./prompt";
import * as pacer from "./pacer";

/** Translation job flow. Job kind "translate", payload { lang, assetId? }.
 *  assetId set -> translate that asset's units (post-extract follow-up);
 *  unset -> global backfill, self-chained in chunks of CHUNK units so a
 *  job never holds a worker for hours. Credentials are read from
 *  settings at dispatch time and NEVER persisted in the payload. */

const CHUNK = 100;
/** Per-unit text cap for translation (chars). Search value lives in
 *  the head; long tails only blow the gateway's per-request timeout
 *  (a 12k-char segment translates for minutes and 504s). */
const TEXT_CAP = 3_000;
/** Per-REQUEST char budget. Long units make huge batches; gateways
 *  504 when a single non-streaming completion runs minutes — keep each
 *  request small enough to answer in seconds. */
const BATCH_CHAR_BUDGET = 4_000;

interface Segment {
  unit: UnitRow;
  field: "title" | "text";
}

/** Take up to maxCount segments from segs[i] within the char budget —
 *  always at least one (a single oversized segment still goes out
 *  alone rather than never). */
function takeBatch(segs: Segment[], i: number, maxCount: number): Segment[] {
  const out: Segment[] = [];
  let chars = 0;
  for (let k = i; k < segs.length && out.length < maxCount; k++) {
    const seg = segs[k];
    const len =
      (seg.field === "title" ? seg.unit.title : seg.unit.text)?.length ?? 0;
    if (out.length > 0 && chars + len > BATCH_CHAR_BUDGET) break;
    out.push(seg);
    chars += len;
  }
  return out;
}

interface TranslatePayload {
  lang: string;
  assetId?: string;
}

interface UnitRow {
  id: string;
  asset_id: string;
  title: string | null;
  text: string | null;
}

export async function enqueueTranslateJob(opts: {
  lang: string;
  assetId?: string;
}): Promise<void> {
  const jobRepo = AppDataSource.getRepository(Job);
  // Payload-aware dedupe: never two active jobs for the same
  // (lang, assetId) pair — the existing enqueueOnce matches only
  // kind+assetId and would drop the second language.
  const existing = await jobRepo
    .createQueryBuilder("j")
    .where("j.kind = :kind", { kind: "translate" })
    .andWhere("j.status IN (:...st)", { st: ["pending", "running"] })
    .andWhere("j.asset_id IS :asset", { asset: opts.assetId ?? null })
    .andWhere("j.payload LIKE :langPattern", {
      langPattern: `%"lang":"${opts.lang}"%`,
    })
    .getOne();
  if (existing) return;
  await jobRepo.insert({
    id: ulid(),
    assetId: opts.assetId ?? null,
    kind: "translate",
    payload: JSON.stringify({
      lang: opts.lang,
      ...(opts.assetId ? { assetId: opts.assetId } : {}),
    }),
    status: "pending",
  });
}

function missingUnitsQuery(
  lang: string,
  assetId: string | null,
  limit: number,
): Promise<UnitRow[]> {
  const params: unknown[] = [lang];
  let assetSql = "";
  if (assetId) {
    assetSql = " AND cu.asset_id = ?";
    params.push(assetId);
  }
  params.push(limit);
  return AppDataSource.query(
    `SELECT cu.id, cu.asset_id, cu.title, cu.text
     FROM content_units cu
     LEFT JOIN unit_translations ut ON ut.unit_id = cu.id AND ut.lang = ?
     WHERE ut.unit_id IS NULL
       AND (COALESCE(cu.text, '') != '' OR COALESCE(cu.title, '') != '')${assetSql}
     ORDER BY cu.rowid
     LIMIT ?`,
    params,
  ) as Promise<UnitRow[]>;
}

async function countMissing(lang: string, assetId?: string): Promise<number> {
  const rows = await missingUnitsQuery(lang, assetId ?? null, 1_000_000);
  return rows.length;
}

/** Run one translate job (dispatcher entry point). */
export async function runTranslateJob(
  job: Job,
  worker: WorkerClient,
): Promise<void> {
  const payload = ((): TranslatePayload => {
    try {
      return JSON.parse(job.payload ?? "{}") as TranslatePayload;
    } catch {
      return { lang: "" };
    }
  })();
  const lang = payload.lang;
  if (!lang) throw new Error("translate job missing lang");

  const settings = await getSettings();
  const backends = resolveBackends(settings);
  if (backends.length === 0) {
    throw new Error(
      "no translation backend configured (set MENTRO_TRANSLATE_* or an API key in settings)",
    );
  }
  pacer.setRate(settings.translateRatePerMin);

  const isGlobal = !payload.assetId;
  const targets = await missingUnitsQuery(
    lang,
    payload.assetId ?? null,
    isGlobal ? CHUNK : 10_000,
  );
  const jobRepo = AppDataSource.getRepository(Job);
  const total = targets.length;
  let done = 0;
  let lastError: string | null = null;

  // Split into translate-worthy units vs same-source skips.
  const pending: UnitRow[] = [];
  for (const u of targets) {
    const source = detectScript(`${u.title ?? ""} ${u.text ?? ""}`);
    if (source === null || source === lang) {
      await AppDataSource.getRepository(UnitTranslation).upsert(
        {
          unitId: u.id,
          lang,
          assetId: u.asset_id,
          sourceLang: source,
          title: null,
          text: null,
          status: "skipped",
          backend: null,
        },
        ["unitId", "lang"],
      );
      done++;
      continue;
    }
    pending.push(u);
  }

  // Flatten [title?, text] per unit; remember the mapping back.
  const segs: Array<{ unit: UnitRow; field: "title" | "text" }> = [];
  for (const u of pending) {
    if (u.title?.trim()) segs.push({ unit: u, field: "title" });
    const body = (u.text ?? "").slice(0, TEXT_CAP);
    if (body.trim()) segs.push({ unit: u, field: "text" });
  }

  let cursor = 0;
  outer: for (const backend of backends) {
    // Try the WHOLE remaining set with this backend; on any batch
    // failure fall through to the next chain member (fresh cursor).
    let i = cursor;
    while (i < segs.length) {
      const batch = takeBatch(segs, i, backend.batchSize);
      try {
        await pacer.acquire(batch.length);
        const translations = await translateBatch(
          batch,
          backend,
          lang,
          worker,
          settings,
        );
        await persistBatch(batch, translations, lang, backend.name, worker);
        i += batch.length;
        cursor = i;
        done += batch.length;
        await jobRepo.update(job.id, {
          payload: JSON.stringify({ lang, done, total }),
        });
      } catch (err) {
        lastError = String(err instanceof Error ? err.message : err);
        console.warn(
          `[translate] backend ${backend.name} failed at ${i}/${segs.length}: ${lastError}`,
        );
        continue outer; // next backend continues from cursor
      }
    }
    break; // backend completed everything
  }

  if (cursor < segs.length) {
    throw new Error(
      `all translation backends failed (${Math.max(1, backends.length)} tried); last: ${lastError ?? "unknown"}`,
    );
  }

  invalidateEmbeddingCache();
  publish({ event: "index.changed" });

  // Self-chaining global backfill.
  if (isGlobal && (await countMissing(lang)) > 0) {
    await enqueueTranslateJob({ lang });
  }
}

async function translateBatch(
  batch: Array<{ unit: UnitRow; field: "title" | "text" }>,
  backend: ResolvedBackend,
  lang: string,
  worker: WorkerClient,
  settings: Settings,
): Promise<(string | null)[]> {
  const texts = batch.map(({ unit, field }) =>
    field === "title"
      ? (unit.title ?? "")
      : (unit.text ?? "").slice(0, TEXT_CAP),
  );
  const source = detectScript(texts.join(" ")) ?? "";
  const systemPrompt =
    backend.name === "llm"
      ? buildTranslatePrompt(
          source,
          lang,
          texts.length,
          settings.translateGlossary,
        )
      : "";
  const req = create(TranslateRequestSchema, {
    texts,
    sourceLang: source,
    targetLang: lang,
    systemPrompt,
    backend: backend.build(),
  });
  // Gateways intermittently 504 on thinking-model batches; a short
  // in-chain retry absorbs that without falling through the whole
  // backend chain (which would end the job attempt).
  const DELAYS_MS = [0, 3_000, 8_000];
  let lastErr: unknown = null;
  for (const delay of DELAYS_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      // Must exceed the worker's internal LLM read timeout (300s) —
      // killing the RPC early aborts streams that would have finished
      // ("worker request timed out" burned every retry otherwise).
      const resp = await worker.translate(req, 360_000);
      if (!resp.ok || resp.result?.case !== "translateResult") {
        throw new Error(resp.error?.message ?? "translate rpc failed");
      }
      const translations = resp.result.value.translations;
      if (translations.length !== texts.length) {
        throw new Error(`backend ${backend.name}: count mismatch`);
      }
      return translations;
    } catch (err) {
      lastErr = err;
    }
  }
  // Batch keeps failing (a poison batch: some content reliably makes
  // the model return garbage). Split to size 1 — healthy segments
  // survive, poison segments surface individually.
  return translateSolo(batch, backend, lang, worker, settings);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Per-segment fallback; returns null-padded results and marks the
 *  hopeless segments skipped so the backfill converges past them. */
async function translateSolo(
  batch: Segment[],
  backend: ResolvedBackend,
  lang: string,
  worker: WorkerClient,
  settings: Settings,
): Promise<(string | null)[]> {
  console.warn(
    `[translate] batch failed (${backend.name}); splitting ${batch.length} segments`,
  );
  const out: (string | null)[] = [];
  const repo = AppDataSource.getRepository(UnitTranslation);
  for (let i = 0; i < batch.length; i++) {
    const seg = batch[i];
    const text =
      seg.field === "title"
        ? (seg.unit.title ?? "")
        : (seg.unit.text ?? "").slice(0, TEXT_CAP);
    const source = detectScript(text) ?? "";
    const systemPrompt =
      backend.name === "llm"
        ? buildTranslatePrompt(source, lang, 1, settings.translateGlossary)
        : "";
    let ok: string | null = null;
    for (const delay of [0, 2_000]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await pacer.acquire(1);
      try {
        const resp = await worker.translate(
          create(TranslateRequestSchema, {
            texts: [text],
            sourceLang: source,
            targetLang: lang,
            systemPrompt,
            backend: backend.build(),
          }),
          360_000,
        );
        if (
          resp.ok &&
          resp.result?.case === "translateResult" &&
          resp.result.value.translations.length === 1
        ) {
          ok = resp.result.value.translations[0];
          break;
        }
      } catch {
        /* try next delay */
      }
    }
    if (ok !== null) {
      out.push(ok);
      continue;
    }
    // Poison segment: record it as skipped so the missing-count query
    // converges and the chain proceeds past it.
    console.warn(
      `[translate] poison segment skipped (${seg.unit.id}.${seg.field})`,
    );
    await repo.upsert(
      {
        unitId: seg.unit.id,
        lang,
        assetId: seg.unit.asset_id,
        sourceLang: detectScript(text),
        title: null,
        text: null,
        status: "skipped",
        backend: "poison",
      },
      ["unitId", "lang"],
    );
    out.push(null);
  }
  return out;
}

/** Store translations + FTS rows + embeddings for one finished batch. */
async function persistBatch(
  batch: Array<{ unit: UnitRow; field: "title" | "text" }>,
  translations: Array<string | null>,
  lang: string,
  backendName: string,
  worker: WorkerClient,
): Promise<void> {
  // Merge title/text segments back per unit.
  const byUnit = new Map<
    string,
    { title: string | null; text: string | null }
  >();
  batch.forEach((seg, i) => {
    // null = poison segment (already recorded skipped) — drop it.
    if (translations[i] === null) return;
    const cur = byUnit.get(seg.unit.id) ?? { title: null, text: null };
    if (seg.field === "title") cur.title = translations[i];
    else cur.text = translations[i];
    byUnit.set(seg.unit.id, cur);
  });

  const repo = AppDataSource.getRepository(UnitTranslation);
  const rows = [...byUnit.entries()].map(([unitId, t]) => ({
    unitId,
    lang,
    assetId: batch.find((s) => s.unit.id === unitId)!.unit.asset_id,
    sourceLang: detectScript(
      batch
        .filter((s) => s.unit.id === unitId)
        .map((s) => (s.field === "title" ? s.unit.title : s.unit.text) ?? "")
        .join(" "),
    ),
    title: t.title,
    text: t.text,
    status: "ok",
    backend: backendName,
  }));
  await repo.upsert(rows, ["unitId", "lang"]);
  await ftsReplaceTranslations(
    rows.map((r) => ({
      unitId: r.unitId,
      lang,
      title: r.title ?? "",
      text: r.text ?? "",
    })),
  );

  // Embed the translated units (best-effort: translations commit even
  // when the embed sidecar is down — same degradation as runEmbed).
  try {
    const inputs = rows.map((r) => unitEmbeddingInput(r.title, r.text));
    const vectors = await embedTexts(worker, inputs);
    if (vectors.length === inputs.length) {
      await storeTranslationEmbeddings(
        rows.map((r, i) => ({
          unitId: r.unitId,
          lang,
          assetId: r.assetId,
          vector: vectors[i],
        })),
      );
    }
  } catch (err) {
    console.warn(`[translate] embedding skipped: ${String(err)}`);
  }
}

/** Boot-time (and settings-change) backfill: one guarded chunk job per
 *  enabled language with untranslated units. Never blocks boot. */
export async function scheduleTranslationBackfill(): Promise<void> {
  try {
    const settings = await getSettings();
    if (resolveBackends(settings).length === 0) {
      console.log("[translate] no backend configured — backfill skipped");
      return;
    }
    for (const lang of targetLangsOf(settings)) {
      const missing = await countMissing(lang);
      if (missing > 0) {
        console.log(`[translate] backfill ${lang}: ${missing} units`);
        await enqueueTranslateJob({ lang });
      }
    }
  } catch (err) {
    console.warn(`[translate] backfill scheduling failed: ${String(err)}`);
  }
}

/** Stalled-backlog reaper. Failed-out jobs (3 attempts exhausted, e.g.
 *  a flaky gateway evening) leave NOTHING running — until a restart or
 *  manual click the pipeline sits dead. This sweeper requeues a
 *  language when it has untranslated units, no active job, and its
 *  last job has been quiet for RETRY_QUIET_MS (so a down gateway is
 *  probed once per interval, not hammered). */
const SWEEP_MS = 10 * 60 * 1000;
const RETRY_QUIET_MS = 10 * 60 * 1000;

export function startTranslationSweeper(): void {
  const sweep = async (): Promise<void> => {
    try {
      const settings = await getSettings();
      if (resolveBackends(settings).length === 0) return;
      const jobRepo = AppDataSource.getRepository(Job);
      const active = await jobRepo
        .createQueryBuilder("j")
        .where("j.kind = :kind", { kind: "translate" })
        .andWhere("j.status IN (:...st)", { st: ["pending", "running"] })
        .getMany();
      const activeLangs = new Set(
        active.map(
          (j) => (JSON.parse(j.payload ?? "{}") as TranslatePayload).lang || "",
        ),
      );
      for (const lang of targetLangsOf(settings)) {
        if (activeLangs.has(lang)) continue;
        const missing = await countMissing(lang);
        if (missing === 0) continue;
        const last = await jobRepo
          .createQueryBuilder("j")
          .where("j.kind = :kind", { kind: "translate" })
          .andWhere("j.payload LIKE :p", { p: `%"lang":"${lang}"%` })
          .orderBy("j.updated_at", "DESC")
          .getOne();
        if (
          last &&
          Date.now() - new Date(last.updatedAt).getTime() < RETRY_QUIET_MS
        ) {
          continue;
        }
        console.log(
          `[translate] sweeper: requeue ${lang} (${missing} missing, last job ${last?.status ?? "none"})`,
        );
        await enqueueTranslateJob({ lang });
      }
    } catch (err) {
      console.warn(`[translate] sweeper failed: ${String(err)}`);
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  // First sweep shortly after boot (lets the boot backfill settle first).
  setTimeout(() => void sweep(), 2 * 60 * 1000).unref();
}

/** Settings-page progress: per-language counts + job states. `done`
 *  counts translated + same-source skips so the bar can reach 100% —
 *  translated alone never does (every corpus has units whose source
 *  language IS the target, e.g. English originals need no 'en' row). */
export async function translateStatus(): Promise<{
  langs: Array<{
    lang: string;
    total: number;
    translated: number;
    skipped: number;
    done: number;
    missing: number;
    complete: boolean;
    pending: boolean;
    running: boolean;
  }>;
}> {
  const settings = await getSettings();
  const langs = targetLangsOf(settings);
  const jobs = await AppDataSource.getRepository(Job)
    .createQueryBuilder("j")
    .where("j.kind = :kind", { kind: "translate" })
    .andWhere("j.status IN (:...st)", { st: ["pending", "running"] })
    .getMany();
  const langOf = (payload: string | null): string | null => {
    try {
      const p = JSON.parse(payload ?? "{}") as TranslatePayload;
      return p.lang || null;
    } catch {
      return null;
    }
  };
  const pendingLangs = new Set(
    jobs.filter((j) => j.status === "pending").map((j) => langOf(j.payload)),
  );
  const runningLangs = new Set(
    jobs.filter((j) => j.status === "running").map((j) => langOf(j.payload)),
  );
  const out = [];
  for (const lang of langs) {
    const row = (
      await AppDataSource.query(
        `SELECT
           (SELECT COUNT(*) FROM content_units
              WHERE COALESCE(text,'') != '' OR COALESCE(title,'') != '') AS total,
           (SELECT COUNT(*) FROM unit_translations WHERE lang = ? AND status = 'ok') AS translated,
           (SELECT COUNT(*) FROM unit_translations WHERE lang = ? AND status = 'skipped') AS skipped`,
        [lang, lang],
      )
    )[0] as { total: number; translated: number; skipped: number };
    const missing = await countMissing(lang);
    const done = Math.min(row.total, row.translated + row.skipped);
    out.push({
      lang,
      total: row.total,
      translated: row.translated,
      skipped: row.skipped,
      done,
      missing,
      complete: missing === 0,
      pending: pendingLangs.has(lang),
      running: runningLangs.has(lang),
    });
  }
  return { langs: out };
}
