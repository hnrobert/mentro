# Mentro

自部署的素材索引与检索服务：把磁盘上的 PPT / PDF / 图片 / 视频 / 文档解析成统一的内容单元，任意设备的浏览器本地毫秒级搜索，精确定位到某一页幻灯片、PDF 某一页、视频某一秒。

```text
Browser (Vue 3 SPA) ── HTTP/WS ──> mentro-server (Node 24, TypeORM + SQLite)
                                        │ spawn + protobuf over stdio
                                  mentro-worker (Rust CLI)
                                        │ poppler / ffmpeg / Gotenberg / PaddleOCR 容器
```

完整设计见 [docs/plan.md](docs/plan.md)。

## 快速开始（开发）

前置要求：Node 24、pnpm、Rust 1.93.1、[buf](https://buf.build)、poppler、ffmpeg（可选：Docker，用于 Office 渲染与 OCR 容器）。

```bash
pnpm install          # 安装依赖（原生模块 argon2/better-sqlite3 自动构建）
pnpm gen:proto        # 生成 worker 协议（TS 类型 + descriptor）
pnpm build:worker     # cargo release 构建 mentro-worker → bin/
pnpm dev              # 同时启动 server (127.0.0.1:37797) 与 web (Vite)
```

常用命令：

```bash
mentro-worker doctor  # 探测外部工具可用性（bin/mentro-worker doctor）
pnpm lint             # eslint + prettier --check
pnpm test             # vitest（各包）
```

## 结构

```text
apps/server   Node 24 + Fastify + TypeORM（纯协调层，唯一子进程是 worker）
apps/web      Vue 3 + Vite + Tailwind v4 + shadcn-vue
packages/protocol  worker 协议生成类型 + REST/WS zod schema
proto/        buf 管理的 worker 协议 .proto（唯一提交的协议源）
rust/         Cargo workspace（mentro-worker：提取/扫描/渲染/OCR/容器管理）
```

## 部署

M5 起提供 docker compose 全家桶（server+worker、Gotenberg、PaddleOCR）。跨网访问建议前置反代（Caddy/nginx）终止 TLS。
