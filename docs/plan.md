# Mentro Project Plan

> Status: Draft v1 (2026-08-25)
> Background: the original architecture discussion lives in [docs/conversation-notes.md](docs/conversation-notes.md).
> Test corpus: `ref/` (168 files / 2.6 GB: 71 PDF, 58 PNG, 19 PPTX, 6 JPG, LaTeX source files, 1 DOCX), gitignored, local use only.

## 1. Project Positioning

Mentro is a **self-hosted asset indexing and retrieval service**: it runs on one machine (workstation / home server / NAS) and parses the PPT / PDF / image / video / document files on its disks into unified Content Units; browsers on any device reach it remotely, search locally in milliseconds, and pinpoint an exact PPT slide / PDF page / video second. It also reserves architectural slots for later OCR, Embedding, and Agent capabilities. A single-machine localhost mode is merely one deployment special case of it.

Core capabilities:

- Server scans the configured root directories, with blake3 content hashing + MIME sniffing and incremental rescans
- **Asset pool (pool) dual-channel ingestion**: initialization mounts (`MENTRO_SOURCES` auto-registered at startup) + browser uploads (`POST /api/upload` → `data/pool/`); uploaded archives are automatically unpacked into the pool
- Extraction down to content-unit granularity: `pdf → page`, `pptx → slide`, `video → time segment`
- **Search happens in the browser** (the index bundle is delivered to each client for local retrieval — zero per-keystroke cost on the server, naturally suited to multiple devices)
- Click any result on any device to jump straight into a preview: pdf.js page jumps, video seek to a time point (HTTP Range streaming), slide thumbnails
- File changes → incremental extraction → WS index deltas pushed to all online clients
- Deployment-as-a-service: **user accounts and JWT authentication** (the first registrant becomes the super administrator), concurrent multi-device access, docker compose one-command startup

Non-goals (explicitly out of scope for the current version):

- No public-internet SaaS / multi-tenancy / cloud sync
- No third-party login (OAuth/OIDC/SSO) — username + password + JWT; external IdPs deferred until needed
- No hand-rolled file format parsers; all parsing is delegated to mature external tools
- Not a file manager (it does not move / rename / delete user files)

## 2. Architecture Overview

```text
                    ┌────────────────────────────────┐
                    │   Browser (any device)         │
                    │  Vue 3 SPA                     │
                    │  ├── Search UI (local search)  │
                    │  ├── Asset Detail / Preview    │
                    │  └── Settings / Jobs           │
                    └───────────────┬────────────────┘
                              HTTP / WS
                    ┌───────────────▼────────────────┐
                    │        mentro-server           │
                    │  Node 24 + TypeScript          │
                    │  (coordination only)           │
                    │  ├── REST API + WebSocket      │
                    │  ├── Sources / Job Queue       │
                    │  ├── SQLite + TypeORM          │
                    │  └── Index Bundle Builder      │
                    │  — spawns the worker only;     │
                    │    does not watch the FS       │
                    └───────────────┬────────────────┘
                     spawn + protobuf over stdio
                    ┌───────────────▼────────────────┐
                    │     mentro-worker (Rust)       │
                    │  sole external integration     │
                    │  point: scan / watch / extract │
                    │  / render / reveal / ocr       │
                    │  ├── built-in: OOXML, text,    │
                    │  │   image                     │
                    │  └── external: poppler,        │
                    │      soffice, ffmpeg           │
                    └───────────────┬────────────────┘
                        docker / podman (from M3)
                    ┌───────────────▼────────────────┐
                    │  PaddleOCR serving container   │
                    │  PaddleX --serve --pipeline OCR│
                    └────────────────────────────────┘
```

Data flow:

```text
Files → scan(Rust) → assets table → job queue → extract(Rust+external tools)
      → content_units table → FTS5(server-side fallback) → Index Bundle
      → Browser local search → results → preview/locate
```

Three layers of responsibility (carried over from the discussion):

| Layer          | Question it answers      | Owner                                                                |
| -------------- | ------------------------ | -------------------------------------------------------------------- |
| Extraction     | What is in the file?     | Rust worker + external tools                                         |
| Index          | Where are those things?  | SQLite + browser index                                               |
| Agent (future) | What does the user want? | Tool User in the TS backend — never touches the file system directly |

### Process boundary (hard constraint)

- **mentro-server (Node)**: only does HTTP/WS, SQLite, job queue, index bundle — spawns no child process other than mentro-worker, never watches the file system directly, and calls no external tools
- **mentro-worker (Rust)**: the single entry point for all third-party interactions — file scanning/watching/hashing, poppler / soffice / ffmpeg, the PaddleOCR container lifecycle, Finder reveal. It is also a self-contained CLI that can be built, tested, and used independently of the server

## 3. Settled Technical Decisions

