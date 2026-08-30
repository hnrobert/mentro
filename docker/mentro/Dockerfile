# Mentro app: server (Node 24) + worker (Rust) in one container.
# Build from repo root: docker build -f docker/mentro/Dockerfile .

# --- Stage 1: Build Rust worker ---
FROM rust:1.93-slim AS rust-builder
WORKDIR /build
COPY rust/ .
RUN cargo build --release -p mentro-worker && \
    cp target/release/mentro-worker /build/mentro-worker

# --- Stage 2: Build web frontend ---
FROM node:24-slim AS web-builder
RUN corepack enable pnpm
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/web/ apps/web/
COPY packages/protocol/ packages/protocol/
COPY proto/ proto/
COPY tsconfig.base.json ./
RUN pnpm gen:proto && pnpm --filter @mentro/web build

# --- Stage 3: Build server bundle ---
FROM node:24-slim AS server-builder
RUN corepack enable pnpm
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY apps/server/ apps/server/
COPY packages/protocol/ packages/protocol/
COPY proto/ proto/
COPY tsconfig.base.json ./
RUN pnpm gen:proto && pnpm --filter @mentro/server build

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
COPY apps/server/node_modules /app/apps/server/node_modules
COPY package.json /app/

ENV MENTRO_DATA=/app/data \
    MENTRO_WORKER_BIN=/app/bin/mentro-worker \
    NODE_ENV=production

EXPOSE 37797
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
