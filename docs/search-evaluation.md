# Search Scale Evaluation (§9.2, M6)

Date: 2026-08-31 · Corpus: main dev DB snapshot (251 assets, ref/ + uploads)

## Trigger thresholds (docs/plan.md §9.2)

| #   | Trigger                | Threshold | Measured         | Verdict |
| --- | ---------------------- | --------- | ---------------- | ------- |
| 1   | content units          | > 50 000  | 964              | far off |
| 2   | bundle size (gzip)     | > 50 MB   | 0.40 MB (416 KB) | far off |
| 3   | cold-start index build | > 500 ms  | **~1.0–1.3 s**   | tripped |

## Measurements

- Server bundle build + transfer (`GET /api/index`, gzip): **40–70 ms** round
  trip, 416 KB gzipped (4.3 MB raw JSON).
- Browser-side cold build (MiniSearch `replaceAll` + one query, Node 24,
  M-series, after JIT warm-up): **1.0–1.3 s** for 964 units / 1.35 MB text.
  In the browser, add `JSON.parse` of the raw bundle (~50–100 ms).

Where the time goes: the CJK bigram tokenizer. MiniSearch's default
(whitespace) tokenizer builds the same corpus in ~270 ms, but that path
indexes whole Chinese lines as single tokens — i.e. it is not a real
alternative. Bigrams produce ~450 k token insertions, which is the cost.

## What M6 already did about it

- **Token dedup per field** (`apps/web/src/search/minisearch.ts`): CJK body
  text repeats words heavily; duplicate bigrams only inflate the index.
  Deduplicating tokens cut cold builds by ~33% (1.4 s → ~1.0 s) with no
  observable relevance change (tf is ~constant under AND semantics).
- **Measurement harness**: `apps/web/src/search/cold-build.bench.test.ts`
  (run with `MENTRO_EVAL_BUNDLE=<bundle.json>`) and
  `apps/server/scripts/search-eval.ts` re-run these numbers at any time
  against a DB snapshot.

## Verdict and path

Trigger #3 is tripped at the current corpus size; #1 and #2 are far off.
Search _speed_ is unaffected (queries run in single-digit ms) — the cost is
paid once per page load, and it will grow linearly with units.

**Decision: adopt Path A (sql.js FTS5 WASM) as the next engine, scheduled
as its own milestone after M6.** Reasons:

1. The server already produces and maintains an FTS5 database — Path A
   exports the existing `units_fts` file and queries it in the browser,
   replacing the browser-side build entirely (the 1 s build becomes a
   fetch + ~50 ms open).
2. It removes the double-implementation risk: browser and server would
   share one tokenizer (jieba server-side FTS indexing already segments
   identically) instead of MiniSearch bigrams approximating jieba.
3. Path B (Tantivy → WASM) stays the long-term direction (§14), but it is
   a bigger build and still needs the same FTS5-export plumbing as an
   intermediate step to prove out the UI integration
   (`engine.ts` isolates the swap).

Not urgent: the interface seam (`SearchEngine`) is already in place, and
the tripped trigger costs one second per page load at the current corpus,
which is tolerable until the engine swap lands.

## Re-evaluate when

Any of: units > 5 000, bundle > 5 MB, or the engine swap ships. Re-run
both harnesses and append a dated section here.
