# Mentro

A self-hosted knowledge base and search platform: parses PPT / PDF / images / videos / documents on disk into unified content units, delivers millisecond local search in any device's browser, and pinpoints the exact slide, page, or second.

```text
Browser (Vue 3 SPA) ── HTTP/WS ──> mentro-server (Node 24, TypeORM + SQLite)
                                        │ spawn + protobuf over stdio
                                  mentro-worker (Rust CLI)
                                        │ poppler / ffmpeg / Gotenberg / PaddleOCR containers
```

Full design document: [docs/plan.md](docs/plan.md).

## Quick Start (Development)

Prerequisites: Node 24, pnpm, Rust 1.93.1, [buf](https://buf.build), poppler, ffmpeg (optional: Docker for office rendering and OCR containers).

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

## Deployment

M5+ provides a docker compose stack (server+worker, Gotenberg, PaddleOCR). For remote access, a reverse proxy (Caddy/nginx) is recommended to terminate TLS.