| Decision point         | Choice                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend framework     | Vue 3 + Vite + TypeScript (SPA)                                                                                                                                                                                                                                                                                               | Purely local tool, no SEO needs, so no Nuxt                                                                                                                                                                                                                           |
| Frontend state / UI    | Pinia + **shadcn-vue** (Reka UI + Tailwind CSS v4)                                                                                                                                                                                                                                                                            | Component source copied into the repo, fully editable; decided by Robert (2026-08-25, replacing Naive UI)                                                                                                                                                             |
| Backend runtime        | **Node.js 24 LTS + pnpm** (`.nvmrc` + engines `24.x`; decided by Robert 2026-08-25)                                                                                                                                                                                                                                           | Matches the personal TS standard; the Bun runtime was dropped, SQLite goes through better-sqlite3                                                                                                                                                                     |
| Backend framework      | Fastify + @fastify/websocket                                                                                                                                                                                                                                                                                                  | Lightweight, good TS support, built-in schema validation                                                                                                                                                                                                              |
| Database               | SQLite + **TypeORM** (<typeorm@1.x>, better-sqlite3 driver) + FTS5                                                                                                                                                                                                                                                            | Single file, synchronous driver suits a local service; entity/migration/DataSource conventions in §5.2; FTS5 as the server-side fallback search                                                                                                                       |
| Database migrations    | TypeORM migrations: `<timestamp>-<PascalCase>.ts`, raw SQL, auto-applied at startup                                                                                                                                                                                                                                           | tsup-built programmatic scripts `migration:generate/run/revert/check` replace the typeorm CLI (its TS loader is incompatible with legacy decorators under Node 24)                                                                                                    |
| Worker protocol        | **Protobuf** (buf manages the .proto; Rust prost / TS `@bufbuild/protobuf`; stdio length-delimited frames; message naming per the proto standard: `*Request/*Response` envelopes, events as `*Message`, `E`-prefixed enums)                                                                                                   | Single schema authority; codegen eliminates drift between the two ends at build time; **all generated artifacts are produced at build time — only .proto is committed**; debugging goes through one-shot CLI subcommands' JSON output                                 |
| Worker binary          | Conventional location `bin/mentro-worker` (gitignored), copied by `pnpm build:worker`; `MENTRO_WORKER_BIN` can override                                                                                                                                                                                                       | Identical across dev / prod / compose                                                                                                                                                                                                                                 |
| Rust worker            | Cargo workspace, long-lived process speaking protobuf over stdio, **the single entry point for all third-party integrations**                                                                                                                                                                                                 | Single-machine parent-child processes; bare protobuf frames suffice, no gRPC / SignalR needed; spawn once, stay resident, zero per-startup cost; the Node side never calls external tools directly                                                                    |
| Content hash           | blake3                                                                                                                                                                                                                                                                                                                        | Hashes GB-scale files far faster than SHA-256, suits large corpora                                                                                                                                                                                                    |
| File type detection    | Content sniffing (`infer` crate) + extension fallback                                                                                                                                                                                                                                                                         | Do not trust extensions                                                                                                                                                                                                                                               |
| ID strategy            | ULID (generated on the TS side, the worker only returns it)                                                                                                                                                                                                                                                                   | Sortable, readable; the DB belongs to TS, the worker stays stateless                                                                                                                                                                                                  |
| PDF tools              | Poppler (`pdftotext` / `pdftoppm` / `pdfinfo`)                                                                                                                                                                                                                                                                                | One `brew install poppler` on macOS gets you everything; mature for both text and rendering                                                                                                                                                                           |
| Office rendering       | **Stock Gotenberg image** (`gotenberg/gotenberg:8.x-libreoffice`, pinned tag; HTTP API, built-in LibreOffice process pool)                                                                                                                                                                                                    | Zero Office dependencies on the host; pooled hot conversions avoid cold starts; same shape as the PaddleOCR container (`/health` + POST), unified under the §7.6 model; note the font stack is slimmed starting 8.30 — pinned tag + ref/ regression as the safety net |
| Asset cutting / export | PPTX page selection = **Rust OOXML surgery** (parts copied verbatim, fidelity preserved); PDF page selection/merge = pure Rust (`lopdf`) or qpdf                                                                                                                                                                              | Surgery is more faithful than a UNO save (no re-serialization); merging PPTX across files is a hard case — PDF composition is the fallback                                                                                                                            |
| Media tools            | FFmpeg / ffprobe                                                                                                                                                                                                                                                                                                              | Metadata + frame extraction                                                                                                                                                                                                                                           |
| File watching          | Rust `notify` crate (worker `watch` action)                                                                                                                                                                                                                                                                                   | Third-party interactions converge in Rust; Node never touches the file system                                                                                                                                                                                         |
| Finder reveal          | worker `reveal` action                                                                                                                                                                                                                                                                                                        | Platform differences stay in Rust (macOS `open -R`)                                                                                                                                                                                                                   |
| OCR                    | **Official PaddleOCR serving container** (PaddleX `--serve --pipeline OCR`, PP-OCRv5 Chinese-English models)                                                                                                                                                                                                                  | Chinese recognition far better than tesseract; heavy Python dependencies sealed inside the image; the worker manages the container lifecycle and degrades gracefully when the runtime is missing (§7.6)                                                               |
| Browser search V1      | MiniSearch                                                                                                                                                                                                                                                                                                                    | Lightweight, field weighting, fuzzy, prefix; FlexSearch has poor type quality                                                                                                                                                                                         |
| Browser search upgrade | SQLite WASM FTS5 or tantivy-wasm                                                                                                                                                                                                                                                                                              | Trigger conditions in §9                                                                                                                                                                                                                                              |
| Package manager        | pnpm (workspace monorepo), `packageManager` pinned                                                                                                                                                                                                                                                                            | Personal TS standard                                                                                                                                                                                                                                                  |
| Network & auth         | **JWT (HMAC-SHA256) + refresh sessions**: login issues an access token (1h) + a revocable refresh (30 days, DB session table, rotated on every refresh); HTTP `Authorization: Bearer`, WS `?token=`; passwords **argon2id**; login rate limiting; binds 127.0.0.1:37797 by default (`MENTRO_PORT`/`MENTRO_BIND` can override) | Each device logs in and holds its own token; an admin password reset revokes all of that user's sessions; files are exposed only by assetId, no path parameters accepted (anti-traversal); the JWT secret is generated into `data/` on first startup                  |
| Chinese tokenization   | **jieba-wasm** (server-side pre-tokenization before FTS5 ingestion + the same wasm for the browser MiniSearch index/query)                                                                                                                                                                                                    | Both ends tokenize identically; Chinese recall is markedly better than per-character tokens; no native dependencies                                                                                                                                                   |
| Scan ignore rules      | Built-in rules (`.git`, `node_modules`, hidden directories, `data/`, `target/`, AppleDouble `._*`) + per-source-root `.mentroignore` (gitignore-style globs)                                                                                                                                                                  | Built-ins cover common noise as a baseline; per-source handles messy directories                                                                                                                                                                                      |
| Large file cap         | Configurable (default 5 GB, `MENTRO_MAX_FILE_SIZE`): over the limit only size/mtime are recorded — no hashing, no extraction, the UI marks it oversized                                                                                                                                                                       | Keeps scanning bounded; just raise the limit when needed                                                                                                                                                                                                              |
| Asset pool             | **Mount + upload dual channel**: `MENTRO_SOURCES` (comma-separated) idempotently auto-registered and scanned at startup; `POST /api/upload` (multipart, JWT-authenticated) lands in `data/pool/_uploads/<yyyy-mm>/`; `data/pool` is an auto-created self-owned source                                                         | In deployments, mounting a volume is all it takes to ingest; ad-hoc assets are a browser drag-and-drop away                                                                                                                                                           |
| Archive handling       | Uploaded archives are **automatically unpacked** into the pool: zip / tar / tar.gz / tar.bz2 / tar.xz (pure Rust crates), 7z (sevenz-rust), rar (external `7zz`/`unar`, capability-gated); archives inside mounted sources are **not unpacked** by default (recorded as archive assets; a per-source switch may come later)   | Upload means pooled, zero manual work; not touching archives on the user's disk is the safe default                                                                                                                                                                   |
| Unpacking safety       | zip-slip protection (reject `..`/absolute-path entries), entry count cap (default 10k), total decompressed size cap (default 10 GiB), skip `__MACOSX`/`._*`/`.DS_Store` junk entries                                                                                                                                          | A hard line of defense against decompression bombs and malicious archives                                                                                                                                                                                             |
| Deployment form        | docker compose: mentro (server + worker in one container) + gotenberg + paddle-ocr, `data/` volume mounted                                                                                                                                                                                                                    | One command brings up the whole stack; TLS is not built in — a reverse proxy (Caddy / nginx) is recommended for cross-network access                                                                                                                                  |

## 4. Repository Structure

```bash
mentro/
├── apps/
│   ├── server/                  # Node 24 + Fastify + TypeORM
│   │   ├── src/
│   │   │   ├── index.ts         # entry: startup, data dir lock, spawn worker
│   │   │   ├── db/
│   │   │   │   ├── data-source.ts # AppDataSource singleton + init/close (migrations auto-run at startup)
│   │   │   │   ├── entities/      # *.entity.ts + index.ts explicit barrel
│   │   │   │   └── migrations/    # <ts>-<PascalCase>.ts + index.ts barrel
│   │   │   ├── routes/          # api/*.ts (assets, sources, index, jobs...)
│   │   │   ├── ws/              # WebSocket event broadcast
│   │   │   ├── queue/           # job queue: scheduling, retries, circuit breaker
│   │   │   ├── worker/          # mentro-worker process management + protobuf frame client
│   │   │   ├── fs-events/       # consume worker fs events → debounce → enqueue
│   │   │   └── indexbundle/     # browser index bundle build + incremental deltas
│   │   ├── scripts/             # migration:generate/run/revert/check (tsup build)
│   │   └── package.json
│   └── web/                     # Vue 3 + Vite SPA
│       ├── src/
│       │   ├── views/           # Search / AssetDetail / Settings
│       │   ├── components/      # result cards, previewers, filters
│       │   ├── search/          # engine interface + minisearch implementation (isolated, swappable for WASM)
│       │   ├── api/             # REST/WS client + zod validation
│       │   └── stores/          # Pinia
│       └── package.json
├── proto/                       # buf-managed worker protocol .proto (single authority, sole committed artifact)
├── bin/                         # mentro-worker binary (gitignored, copied in by pnpm build:worker)
├── packages/
│   └── protocol/                # HTTP/WS zod schemas + generated TS protocol types
│       ├── src/schemas/*.ts     # REST/WS DTO validation (hand-written zod, single source)
│       ├── gen/                 # buf generate output (generated at build time, gitignored)
│       └── descriptor.bin       # consumed by cargo build.rs (generated at build time, gitignored)
├── rust/
│   ├── Cargo.toml               # workspace (resolver = "3")
│   ├── rust-toolchain.toml
│   └── crates/mentro-worker/    # see §7 for details
├── docker/
│   ├── ocr/                     # thin OCR image: official PaddleX + serving plugin (implemented)
│   └── office/                  # optional thin image: FROM gotenberg + extra fonts
├── data/                        # runtime data (gitignored)
├── ref/                         # local test corpus (gitignored)
├── testdata/                    # small synthetic fixtures committed to the repo (for CI)
├── docs/
├── pnpm-workspace.yaml
├── package.json
└── plan.md
```

