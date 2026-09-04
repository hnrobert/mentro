# Mentro app: server (Node 24) + worker (Rust) in one container.
# Build from repo root: docker build -f docker/mentro/Dockerfile .
# Self-contained: buf comes from the pinned buf image; protocol
# artifacts are generated inside the build, never copied from the host.

# --- Stage 0: buf CLI (shared by the builders) ---
FROM bufbuild/buf:1.72.0 AS buf

# --- Stage 1: Build Rust worker ---
# WORKDIR mirrors the host layout (rust/ workspace root) because
# build.rs resolves the descriptor at ../../../packages/protocol.
# -slim-bookworm keeps the toolchain's glibc matched to the runtime
# stage's node:24-slim (also bookworm) — a newer builder glibc makes
# the binary unloadable at runtime.
FROM rust:1.93-slim-bookworm AS rust-builder
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf
WORKDIR /build/rust
COPY proto/ /build/proto/
COPY packages/protocol/descriptor.bin /build/packages/protocol/descriptor.bin
# Fallback for clean-network builds without host artifacts (local op).
RUN test -s /build/packages/protocol/descriptor.bin || \
    (cd proto && buf build -o ../packages/protocol/descriptor.bin)
COPY rust/ .
RUN cargo build --release -p mentro-worker && \
    cp target/release/mentro-worker /build/mentro-worker

# --- Stage 2: Build web frontend ---
FROM node:24-slim AS web-builder
RUN corepack enable pnpm
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile
COPY apps/web/ apps/web/
COPY packages/protocol/gen packages/protocol/gen
COPY packages/protocol/src packages/protocol/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY proto/ proto/
COPY tsconfig.base.json ./
# Host-generated TS types are copied in; regenerate only when absent —
# `buf generate` needs BSR remote plugins, which TLS-intercepting
# networks block inside containers.
RUN if [ -d packages/protocol/gen/mentro ]; then \
      echo "protocol pre-generated"; \
    else \
      pnpm gen:proto; \
    fi && pnpm --filter @mentro/web build

# --- Stage 3: Build server bundle ---
FROM node:24-slim AS server-builder
RUN corepack enable pnpm
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile
COPY apps/server/ apps/server/
COPY packages/protocol/gen packages/protocol/gen
COPY packages/protocol/src packages/protocol/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY proto/ proto/
COPY tsconfig.base.json ./
RUN if [ -d packages/protocol/gen/mentro ]; then \
      echo "protocol pre-generated"; \
    else \
      pnpm gen:proto; \
    fi && pnpm --filter @mentro/server build

# --- Stage 4: Runtime ---
FROM node:24-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      poppler-utils ffmpeg qpdf tini && \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app
COPY --from=rust-builder /build/mentro-worker /app/bin/mentro-worker
COPY --from=web-builder /build/apps/web/dist /app/apps/web/dist
COPY --from=server-builder /build/apps/server/dist /app/apps/server/dist
# Linux node_modules from the build stage — NOT from the host context
# (the host may be macOS with darwin native binaries inside). pnpm
# keeps the store at the workspace root, so both levels ship.
COPY --from=server-builder /build/node_modules /app/node_modules
COPY --from=server-builder /build/apps/server/node_modules /app/apps/server/node_modules
COPY package.json /app/

ENV MENTRO_DATA=/app/data \
    MENTRO_WORKER_BIN=/app/bin/mentro-worker \
    NODE_ENV=production

EXPOSE 37797
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
