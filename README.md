# Mentro

A self-hosted knowledge base and search platform: parses PPT / PDF / images / videos / documents on disk into unified content units, delivers millisecond local search in any device's browser, and pinpoints the exact slide, page, or second.

```text
Browser (Vue 3 SPA) ── HTTP/WS ──> mentro-server (Node 24, TypeORM + SQLite)
                                        │ spawn + protobuf over stdio
                                  mentro-worker (Rust CLI)
                                        │ poppler / ffmpeg / Gotenberg / PaddleOCR / faster-whisper / bge-m3 containers
```

Full design document: [docs/plan.md](docs/plan.md).

## Quick Start (Development)

Prerequisites: Node 24, pnpm, Rust 1.93.1, [buf](https://buf.build), poppler, ffmpeg, qpdf (optional: Docker for the office-rendering, OCR, transcription, and embedding containers).

```bash
pnpm install          # install dependencies (native modules argon2/better-sqlite3 built automatically)
pnpm gen:proto        # generate worker protocol (TS types + descriptor)
pnpm build:worker     # cargo release build mentro-worker -> bin/
pnpm dev              # start server (127.0.0.1:37797) and web (Vite) concurrently
```

Common commands:

```bash
mentro-worker doctor  # probe external tool availability (bin/mentro-worker doctor)
pnpm lint             # eslint + prettier --check
pnpm test             # vitest (per-package)
```

## Structure

```text
apps/server     Node 24 + Fastify + TypeORM (coordination layer, only child process is the worker)
apps/web        Vue 3 + Vite + Tailwind v4 + shadcn-vue
packages/protocol  generated worker protocol types + REST/WS zod schemas
proto/          buf-managed worker protocol .proto (the only committed protocol source)
rust/           Cargo workspace (mentro-worker: extraction / scanning / rendering / OCR / container management)
```

## Intelligence Layer (M6)

Three optional backends, each lazily started and gracefully degrading —
the text index never depends on them:

| Feature              | Backend                                                            | Off switch / override                         |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Speech-to-text       | `mentro-whisper` container (faster-whisper)                        | `MENTRO_WHISPER=off` · `MENTRO_WHISPER_URL=…` |
| Semantic search      | `mentro-embed` container (bge-m3, OpenAI-compatible `/embeddings`) | `MENTRO_EMBED=off` · `MENTRO_EMBED_URL=…`     |
| Selected-page export | qpdf (PDF split/merge) + in-process OOXML surgery (PPTX)           | requires `qpdf` on PATH                       |

Search merges keyword (FTS5) and semantic rankings by default
(`GET /api/search?mode=hybrid|fts|semantic`).

### Agent Tool API

Agents read and operate through HTTP only — never the file system:

- HTTP: `/api/agent/search`, `/api/agent/assets/:id`, `/api/agent/units/:id`,
  `/api/agent/context`, `/api/agent/export`, `/api/agent/transcribe/:assetId`
  (JWT auth, same as the UI).
- MCP: `POST /mcp` (streamable HTTP, stateless) exposing the same operations
  as MCP tools. Attach from Claude Code:

```bash
claude mcp add --transport http mentro http://127.0.0.1:37797/mcp \
  --header "Authorization: Bearer <access-token>"
```

### Export

`POST /api/export { units: [{assetId, ordinal}], format: "pdf"|"pptx" }`
composes a new document from selected pages/slides (PDF merges across
files via qpdf; PPTX cuts slides from one deck with byte-verbatim part
copying), then `GET /api/export/:id/file` downloads the artifact.

## Deployment (docker compose)

The full stack — app (server + worker pool) plus Gotenberg, PaddleOCR,
faster-whisper, and bge-m3 sidecars — runs from one command:

```bash
docker compose up -d --build
# optionally index an existing directory (read-only mount):
MENTRO_SOURCES_DIR=/path/to/corpus docker compose up -d
```

The app binds `0.0.0.0:37797`, so after startup it is reachable from the
LAN at `http://<host-ip>:37797` (find the address with `hostname -I`).
First use: open the URL, register the first account (becomes admin), and
let the pipeline index; sidecar models download into named volumes on
first boot (bge-m3 ≈ 2.2 GB).

Operational notes learned the hard way:

- **Protocol artifacts**: `buf generate` uses BSR remote plugins, which
  TLS-intercepting networks block inside containers — the image copies
  host-generated `packages/protocol/{gen,descriptor.bin}` when present
  (run `pnpm gen:proto` before `docker compose build`) and regenerates
  only when absent.
- **Gotenberg timeout**: the worker pool fires LibreOffice conversions in
  parallel; the default 30s api timeout 503s on queued large decks, so
  compose sets `GOTENBERG_API_TIMEOUT=600s`.
- **Reverse proxy**: for anything beyond the trusted LAN, put Caddy/nginx
  in front for TLS. Scale evaluation of the browser search engine lives
  in [docs/search-evaluation.md](docs/search-evaluation.md).