Toolchain orchestration: `pnpm build:worker` runs `cargo build --release` and copies the binary to the agreed location; `pnpm dev` starts the server and Vite together.

## 5. Data Model

### 5.1 Storage Directories

```text
data/                            # MENTRO_DATA can override; dev default is ./data
├── mentro.db                    # SQLite + TypeORM (WAL mode)
├── thumbs/<assetId>/<unit>.webp # content unit thumbnails
├── render/<assetId>.pdf         # Office → PDF render cache
├── pool/                        # asset pool (self-owned source): uploads and unpacked output
│   └── _uploads/<yyyy-mm>/      # raw uploaded files (including not-yet-unpacked archives)
├── office-fonts/                # user-supplied licensed fonts (into the office container: mount or thin image, verified in M3)
├── containers/                  # container observation files (§7.6)
└── logs/                        # daily-rotated logs for server and worker
```

At startup the server takes an advisory file lock on `data/`: a duplicate instance exits immediately with a dedicated exit code and an "already running" message.

### 5.2 Database Layer (TypeORM)

The full conventions for the database layer (entity format, migration flow, DataSource wiring) are below. Key points:

- **DataSource**: `src/db/data-source.ts` exports a module-level `AppDataSource` singleton (no DI); `type: 'better-sqlite3'`, `database: <data>/mentro.db` (`MENTRO_DATA` override); `synchronize: false` (schema changes go through migrations only, with a comment explaining why); `logging: ['error', 'warn']` + a hand-written silencing Logger; `initDataSource()` auto-applies pending migrations at every startup (`runMigrations({ transaction: 'each' })`), called by a Fastify startup hook; `closeDataSource()` on process exit
- **Entities**: `entities/*.entity.ts` + an explicit barrel (`entities: Object.values(entities)`, no glob / autoLoadEntities); `@Entity({ name: 'plural_snake_case' })`; properties camelCase, multi-word columns get an explicit `name: 'snake_case'`; **every column declares `type` explicitly** (text / integer / datetime / boolean / blob, no varchar); no TypeORM enums — string literal unions documented in JSDoc comments; **no relation decorators** — FKs are plain columns, joins are hand-written; no base entity, fields use `!:` assertions throughout; complex JSON values stored as text via ValueTransformer
- **Primary keys**: ULID text primary keys on every table (`@PrimaryColumn({ type: 'text', ... })` natural-key style); index and constraint names hand-written with `pk_` / `uq_` / `idx_` prefixes
- **Migrations**: `migrations/<timestamp>-<PascalCase>.ts`, class name and `name` field carry the timestamp suffix; **raw `queryRunner.query()` SQL only**, no createTable builder; existence guards via `sqlite_master` / `PRAGMA table_info` before destructive operations; committed migrations are never modified; new files are registered in timestamp order in the `migrations/index.ts` barrel
- **Scripts**: programmatic scripts built with tsup under `apps/server/scripts/` — `migration:generate` (`driver.createSchemaBuilder().log()` for the diff, emitting an UP/DOWN SQL array template), `migration:run` / `migration:revert` (sharing the same code path as startup), `migration:check` (commit-hook guard). The typeorm CLI is not used
- **Query style**: Repository API first; QueryBuilder for aggregates; parameterized raw SQL via `AppDataSource.query` for upserts and FTS MATCH; `AppDataSource.transaction(m => ...)` for multi-write atomicity
- **tsconfig**: `experimentalDecorators` + `emitDecoratorMetadata`; because every column has an explicit type, script builds do not depend on metadata

Representative entities (full style demonstration):

```ts
import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "assets" })
@Index("uq_assets_path", ["path"], { unique: true })
@Index("idx_assets_source", ["sourceId"])
export class Asset {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_assets" })
  id!: string; // ULID

  @Column({ name: "source_id", type: "text", nullable: false })
  sourceId!: string;

  @Column({ type: "text", nullable: false })
  path!: string;

  @Column({ name: "size_bytes", type: "integer", nullable: false })
  sizeBytes!: number;

  @Column({ name: "mtime_ms", type: "integer", nullable: false })
  mtimeMs!: number;

  @Column({ name: "content_hash", type: "text", nullable: true })
  contentHash!: string | null; // blake3 hex

  @Column({ type: "text", nullable: true })
  mime!: string | null;

  @Column({ type: "text", nullable: false })
  kind!: string; // 'text'|'pdf'|'presentation'|'document'|'spreadsheet'|'image'|'video'|'audio'|'archive'|'other'

  @Column({
    name: "extraction_status",
    type: "text",
    nullable: false,
    default: "pending",
  })
  extractionStatus!: string; // 'pending' | 'running' | 'done' | 'failed' | 'skipped'

  @Column({ name: "extraction_version", type: "integer", nullable: true })
  extractionVersion!: number | null; // extractor version; bumping it triggers full re-extraction

  @Column({ name: "extracted_at", type: "datetime", nullable: true })
  extractedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;
}

@Entity({ name: "content_units" })
@Index(
  "uq_content_units_asset_ordinal_type",
  ["assetId", "ordinal", "unitType"],
  { unique: true },
)
export class ContentUnit {
  @PrimaryColumn({ type: "text", primaryKeyConstraintName: "pk_content_units" })
  id!: string; // ULID

  @Column({ name: "asset_id", type: "text", nullable: false })
  assetId!: string;

  @Column({ type: "integer", nullable: false })
  ordinal!: number; // page/slide/sheet number, 1-based; 1 for whole-file kinds

  @Column({ name: "unit_type", type: "text", nullable: false })
  unitType!: string; // 'page' | 'slide' | 'sheet' | 'frame' | 'whole'

  @Column({ type: "text", nullable: true })
  title!: string | null;

  @Column({ type: "text", nullable: true })
  text!: string | null; // extracted text (nullable: pure image / video without subtitles)

  @Column({ name: "start_ms", type: "integer", nullable: true })
  startMs!: number | null; // audio/video positioning

  @Column({ name: "end_ms", type: "integer", nullable: true })
  endMs!: number | null;

  @Column({ name: "thumb_path", type: "text", nullable: true })
  thumbPath!: string | null; // path relative to data/

  @Column({ name: "meta_json", type: "text", nullable: true })
  metaJson!: string | null;
}
```

All other tables follow the same style: `sources` (id, unique rootPath, addedAt, lastScanAt), `jobs` (id, assetId, kind, status, attempts default 0, errorCode, error, createdAt, updatedAt), `index_state` (key primary key, value — stores index_version etc.). The three auth tables:

- `users`: id, unique `username` (`/^[A-Za-z0-9_-]{3,32}$/`), `password_hash` (argon2id, only the hash is stored and it never appears in logs), `role` (`'super_admin' | 'user'` — the first registrant becomes super_admin), `enabled` (default true), `created_at`, `last_login_at`
- `user_sessions`: id, `user_id`, `refresh_hash` (only the hash of the refresh token is stored), `created_at`, `expires_at`, `revoked_at` — sessions are visible and revocable per device; refresh rotates (the old token is invalidated)
- `settings`: key primary key, value — runtime switches such as `allowRegistration` (default true)

**FTS5**: `units_fts` is an external-content virtual table + sync triggers on `content_units`, which TypeORM cannot model — created with raw SQL in the Init migration (baseline style: a DDL array executed in a loop); later entity changes touching searchable columns maintain the triggers in the same migration. The server-side fallback search goes through `AppDataSource.query('... WHERE units_fts MATCH ?', [q])`.

### 5.3 Asset URI

The frontend always locates things by ID, never by file path:

```text
mentro://<assetId>/page/23
mentro://<assetId>/slide/12
mentro://<assetId>/time/372.4      # video seconds
mentro://<assetId>/sheet/2
```

### 5.4 Change Detection and Re-extraction

- On rescan: `mtime + size` unchanged → skip; changed → recompute blake3; same hash → update mtime only
- hash change / `extraction_version` bump → re-enqueue for extraction
- Before writing extraction results, the fencing triple (§6.3) is verified; results for a file that changed again are simply discarded

## 6. Protocol Design

The protocol has two halves: **browser ↔ server** is JSON (REST/WS), validated by hand-written zod schemas in `packages/protocol`; **server ↔ worker** is protobuf, defined by the single-authority `.proto` under `proto/` managed by buf, with codegen on both ends — schema drift is eliminated at build time, so no golden-file mechanism is needed (§6.3).

### 6.1 HTTP API

Authentication: except for `/api/auth/*`, health checks, and static assets, every endpoint requires `Authorization: Bearer <JWT>` (WS uses `?token=`). Registration is unconditionally open while the user count is 0 (the first registrant becomes super_admin); otherwise it is controlled by the `allowRegistration` setting.

| Method    | Path                                  | Description                                                                                                                       |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST      | `/api/auth/register`                  | Register: username `/^[A-Za-z0-9_-]{3,32}$/`, password ≥ 8 chars; open while there are 0 users, and that user becomes super_admin |
| POST      | `/api/auth/login`                     | Login → access + refresh token pair; rate-limited against brute force                                                             |
| POST      | `/api/auth/refresh`                   | Refresh (refresh rotation, the old token is invalidated)                                                                          |
| POST      | `/api/auth/logout`                    | Revoke the current refresh session                                                                                                |
| GET       | `/api/auth/me`                        | Current user info                                                                                                                 |
| POST      | `/api/auth/password`                  | Change own password (other sessions revoked on success)                                                                           |
| GET       | `/api/status`                         | server / worker / external tool availability                                                                                      |
| GET       | `/api/sources`                        | Source list                                                                                                                       |
| POST      | `/api/sources`                        | Add source `{ rootPath }`, triggers the first scan and starts watching                                                            |
| DELETE    | `/api/sources/:id`                    | Remove source (keeping extracted content is optional)                                                                             |
| POST      | `/api/sources/:id/rescan`             | Full rescan                                                                                                                       |
| GET       | `/api/assets`                         | Pagination + kind/source/time filters                                                                                             |
| GET       | `/api/assets/:id`                     | Detail + content units                                                                                                            |
| GET       | `/api/assets/:id/file`                | Original file stream (for preview, Range supported)                                                                               |
| POST      | `/api/assets/:id/reveal`              | Finder reveal (forwarded to the worker `reveal`)                                                                                  |
| GET       | `/api/index`                          | Browser search bundle (ETag = index_version)                                                                                      |
| GET       | `/api/thumbs/:unitId`                 | Thumbnail (the lazy-render trigger point)                                                                                         |
| POST      | `/api/render/:assetId/:ordinal`       | Request rendering of a specific unit                                                                                              |
| GET       | `/api/jobs`                           | Job list and status                                                                                                               |
| POST      | `/api/assets/:id/retry`               | Manually retry a failed extraction                                                                                                |
| POST      | `/api/export`                         | Selected unit set + target format → export job (M6; PDF split/merge / PPTX OOXML surgery)                                         |
| GET       | `/api/admin/users`                    | User list (super_admin)                                                                                                           |
| PATCH     | `/api/admin/users/:id`                | Rename / enable-disable users (a super_admin cannot be disabled)                                                                  |
| POST      | `/api/admin/users/:id/reset-password` | Admin sets a new password directly and revokes all of that user's sessions                                                        |
| DELETE    | `/api/admin/users/:id`                | Delete a user (cannot delete yourself; sessions revoked as well)                                                                  |
| GET/PATCH | `/api/admin/settings`                 | Read/set `allowRegistration` etc. (super_admin)                                                                                   |

### 6.2 WebSocket Events (`/api/ws`)

```json
{"event": "pipeline.snapshot", "revision": 57, "phase": "extract", "assetsDone": 42, "assetsTotal": 168, "jobsActive": 3}
{"event": "index.delta", "fromVersion": 41, "toVersion": 42, "upserted": [], "removed": ["01J9Z..."]}
{"event": "job.updated", "jobId": "01J9...", "status": "failed", "error": "TIMEOUT: soffice exceeded 120s"}
```

- `pipeline.snapshot` uses a **versioned snapshot** pattern: the server computes the presentation snapshot with a revision, the frontend only renders snapshot diffs, and never infers state from event order
- `index.delta`: if the client sees `fromVersion` discontinuous with its local version → fall back to a full pull of `/api/index`

### 6.3 Worker Protobuf Protocol (stdio)

The worker protocol is defined by the single authority `proto/mentro/worker/v1/worker.proto` (`package mentro.worker.v1`); **all generated artifacts are produced at build time**: `pnpm gen:proto` regenerates every consumer in one go (TS → `packages/protocol/gen/`, descriptor.bin → for cargo `build.rs`, both gitignored). Message naming follows the proto standard: requests/replies `*Request`/`*Response`, push events `*Message`, reusable payloads `CMsg*`, enums `E`-prefixed with self-qualified members. Transport is **length-delimited frames** over stdio (varint length prefix + message body, 32 MB frame cap), with a single envelope `WorkerFrame` as the only decode point:

```protobuf
message WorkerFrame {
  oneof body {
    // server → worker requests
    ScanRequest scan = 1;           // root
    ExtractRequest extract = 2;     // assetId + contentHash (fencing) + kind + want[] + options
    RenderRequest render = 3;       // assetId + contentHash + ordinal + want
    StatRequest stat = 4;           // paths[]
    CancelRequest cancel = 5;       // jobId
    WatchRequest watch = 6;         // sourceId + root
    UnwatchRequest unwatch = 7;     // sourceId
    RevealRequest reveal = 8;       // path
    OcrRequest ocr = 9;             // assetId + contentHash + ordinal
    ExportRequest export = 10;      // units[] (set of assetId+ordinal) + format(pdf|pptx); M6
    UnpackRequest unpack = 12;      // path + dest_dir + entry/size caps (upload unpacking, § asset pool)
    // worker → server events and replies
    ReadyMessage ready = 20;        // protocol version + capabilities + tool probing
    Response response = 21;         // echoes the request id; on ok, fills in the result per request type, otherwise error
    ProgressMessage progress = 22;  // id + done/total + unit
    LogMessage log = 23;            // level + message
    FsMessage fs = 24;              // sourceId + path + kind
    OcrStatusMessage ocr_status = 25; // state + detail
  }
}

message ErrorInfo {
  EErrorCode code = 1; // EErrorCode{ ErrorCodeToolMissing, ErrorCodeToolTimeout, ... }
  string message = 2;
  bool retryable = 3;  // timeouts / tool crashes are retryable; corrupt format / unsupported is not
}

// Unpack an uploaded archive (asset pool). Safety: zip-slip entry rejection; entry-count and total-decompression caps.
message UnpackRequest {
  string path = 1;        // archive path
  string dest_dir = 2;    // unpack destination (directory inside the pool)
  int32 max_entries = 3;  // default 10000
  int64 max_bytes = 4;    // default 10 GiB
}

message UnpackResult {
  repeated string file_paths = 1; // relative to dest_dir
  int64 total_bytes = 2;
  int32 skipped_entries = 3;      // junk entries (__MACOSX/._*) and over-cap entries
}
```

Key points:

- **Handshake**: on process start it immediately sends `ready` (protocol version + capabilities + external tool probe results); the server degrades features accordingly (e.g. without soffice, PPTs get text but no thumbnails)
- **Fencing triple**: every extract/render request carries `assetId + contentHash`, and the response echoes it back; the server verifies before persisting and discards stale results (fencing triple, guards against stale writes)
- **fs events**: the worker only reports raw events; debouncing/aggregation happens on the server side (a burst of editor writes must not trigger repeated extraction)
- **ocr**: inside the worker the page image is rendered first and then sent to the container; ocr jobs queue while the container is lazily starting, waiting for `ocr_status: ready`
- stdout carries **protobuf frames only**; human-readable logs go through the `log` event or stderr
- **Debugging**: the `serve` mode pipe is binary; day-to-day debugging uses one-shot subcommands (`extract` / `scan` / `doctor` / `ocr`, JSON text output, see §7.2)

## 7. Rust Worker Design

### 7.1 Workspace Structure

```text
rust/crates/mentro-worker/
├── Cargo.toml
└── src/
    ├── main.rs            # clap entry: serve / extract / scan / unpack / doctor
    ├── cli/               # args.rs (clap derive), shell.rs (dual-stream output)
    ├── proto/             # prost-generated types (build.rs consumes descriptor.bin, clear error if missing)
    ├── serve.rs           # stdio event loop: read length-delimited frames → dispatch → concurrent execution → write frames
    ├── scan.rs            # jwalk parallel traversal + blake3 + infer sniffing
    ├── unpack.rs          # archive unpacking: zip/tar family (Rust crates) / 7z (sevenz-rust) / rar (external)
    ├── watch.rs           # notify watches source directories → fs events
    ├── reveal.rs          # platform operations such as Finder reveal
    ├── ocr.rs             # PaddleOCR container lifecycle + HTTP client (§7.6)
    ├── job.rs             # job state machine, retry classification, circuit-breaker counters
    ├── extract/           # mod.rs dispatches by kind; text.rs / pdf.rs / ooxml.rs / image.rs / media.rs
    ├── export/            # export (M6): pptx.rs (OOXML surgery) / pdf.rs (split & merge, lopdf)
    └── ext/               # subprocess wrappers: mod.rs / poppler.rs / soffice.rs / ffmpeg.rs / container.rs
```

A single binary is enough for V1; if a second bin ever appears, split the generated `proto/` module out into a `mentro-proto` crate.

### 7.2 CLI Design (Cargo style)

```bash
mentro-worker serve                          # long-lived protobuf mode (spawned by the server)
mentro-worker extract <path> [--json]        # single-file extraction, result JSON to stdout
mentro-worker scan <root> [--json]           # scan, emits a stream of file records
mentro-worker doctor                         # probe external tools, container runtimes, and versions
mentro-worker unpack <archive> -o <dir>      # unpack an archive into a directory (debugging)
mentro-worker ocr <image> [--json]           # single-image OCR (debugging the container chain)
```

- Global flags: `--color {auto,always,never}`, `-v/--verbose`, `-q/--quiet`
- Self-contained: no dependency on server code; can `cargo build` / `cargo test` / be distributed and used standalone
- **Dual-stream output**: human-readable status/diagnostics → stderr (fixed left-aligned status column, four levels green/yellow/red/dim), machine results → stdout; with `--json`, stdout is JSON only
- Errors: `anyhow` chains + custom exit codes (0 success / 1 user error / 101 internal failure / 130 interrupt)

### 7.3 Reliability Design Patterns

| Pattern                                                       | Mentro implementation                                                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity fencing (fencing triple)                             | Every request carries `assetId + contentHash`, echoed in the response, verified before persisting — guards against stale writes                                                                                |
| Data-directory lock + dedicated exit code                     | The server locks `data/`; a duplicate startup → dedicated exit code + explicit error                                                                                                                           |
| Typed kill channel (anti PID reuse)                           | Kill commands for external tools go through an mpsc channel, executed only by the task still holding the original `tokio::process::Child`                                                                      |
| Process-group kill                                            | Unix `process_group(0)`: soffice/ffmpeg run in their own process groups; on timeout SIGTERM the group first, then SIGKILL after a grace period — prevents grandchild processes (soffice.bin etc.) from leaking |
| External tool concurrency isolation                           | LibreOffice goes through the Gotenberg process pool (concurrency managed inside the container, worker-side throttle of 2); ffmpeg uses its own concurrency pool                                                |
| Exclusive ownership of external resources + observation files | The PaddleOCR container is held exclusively by the worker: observation file + `docker inspect` claim/reclaim (§7.6)                                                                                            |
| Crash-loop circuit breaker                                    | 3 consecutive extraction failures for the same asset → `failed`, no more automatic retries; waits for a manual retry or a rescan                                                                               |
| Shutdown-handling state machine                               | Job state machine + `retryable` error classification; deadline-driven retries, no sleeping inside handlers                                                                                                     |
| Versioned progress snapshots                                  | `pipeline.snapshot` events carry a revision, rendering is throttled; the frontend renders snapshot diffs only                                                                                                  |
| Dual-stream CLI output                                        | stderr for humans / stdout for machines (§7.2)                                                                                                                                                                 |
| Daily-rotated leveled logs                                    | Worker logs written to `data/logs/worker/`, tracing + rolling appender                                                                                                                                         |
| Pure state-machine inline tests                               | `#[cfg(test)]` tests only the IO-free state machines (§11)                                                                                                                                                     |
| pnpm-orchestrated polyglot builds                             | `pnpm build:worker` orchestrates cargo and copies the binary                                                                                                                                                   |

**Explicitly not done**: heavyweight RPC such as gRPC / SignalR (single-machine parent-child IPC; bare protobuf frames suffice); browser-side protobuf (HTTP/WS stay JSON + zod); a separate Agent process (the TS backend takes that role); worker reconnect logic (parent and child share a lifetime; revisit when daemonizing).

### 7.4 Concurrency Model

- `serve.rs` is a single event loop reading stdin and dispatching to job tasks; the in-flight cap defaults to `num_cpus / 2` (tunable via `MENTRO_WORKER_CONCURRENCY`)
- LibreOffice (via Gotenberg) worker-side concurrency capped at 2, with pooling managed by the container; ffmpeg/ffprobe pool = 2; Poppler/Rust-native extraction is bounded only by the in-flight cap
- Inside each `extract`: text first (fast, always succeeds), rendering after (slow, can fail or degrade) — a rendering failure does not keep text out of the index
- OCR page requests: concurrency ≤ 2 (CPU inference); while the container is lazily starting, the related jobs queue and hold no concurrency slots

### 7.5 External Tool Wrapper Contract (`ext/mod.rs`)

```rust
pub async fn run(cmd: PreparedCommand, timeout: Duration) -> Result<Output, ExtError>
// Contract:
// - Unix: process_group(0); on timeout → SIGTERM the process group → 3s grace → SIGKILL the group
// - Kills go through a typed channel to the task holding the Child (no accidental kills from PID reuse)
// - stdout/stderr captured with a cap (16 MB ring buffer); when streaming is needed, a per-line callback is used and fails open
// - Each tool class declares its probe method (--version), shared by doctor and the serve handshake
```

`ExtError` → protocol error code mapping: `TOOL_MISSING` / `TOOL_TIMEOUT` / `TOOL_NON_ZERO_EXIT` / `OUTPUT_TOO_LARGE` / `CANCELLED` / `UNSUPPORTED` / `INVALID_INPUT` / `INTERNAL`.

LibreOffice rendering goes through the **stock Gotenberg image** (`gotenberg/gotenberg:8.x-libreoffice`, pinned tag), held exclusively by the worker (§7.6). Each conversion is a single HTTP call, with no working-directory mount needed:

```text
worker reads the source file bytes
  → POST <office>/forms/libreoffice/convert (multipart)
  ← PDF bytes → written to render/<assetId>.pdf
  → host pdftoppm produces page images
```

- The resident process pool converts hot, with no per-run soffice cold start; timeouts go through the HTTP client; an unresponsive container → §7.6 reclaim and rebuild
- Starting with 8.30 the built-in font stack is slimmed (30+ → 8 packages): pin the tag; after any upgrade the ref/ rendering regression must be run
- User-licensed fonts: `<data>/office-fonts` mounted at runtime (verified in M3) or a thin Dockerfile `FROM gotenberg/gotenberg:8.x-libreoffice` + `COPY`

### 7.6 Container Management (mentro-office / mentro-paddle-ocr)

All heavy external-tool dependencies are containerized and held exclusively by the worker, following the "exclusive ownership + observation file + crash-recovery cleanup" management model. Observation files are stored per container (`data/containers/<name>.json`: container name, port, start timestamp); after a worker restart, `docker inspect` verifies and claims them; on mismatch the container is reclaimed and rebuilt — a container of unknown provenance is never adopted.

**mentro-office (M3, stock Gotenberg image `gotenberg/gotenberg:8.x-libreoffice`)**: lazily started on the first extract/render request that needs rendering; readiness probe `/health`; files travel over HTTP, no working-directory mount needed (§7.5).

**mentro-paddle-ocr (M5, official serving image)**: lazily started on the first `ocr` action; readiness probe `/health`; the first image pull can take minutes, with progress reported through `ocr_status` events:

```bash
docker run -d --name mentro-paddle-ocr \
  -p 127.0.0.1:9300:9300 \
  -v <data>/paddle-cache:/root/.paddlex \
  <paddle-serving-image>   # PaddleX --serve --pipeline OCR; the image tag is locked when M5 lands
```

- **Runtime probing**: probe the `docker` and `podman` CLIs in turn (Docker Desktop / OrbStack / colima all provide the `docker` CLI, so no special-casing is needed); if all are missing → the corresponding capability is absent and features degrade gracefully (Office text-only, OCR unavailable), with the Settings UI giving install guidance. The deployment artifact targets docker compose as first-class; podman compose is compatible but not a first-class test target (its rootless advantage matters mainly for Linux deployments)
- **Request protocol**: inside the `ocr` action, render the page image first (pdftoppm or reuse the thumbnail) → base64 POST → PaddleX serving JSON (text + boxes + confidence) → written into the corresponding content_unit's text
- **Failure handling**: a crashed container auto-restarts once; if it fails again, OCR is circuit-broken for this session (manually resettable from the UI)
- Models and Python dependencies are all sealed inside the image: the Mentro repo and the worker build have zero Python dependencies

## 8. Extractor Matrix

| Format                                    | Text extraction                                                                                                                                                                                                                                                                                                                                                                | Thumbnail/Rendering                             | Locating granularity            | Tools                         | Stage |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------- | ----------------------------- | ----- |
| txt / md / csv / json                     | Rust-native                                                                                                                                                                                                                                                                                                                                                                    | none                                            | whole                           | —                             | M1    |
| pdf                                       | **Layout-aware extraction** (implemented): `pdftohtml -xml` coordinates + font sizes → a layout analyzer ported from pdf2md (lines/paragraphs/multi-column/reading order/headers-footers/heading hierarchy); every embedded image extracted via `pdfimages` gets **individually OCR'd** and merged into the page text; pages without a text layer are fully rendered and OCR'd | `pdftoppm`                                      | page                            | poppler + PaddleOCR container | M1+   |
| pptx                                      | OOXML: presentation.xml defines the order → `a:t` in slides/notes                                                                                                                                                                                                                                                                                                              | Gotenberg(container)→pdf→`pdftoppm`             | slide                           | in-house + Gotenberg          | M3    |
| docx                                      | OOXML: `w:t` + heading styles                                                                                                                                                                                                                                                                                                                                                  | Gotenberg(container)→pdf                        | page                            | in-house + Gotenberg          | M3    |
| xlsx                                      | sharedStrings + sheet names                                                                                                                                                                                                                                                                                                                                                    | none                                            | sheet                           | in-house                      | M3    |
| png / jpg / webp                          | EXIF (`kamadak-exif`)                                                                                                                                                                                                                                                                                                                                                          | `image` crate scaling                           | whole                           | Rust-native                   | M4    |
| mp4 / mov / mkv                           | — (M6 transcription)                                                                                                                                                                                                                                                                                                                                                           | ffmpeg frame extraction (poster + scene frames) | time segment                    | ffmpeg/ffprobe                | M4    |
| mp3 / wav                                 | — (M6 transcription)                                                                                                                                                                                                                                                                                                                                                           | none                                            | time                            | ffprobe                       | M4    |
| heic                                      | —                                                                                                                                                                                                                                                                                                                                                                              | libheif                                         | whole                           | libheif                       | M5    |
| epub / zip                                | zip + html text                                                                                                                                                                                                                                                                                                                                                                | cover                                           | chapter                         | Rust crate                    | M5    |
| Uploaded archives (zip/tar family/7z/rar) | Unpacked into the pool (§ asset pool): zip/tar pure Rust, 7z via sevenz-rust, rar via `7zz`/`unar`                                                                                                                                                                                                                                                                             | —                                               | by content type after unpacking | unpack module                 | M2    |
| Scanned PDF / image OCR                   | PaddleOCR container (**implemented**: thin image `docker/ocr` = official PaddleX + serving plugin, PP-OCRv5 Chinese-English, endpoint `POST /ocr` → `rec_texts`)                                                                                                                                                                                                               | —                                               | page / whole                    | docker + PaddleX serving      | ✅    |

Design principle (carried over from the discussion): **Rust owns the pipeline, not the formats**. Every extractor only outputs uniform Content Units; when a tool renders poorly, swap that extractor — the core stays untouched. Extractors carry a version number (`extraction_version`); an upgrade means full re-extraction.

Thumbnail strategy: during scans only the cover is produced (page 1 / slide / poster frame); the remaining pages render lazily (triggered by `POST /api/render/...`), keeping first-scan speed high on large corpora; default spec is webp width 480px, quality 75.

**Why Office rendering goes through a PDF intermediary**: LibreOffice/Gotenberg has no reliable per-page image export (the image filter only emits the first page); PDF is its only first-class full-document export format. And the single `render/<assetId>.pdf` cache simultaneously serves three consumers — lazily rendered thumbnails (pdftoppm on demand at any page and any resolution), pdf.js in-browser page-jump preview, and M6 selected-page export (direct split-and-merge, zero re-conversion).

## 9. Browser Search

### 9.1 V1: MiniSearch

`/api/index` delivers the bundle (ETag = index_version); the frontend builds MiniSearch:

```json
{
  "version": 42,
  "generatedAt": 1750000000000,
  "units": [
    {
      "id": "01J9Z...",
      "assetId": "01J9A...",
      "kind": "presentation",
      "unitType": "slide",
      "ordinal": 23,
      "title": "Competition Rules",
      "text": "Teams consist of up to three contestants ...",
      "fileName": "ICPC.pptx",
      "sourcePath": "~/Documents/CPU",
      "mtimeMs": 1730000000000,
      "hasThumb": true
    }
  ]
}
```

- Fields: `title^3, fileName^2, text`; fuzzy 0.2, prefix, AND semantics; Chinese is tokenized by jieba-wasm before indexing/querying (same source as FTS5)
- Filters (kind / source / time) post-filter the results (fast enough at V1 data volumes)
- The bundle lives in memory + localStorage records the version; WS `index.delta` merges incrementally
- Each device pulls its own bundle (gzip + ETag negotiated caching); mobile devices are size-sensitive, and the §9.2 trigger thresholds apply there equally

### 9.2 Upgrade Triggers and Paths

Trigger conditions (any one): content units > 50k, bundle > 50 MB, cold-start build > 500 ms.

Path A: the server exports the FTS5 db file directly → the browser queries it with sql.js (SQLite WASM).
Path B: Tantivy → WASM, sharing one Rust search implementation with the server (the long-term direction from the discussion).

The search module in `apps/web/src/search/` is isolated behind an interface (`engine.ts` defines the `SearchEngine` interface); MiniSearch is just the first implementation, and replacing it touches no UI.

## 10. Frontend Design

| View        | Contents                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login       | Login / registration (the registration entry is hidden when `allowRegistration` is off; the first-user registration page hints that they will become the administrator)                                                             |
| Search      | Search box + filters (type/source/time), result cards (thumbnail + highlighted snippet), keyboard navigation                                                                                                                        |
| AssetDetail | Unit list (page/slide thumbnails + text), metadata, open file / Finder reveal                                                                                                                                                       |
| Settings    | Source management, job monitoring (pipeline snapshot rendering), external tool status (doctor results), user management (super_admin: list / rename / disable / reset password / delete / registration switch), change own password |

Preview interactions:

- PDF: pdfjs-dist, jump to page `ordinal`
- PPT slide: server-rendered webp image
- Video: `<video>` + `#t=<start seconds>` positioning
- Image: original file (`/api/assets/:id/file`)
- Text: snippet preview

UI copy is English; responsive layout — phone / tablet browsers are usable (search and preview are the main battlegrounds).

## 11. Testing and Quality

### 11.1 Rust

- **Inline unit tests** (`#[cfg(test)]`, testing only IO-free pure logic): proto encode/decode roundtrips, OOXML parsing (fixture bytes), the job state machine and retry classification, circuit-breaker counters, scan filter rules
- **Integration tests** (`tests/`, spawning the real binary via `CARGO_BIN_EXE_mentro-worker`): byte-exact stdout assertions for `extract`/`doctor`/`scan`; `serve` mode fed protobuf frames to verify the handshake and fencing
- Cases depending on external tools are gated by `MENTRO_E2E=1` (run locally and in a dedicated CI job); OCR cases additionally need a container runtime + image (~2 GB), separately gated by `MENTRO_E2E_OCR=1`; CI does not pull the image by default

### 11.2 TypeScript

- vitest: HTTP/WS zod schema roundtrips, worker protocol (generated types) encode/decode roundtrips, index bundle building, delta merging, queue scheduling and circuit breaking
- DB: run migrations on a temporary DB_PATH + entity read/write roundtrips (selftest style)
- Integration tests: start the server + worker, scan `testdata/`, assert ingestion and the bundle

### 11.3 Corpus Testing (local)

`pnpm test:corpus`: scan `ref/` → assert ≥ 160 assets, all PDF/PPTX `done`, plausible unit counts, and 3–5 hand-picked known texts hitting the right page numbers. Not run in CI (the corpus stays out of the repo); CI uses the small synthetic fixtures in `testdata/`.

### 11.4 CI and Standards

- CI (GitHub Actions, public repo mentro, ubuntu runners only): lint (prettier --check, eslint, cargo fmt --check, clippy -D warnings, pnpm migration:check) + proto gate (`buf lint`, `buf breaking --against '.git#branch=main'`; the checkout needs fetch-depth: 0) + unit tests and builds; external-tool e2e as a separate job (apt installs poppler/ffmpeg); darwin compilation is verified on the local machine. Write workflows per the hnrobert-github-actions standard
- Migration guard: husky + lint-staged runs `pnpm migration:check` — a staged entity change without a newly registered migration blocks the commit
- Code standards: TS per hnrobert-typescript (Prettier 2-space/printWidth 80, eslint flat config, pnpm with `packageManager` pinned); Markdown/YAML/JSON per hnrobert-docs-style; Rust uses default rustfmt + clippy
- Commit messages follow Conventional Commits (hnrobert-commit-message); git operations follow hnrobert-git-safety

## 12. Milestones

| Phase                                       | Contents                                                                                                                                                                                                                                             | Acceptance criteria (against the ref/ corpus)                                                                                                                                                                                                                                                                                                   | Scale |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| M0 Scaffolding                              | pnpm workspace, apps/server, apps/web, packages/protocol, proto/ (buf + codegen on both ends), rust workspace, standards files (.editorconfig/.prettierrc/eslint.config.js copied from the skill assets), CI skeleton                                | `pnpm gen:proto` artifacts ready on both ends; `pnpm dev` starts server+web together; `pnpm build:worker` produces the binary; CI green                                                                                                                                                                                                         | S     |
| M1 Users + scan + text + server-side search | User system and JWT (register/login/first super-admin/registration switch/password change/admin user management/session revocation), worker scan/stat/extract(text,pdf)+doctor; SQLite migrations, job queue, FTS5; login page + minimal search page | The first registrant becomes super_admin and can close registration; the second user is governed by the switch; after an admin password reset all old sessions are invalid; ref/ fully scanned; 71 PDFs searchable down to the page; rescans skip unchanged files                                                                               | L     |
| M2 Browser-local search + multi-device      | `/api/index` bundle, WS delta, MiniSearch, pdf.js page-jump preview, token auth and non-loopback binding, **asset pool** (`MENTRO_SOURCES` mounts + `/api/upload` uploads + automatic archive unpacking)                                             | A second search runs locally in < 50 ms; file changes take effect incrementally; bundle < 20 MB gzipped; a second device works end-to-end over the LAN; upload a zip → auto-unpacked → content searchable                                                                                                                                       | M     |
| M3 Office                                   | Gotenberg office container (stock image, pinned tag), pptx/docx/xlsx text (OOXML), HTTP rendering pipeline, page thumbnails, lazy rendering                                                                                                          | All 19 PPTX searchable page-by-page with visible thumbnails; PDF page-count vs slide-count consistency checks pass (misalignment cases like hidden slides are detected); without a container runtime it degrades to text-only; an unresponsive/crashed container does not take down the worker (reclaim and rebuild); the circuit breaker works | L     |
| M4 Media + incremental watching             | Image EXIF + thumbnails, ffprobe metadata, video poster frames + time positioning, notify incremental watching (worker `watch`)                                                                                                                      | 58 PNG + 6 JPG searchable with thumbnails; video results jump to the time point on click; new files enter the index automatically                                                                                                                                                                                                               | M     |
| M5 OCR + additional formats                 | PaddleOCR container (lazy start + lifecycle management + runtime probing), heic, epub, docker compose full-stack deployment                                                                                                                          | Scanned poster text is searchable (Chinese and English); environments without a container runtime degrade gracefully and say so explicitly; container crashes/OCR failures do not block the pipeline; after a one-command compose startup everything works                                                                                      | L     |
| M6 Intelligence layer                       | Whisper transcription, embedding semantic search, Agent Tool API (including PPTX selected-page cutting and PDF composition export), WASM search evaluation                                                                                           | Audio/video is searchable by content; the Agent completes the "find + fetch + export" loop via the Tool API (PPTX selected-page fidelity export); the upgrade evaluation is done once the index size reaches the §9.2 trigger thresholds                                                                                                        | L+    |

Scale: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 5–8 days (rough estimates for spare-time effort).

M6 Agent Tool API draft (the Agent may only operate through this API and never touches the file system):

```text
search(query, filters) -> SearchResult[]
get_asset(id) / get_unit(id) / get_context(unitId, before, after)
render(unitId) -> image
extract(units) -> selected-page export (PPTX: Rust OOXML surgery, parts copied verbatim; PDF: pure PDF split-and-merge)
transcribe(assetId) -> timestamped text
```

M6 as-built notes (2026-08): PDF composition goes through `qpdf --empty --pages` instead of lopdf — qpdf copies page objects byte-verbatim (no re-serialization), which is the stronger reading of "parts copied verbatim"; it is probed in `doctor` and degrades with a clear error. Transcription (faster-whisper) and embeddings (bge-m3 via a self-built OpenAI-compatible sidecar) follow the PaddleOCR lazy-container pattern, managed by the shared `ext/container.rs` guard; both accept `MENTRO_*_URL` overrides so compose deployments point at sibling services. Semantic search stores vectors in SQLite (`unit_embeddings`, brute-force cosine over an in-memory cache) and merges with FTS via Reciprocal Rank Fusion. The Agent Tool API ships as `/api/agent/*` HTTP plus a stateless MCP streamable-HTTP endpoint at `POST /mcp` with the same operations as tools. The §9.2 evaluation (docs/search-evaluation.md) found trigger #3 (cold build > 500 ms) already tripped at 964 units; a per-field token dedup cut ~33%, and Path A (sql.js FTS5 WASM) is scheduled as the follow-up engine swap.

## 13. Risks and Responses

| Risk                                                               | Impact                                            | Response                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LibreOffice rendering distortions (fonts/SmartArt/formulas)        | Slide previews inconsistent with PowerPoint       | The text index does not depend on rendering; a rendering failure degrades to no thumbnail; `<data>/office-fonts` supplies licensed fonts (mount or thin image); on macOS, an optional AppleScript-driven PowerPoint export as an alternative renderer (extractors are replaceable) |
| Gotenberg as a third-party dependency (API and image updates)      | Conversion behavior/fonts change after an upgrade | Pin the tag; an upgrade = an explicit decision + ref/ rendering regression; the ext-layer isolation makes it wholesale replaceable                                                                                                                                                 |
| Unpacking safety (zip-slip / bombs / malicious content)            | Path-traversal writes, disk exhaustion            | Entry path normalization checks (reject `..`/absolute paths); entry-count and total-size caps; junk entries skipped; uploads go through JWT auth and multipart limits                                                                                                              |
| PDF page ↔ slide number misalignment (hidden slides etc.)          | Page-level thumbnails/exports pick the wrong page | At extraction, verify pdfinfo page count == slide count; on mismatch, flag the mapping as suspect and disable page-level operations for that asset                                                                                                                                 |
| Network exposure of file contents                                  | Unauthorized access leaks assets                  | JWT auth on every endpoint; files exposed only by assetId, no path parameters; TLS left to a reverse proxy; still 127.0.0.1 by default                                                                                                                                             |
| Authentication security (brute force / token leakage)              | Account compromise                                | argon2id; login rate limiting; access 1h + refresh 30-day rotation, revocable; a password reset revokes all sessions; the JWT secret is generated into `data/` (back it up and you have migrated)                                                                                  |
| Slow soffice startup, profile locks                                | Slow first batch of conversions                   | A dedicated UserInstallation, global serialization, and keeping one pre-warmed resident instance for the first batch, under evaluation                                                                                                                                             |
| Scanned PDFs without text                                          | Unsearchable                                      | V1 marks them no-text without blocking; M5 OCR fills the gap                                                                                                                                                                                                                       |
| Huge files slow to hash/extract                                    | Scan and queue congestion                         | blake3 (GB/s class); mtime+size pre-filtering; job timeouts + circuit breaker                                                                                                                                                                                                      |
| better-sqlite3 / argon2 native modules                             | Node upgrades require rebuilds                    | engines pins Node 24; CI covers ubuntu, darwin verified locally                                                                                                                                                                                                                    |
| TypeORM 1.x mainline is young                                      | API / docs lag                                    | Pin the minor version; upgrades verified via the migration selftest; explicit per-column types reduce the dependence on emitDecoratorMetadata                                                                                                                                      |
| ref/ corpus cannot enter the repo                                  | CI cannot use the real corpus                     | ref/ is gitignored; CI uses testdata/ synthetic fixtures; corpus tests are local only                                                                                                                                                                                              |
| MiniSearch scale ceiling                                           | Search slows / memory grows                       | §9.2 sets explicit trigger thresholds and two upgrade paths                                                                                                                                                                                                                        |
| Missing external tools                                             | Feature degradation                               | doctor + capabilities reporting; the UI states exactly what is missing and what to install                                                                                                                                                                                         |
| PaddleOCR image ~2 GB, slow first pull                             | Long wait for the first OCR                       | Lazy start + `ocr.status` progress + a model cache volume; once the tag is locked, the README provides a pre-pull command                                                                                                                                                          |
| CPU inference ~1–3 s/page                                          | OCR of large documents is slow                    | Page-level concurrency ≤ 2 + per-page progress; a GPU passthrough parameter slot is reserved                                                                                                                                                                                       |
| Missing container runtime (a hard rendering dependency from M3 on) | Office thumbnails and OCR unavailable             | doctor probes docker/podman/OrbStack/colima; capabilities degrade gracefully + UI guidance; the text index is unaffected                                                                                                                                                           |

## 14. Future Directions (recorded, not promised)

- Multi-source deduplication (thumbnail/render cache sharing for identical content_hash)
- WASM search engine (Tantivy) sharing the Rust search logic with the server
- Agent workspace: a cross-file "select pages → compose a new PDF/PPTX" asset-operation loop
- Time-capsule view (reorganized by mtime/events), tags, favorites
- Fine-grained roles and authorization (e.g. read-only users), third-party login (OAuth/OIDC), a reference configuration for public deployment (reverse proxy + TLS)
- OCR GPU passthrough (the container `--gpus` parameter slot is already reserved)
- Windows / Linux adaptation (platform points like `open -R` are already isolated)
