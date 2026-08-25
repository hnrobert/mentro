# Mentro 项目计划

> 状态：Draft v1（2026-08-25）
> 背景：架构讨论原文见 [docs/conversation-notes.md](docs/conversation-notes.md)。
> 测试语料：`ref/`（168 个文件 / 2.6 GB：71 PDF、58 PNG、19 PPTX、6 JPG、LaTeX 源文件、1 DOCX），已 gitignore，仅本地使用。

## 1. 项目定位

Mentro 是一个**自部署（self-hosted）的素材索引与检索服务**：跑在一台机器上（工作站 / 家用服务器 / NAS），把它磁盘上的 PPT / PDF / 图片 / 视频 / 文档解析成统一的内容单元（Content Unit）；任意设备的浏览器远端访问，本地毫秒级搜索、精确定位到 PPT 的某一页 / PDF 的某一页 / 视频的某一秒，并为后续 OCR、Embedding、Agent 能力预留架构位置。单机 localhost 模式只是它的一种部署特例。

核心能力：

- 服务端扫描指定根目录，blake3 内容哈希 + MIME 嗅探，增量重扫
- 提取到内容单元粒度：`pdf → page`、`pptx → slide`、`video → 时间段`
- **搜索在浏览器端完成**（索引 bundle 下发到各客户端本地检索，服务端零按键开销，天然适合多端）
- 任意设备点击直达预览：pdf.js 跳页、视频跳时间点（HTTP Range 流式）、幻灯片缩略图
- 文件变化 → 增量提取 → WS 索引增量推送到所有在线客户端
- 部署即服务：**用户账号与 JWT 鉴权**（首个注册者为超级管理员）、多端并发访问、docker compose 一键拉起

非目标（当前版本明确不做）：

- 不做公网 SaaS / 多租户 / 云同步
- 不做第三方登录（OAuth/OIDC/SSO）——用户名密码 + JWT；外部 IdP 留待需求
- 不自己实现任何文件格式解析器，全部调度成熟外部工具
- 不做文件管理器（不移动 / 重命名 / 删除用户文件）

## 2. 架构总览

```text
                    ┌────────────────────────────────┐
                    │      Browser（任意设备）        │
                    │  Vue 3 SPA                     │
                    │  ├── Search UI（本地检索）      │
                    │  ├── Asset Detail / Preview    │
                    │  └── Settings / Jobs           │
                    └───────────────┬────────────────┘
                              HTTP / WS
                    ┌───────────────▼────────────────┐
                    │        mentro-server           │
                    │  Node 22 + TypeScript（纯协调）│
                    │  ├── REST API + WebSocket      │
                    │  ├── Sources / Job Queue       │
                    │  ├── SQLite + TypeORM          │
                    │  └── Index Bundle Builder      │
                    │  —— 仅 spawn worker、不监听 FS│
                    └───────────────┬────────────────┘
                     spawn + protobuf over stdio
                    ┌───────────────▼────────────────┐
                    │     mentro-worker (Rust)       │
                    │  唯一外部集成点                │
                    │  scan / watch / extract /      │
                    │  render / reveal / ocr         │
                    │  ├── 内置: OOXML, text, image  │
                    │  └── 外部: poppler, soffice,   │
                    │          ffmpeg                │
                    └───────────────┬────────────────┘
                        docker / podman（M3 起）
                    ┌───────────────▼────────────────┐
                    │  PaddleOCR serving 容器        │
                    │  PaddleX --serve --pipeline OCR│
                    └────────────────────────────────┘
```

数据流：

```text
Files → scan(Rust) → assets 表 → job queue → extract(Rust+外部工具)
      → content_units 表 → FTS5(服务端兜底) → Index Bundle
      → Browser 本地搜索 → 结果 → 预览/定位
```

三层职责（沿用讨论结论）：

| 层 | 回答的问题 | 归属 |
| --- | --- | --- |
| Extraction | 文件里有什么？ | Rust worker + 外部工具 |
| Index | 这些东西在哪里？ | SQLite + 浏览器索引 |
| Agent（未来） | 用户到底想要什么？ | TS Backend 中的 Tool User，绝不直接碰文件系统 |

### 进程边界（硬约束）

- **mentro-server（Node）**：只做 HTTP/WS、SQLite、job queue、index bundle——除 mentro-worker 外不 spawn 任何子进程，不直接监听文件系统，不调用任何外部工具
- **mentro-worker（Rust）**：所有第三方交互的唯一入口——文件扫描/监听/哈希、poppler / soffice / ffmpeg、PaddleOCR 容器生命周期、Finder 定位。它同时是自包含的 CLI，可脱离 server 独立构建、测试、使用

## 3. 已定的技术决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 前端框架 | Vue 3 + Vite + TypeScript（SPA） | 纯本地工具，无 SEO 需求，不需要 Nuxt |
| 前端状态 / UI | Pinia + Naive UI | Vue 3 原生、TS 友好 |
| 后端运行时 | **Node.js 22 LTS + pnpm**（Robert 拍板，2026-08-25） | 符合个人 TS 规范；放弃 Bun 运行时，SQLite 走 better-sqlite3 |
| 后端框架 | Fastify + @fastify/websocket | 轻量、TS 支持好、内建 schema 校验 |
| 数据库 | SQLite + **TypeORM**（<typeorm@1.x>，better-sqlite3 驱动）+ FTS5 | 单文件、同步驱动适合本地服务；实体/迁移/DataSource 约定见 §5.2；FTS5 作服务端兜底搜索 |
| 数据库迁移 | TypeORM 迁移：`<timestamp>-<PascalCase>.ts`、raw SQL、启动自动应用 | tsup 程序化脚本 `migration:generate/run/revert/check` 替代 typeorm CLI（其 TS loader 在 Node 24 下与 legacy decorators 不兼容） |
| Worker 协议 | **Protobuf**（buf 管 .proto；Rust prost / TS `@bufbuild/protobuf`；stdio 长度分隔帧） | schema 单一权威，codegen 在构建期消灭两端漂移；调试走一次性 CLI 子命令的 JSON 输出 |
| Rust worker | Cargo workspace，protobuf over stdio 长驻进程，**全部第三方集成的唯一入口** | 单机父子进程，裸 protobuf 帧足够，无需 gRPC / SignalR；spawn 一次、常驻、零每次启动开销；Node 侧不直接调外部工具 |
| 内容哈希 | blake3 | GB 级文件哈希速度远超 SHA-256，适合大语料 |
| 文件类型检测 | 内容嗅探（`infer` crate）+ 扩展名兜底 | 不信任扩展名 |
| ID 策略 | ULID（TS 侧生成，worker 只回传） | 可排序、可读；DB 归 TS 所有，worker 保持无状态 |
| PDF 工具 | Poppler（`pdftotext` / `pdftoppm` / `pdfinfo`） | macOS `brew install poppler` 即得，文本+渲染都成熟 |
| Office 渲染 | **Gotenberg 现成镜像**（`gotenberg/gotenberg:8.x-libreoffice`，钉 tag；HTTP API，内置 LibreOffice 进程池） | 宿主机零 Office 依赖；池化热转换免冷启动；与 PaddleOCR 容器同构（`/health` + POST），§7.6 模型统一；注意 8.30 起字体栈精简——钉 tag + ref/ 回归兜底 |
| 素材切割/导出 | PPTX 选页 = **Rust OOXML 手术**（部件原样拷贝，保真）；PDF 选页/合并 = 纯 Rust（`lopdf`）或 qpdf | 手术比 UNO 保存保真（不经重序列化）；跨文件合并 PPTX 是难 case，用 PDF 合成兜底 |
| 媒体工具 | FFmpeg / ffprobe | 元数据 + 抽帧 |
| 文件监听 | Rust `notify` crate（worker `watch` action） | 第三方交互收敛在 Rust；Node 不碰文件系统 |
| Finder 定位 | worker `reveal` action | 平台差异留在 Rust（macOS `open -R`） |
| OCR | **PaddleOCR 官方 serving 容器**（PaddleX `--serve --pipeline OCR`，PP-OCRv5 中英模型） | 中文识别远好于 tesseract；Python 重依赖封进镜像；worker 管容器生命周期，缺运行时则优雅降级（§7.6） |
| 浏览器搜索 V1 | MiniSearch | 轻量、字段加权、fuzzy、prefix；FlexSearch 类型质量差 |
| 浏览器搜索升级 | SQLite WASM FTS5 或 tantivy-wasm | 触发条件见 §9 |
| 包管理 | pnpm（workspace monorepo），`packageManager` 钉版本 | 个人 TS 规范 |
| 网络与鉴权 | **JWT（HMAC-SHA256）+ 刷新会话**：登录发短时 access token + 可吊销 refresh（DB 会话表，每次刷新轮换）；HTTP `Authorization: Bearer`，WS `?token=`；密码 bcrypt（cost 12）；登录限速 | 多端各自登录持有令牌；管理员重置密码即吊销该用户全部会话；文件仅按 assetId 暴露、不接受路径参数（防穿越）；JWT 密钥首次启动生成于 `data/` |
| 部署形态 | docker compose：mentro（server + worker 同容器）+ gotenberg + paddle-ocr，`data/` 卷挂载 | 一条命令拉起全家桶；TLS 不内建，跨网访问建议反代（Caddy / nginx） |

## 4. 仓库结构

```bash
mentro/
├── apps/
│   ├── server/                  # Node 22 + Fastify + TypeORM
│   │   ├── src/
│   │   │   ├── index.ts         # 入口：启动、data 目录锁、spawn worker
│   │   │   ├── db/
│   │   │   │   ├── data-source.ts # AppDataSource 单例 + init/close（启动自动跑迁移）
│   │   │   │   ├── entities/      # *.entity.ts + index.ts 显式 barrel
│   │   │   │   └── migrations/    # <ts>-<PascalCase>.ts + index.ts barrel
│   │   │   ├── routes/          # api/*.ts（assets, sources, index, jobs...）
│   │   │   ├── ws/              # WebSocket 事件广播
│   │   │   ├── queue/           # job queue：调度、重试、熔断
│   │   │   ├── worker/          # mentro-worker 进程管理 + protobuf 帧客户端
│   │   │   ├── fs-events/       # 消费 worker 的 fs 事件 → 去抖 → 入队
│   │   │   └── indexbundle/     # 浏览器索引 bundle 构建 + 增量 delta
│   │   ├── scripts/             # migration:generate/run/revert/check（tsup 构建）
│   │   └── package.json
│   └── web/                     # Vue 3 + Vite SPA
│       ├── src/
│       │   ├── views/           # Search / AssetDetail / Settings
│       │   ├── components/      # 结果卡片、预览器、过滤器
│       │   ├── search/          # 引擎接口 + minisearch 实现（隔离，可换 WASM）
│       │   ├── api/             # REST/WS 客户端 + zod 校验
│       │   └── stores/          # Pinia
│       └── package.json
├── proto/                       # buf 管理的 worker 协议 .proto（唯一权威）
├── packages/
│   └── protocol/                # HTTP/WS zod schema + buf 生成的 TS 协议类型
│       ├── src/schemas/*.ts     # REST/WS DTO 校验（手写 zod）
│       ├── gen/                 # buf generate 产物（@bufbuild/protobuf，提交入库）
│       └── descriptor.bin       # 供 cargo build.rs 消费（pnpm gen:proto 产出）
├── rust/
│   ├── Cargo.toml               # workspace（resolver = "3"）
│   ├── rust-toolchain.toml
│   └── crates/mentro-worker/    # 详见 §7
├── docker/
│   └── office/                  # 可选薄镜像：FROM gotenberg + 补充字体
├── data/                        # 运行时数据（gitignore）
├── ref/                         # 本地测试语料（已 gitignore）
├── testdata/                    # 提交进仓库的小型合成夹具（CI 用）
├── docs/
├── pnpm-workspace.yaml
├── package.json
└── plan.md
```

工具链编排：`pnpm build:worker` 调 `cargo build --release` 并把二进制拷到约定位置；`pnpm dev` 同时起 server 与 Vite。

## 5. 数据模型

### 5.1 存储目录

```text
data/                            # MENTRO_DATA 可覆盖；默认 dev 用 ./data
├── mentro.db                    # SQLite + TypeORM（WAL 模式）
├── thumbs/<assetId>/<unit>.webp # 内容单元缩略图
├── render/<assetId>.pdf         # Office → PDF 渲染缓存
├── office-fonts/                # 用户补充版权字体（进 office 容器：挂载或薄镜像，M3 验证）
├── containers/                  # 容器观察文件（§7.6）
└── logs/                        # server 与 worker 每日滚动日志
```

server 启动时对 `data/` 加 advisory file lock：重复实例立即退出，退出码专用，提示"已在运行"。

### 5.2 数据库层（TypeORM）

数据库层的完整约定（实体格式、迁移流程、DataSource 接线）如下。要点：

- **DataSource**：`src/db/data-source.ts` 导出模块级 `AppDataSource` 单例（无 DI）；`type: 'better-sqlite3'`、`database: <data>/mentro.db`（`MENTRO_DATA` 覆盖）；`synchronize: false`（schema 只经迁移改，注释写明缘由）；`logging: ['error', 'warn']` + 自写静音 Logger；`initDataSource()` 每次启动自动应用 pending 迁移（`runMigrations({ transaction: 'each' })`），由 Fastify 启动钩子调用；`closeDataSource()` 随进程退出
- **实体**：`entities/*.entity.ts` + 显式 barrel（`entities: Object.values(entities)`，无 glob / autoLoadEntities）；`@Entity({ name: 'plural_snake_case' })`；属性 camelCase，多词列显式 `name: 'snake_case'`；**每列显式 `type`**（text / integer / datetime / boolean / blob，不用 varchar）；不用 TypeORM enum——字符串字面量联合写进 JSDoc 注释；**不用关系装饰器**——FK 是普通列，join 手写；无 base entity，字段一律 `!:` 断言；复杂 JSON 值用 ValueTransformer 存 text
- **主键**：全表用 ULID 文本主键（`@PrimaryColumn({ type: 'text', ... })` 自然键写法）；索引与约束名手写 `pk_` / `uq_` / `idx_` 前缀
- **迁移**：`migrations/<timestamp>-<PascalCase>.ts`，类名与 `name` 字段带时间戳后缀；**只写 `queryRunner.query()` raw SQL**，不用 createTable builder；破坏性操作前加 `sqlite_master` / `PRAGMA table_info` 存在性守卫；已提交的迁移永不修改；新文件按时间序登记进 `migrations/index.ts` barrel
- **脚本**：`apps/server/scripts/` 下用 tsup 构建的程序化脚本——`migration:generate`（`driver.createSchemaBuilder().log()` 做 diff，产出 UP/DOWN SQL 数组模板）、`migration:run` / `migration:revert`（与启动共用同一代码路径）、`migration:check`（提交钩子守卫）。不走 typeorm CLI
- **查询风格**：Repository API 为主；QueryBuilder 做聚合；`AppDataSource.query` 参数化 raw SQL 做 upsert 与 FTS MATCH；多写原子性用 `AppDataSource.transaction(m => ...)`
- **tsconfig**：`experimentalDecorators` + `emitDecoratorMetadata`；因每列显式 type，脚本构建可不依赖 metadata

代表实体（完整风格示范）：

```ts
import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity({ name: 'assets' })
@Index('uq_assets_path', ['path'], { unique: true })
@Index('idx_assets_source', ['sourceId'])
export class Asset {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'pk_assets' })
  id!: string // ULID

  @Column({ name: 'source_id', type: 'text', nullable: false })
  sourceId!: string

  @Column({ type: 'text', nullable: false })
  path!: string

  @Column({ name: 'size_bytes', type: 'integer', nullable: false })
  sizeBytes!: number

  @Column({ name: 'mtime_ms', type: 'integer', nullable: false })
  mtimeMs!: number

  @Column({ name: 'content_hash', type: 'text', nullable: true })
  contentHash!: string | null // blake3 hex

  @Column({ type: 'text', nullable: true })
  mime!: string | null

  @Column({ type: 'text', nullable: false })
  kind!: string // 'text'|'pdf'|'presentation'|'document'|'spreadsheet'|'image'|'video'|'audio'|'archive'|'other'

  @Column({
    name: 'extraction_status',
    type: 'text',
    nullable: false,
    default: 'pending',
  })
  extractionStatus!: string // 'pending' | 'running' | 'done' | 'failed' | 'skipped'

  @Column({ name: 'extraction_version', type: 'integer', nullable: true })
  extractionVersion!: number | null // 提取器版本，bump 触发全量重提取

  @Column({ name: 'extracted_at', type: 'datetime', nullable: true })
  extractedAt!: Date | null

  @Column({ type: 'text', nullable: true })
  error!: string | null
}

@Entity({ name: 'content_units' })
@Index(
  'uq_content_units_asset_ordinal_type',
  ['assetId', 'ordinal', 'unitType'],
  { unique: true },
)
export class ContentUnit {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'pk_content_units' })
  id!: string // ULID

  @Column({ name: 'asset_id', type: 'text', nullable: false })
  assetId!: string

  @Column({ type: 'integer', nullable: false })
  ordinal!: number // 页/幻灯片/表序号，1-based；整文件类为 1

  @Column({ name: 'unit_type', type: 'text', nullable: false })
  unitType!: string // 'page' | 'slide' | 'sheet' | 'frame' | 'whole'

  @Column({ type: 'text', nullable: true })
  title!: string | null

  @Column({ type: 'text', nullable: true })
  text!: string | null // 提取文本（可空：纯图/无字幕视频）

  @Column({ name: 'start_ms', type: 'integer', nullable: true })
  startMs!: number | null // 音视频定位

  @Column({ name: 'end_ms', type: 'integer', nullable: true })
  endMs!: number | null

  @Column({ name: 'thumb_path', type: 'text', nullable: true })
  thumbPath!: string | null // 相对 data/ 路径

  @Column({ name: 'meta_json', type: 'text', nullable: true })
  metaJson!: string | null
}
```

其余各表同风格：`sources`（id、rootPath 唯一、addedAt、lastScanAt）、`jobs`（id、assetId、kind、status、attempts 默认 0、errorCode、error、createdAt、updatedAt）、`index_state`（key 主键、value——存 index_version 等）。认证三表：

- `users`：id、`username` 唯一（`/^[A-Za-z0-9_-]{3,32}$/`）、`password_hash`（bcrypt cost 12，只存哈希、日志零出现）、`role`（`'super_admin' | 'user'`——首个注册者即 super_admin）、`enabled`（默认 true）、`created_at`、`last_login_at`
- `user_sessions`：id、`user_id`、`refresh_hash`（refresh token 只存哈希）、`created_at`、`expires_at`、`revoked_at`——多端会话可见、可吊销；刷新即轮换（旧 token 作废）
- `settings`：key 主键、value——`allowRegistration`（默认 true）等运行时开关

**FTS5**：`units_fts` 是 external-content 虚拟表 + `content_units` 同步触发器，TypeORM 建模不了——在 Init 迁移里以 raw SQL 建立（DDL 数组循环执行的基线风格）；后续涉及可搜列的实体改动，在同一条迁移里维护触发器。服务端兜底搜索走 `AppDataSource.query('... WHERE units_fts MATCH ?', [q])`。

### 5.3 Asset URI

前端一律用 ID 定位，不用文件路径：

```text
mentro://<assetId>/page/23
mentro://<assetId>/slide/12
mentro://<assetId>/time/372.4      # 视频秒
mentro://<assetId>/sheet/2
```

### 5.4 变更检测与重提取

- 重扫时：`mtime + size` 未变 → 跳过；变了 → 重算 blake3，hash 相同 → 仅更新 mtime
- hash 变化 / `extraction_version` bump → 重新入队提取
- 提取结果写入前校验栅栏三元组（§6.3），文件已再次变化的结果直接丢弃

## 6. 协议设计

协议分两段：**浏览器 ↔ server** 是 JSON（REST/WS），由 `packages/protocol` 的手写 zod schema 校验；**server ↔ worker** 是 protobuf，由 `proto/` 下 buf 管理的 `.proto` 唯一权威定义、两端 codegen——schema 漂移在构建期即被消灭，无需 golden 文件机制（§6.3）。

### 6.1 HTTP API

鉴权：除 `/api/auth/*`、健康检查与静态资源外，所有端点要求 `Authorization: Bearer <JWT>`（WS 用 `?token=`）。注册在用户数为 0 时无条件开放（首位注册者成为 super_admin）；否则受 `allowRegistration` 设置控制。

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册：用户名 `/^[A-Za-z0-9_-]{3,32}$/`、密码 ≥ 8 位；用户数 0 时开放且成为 super_admin |
| POST | `/api/auth/login` | 登录 → access + refresh 令牌对；限速防暴破 |
| POST | `/api/auth/refresh` | 刷新（refresh 轮换，旧 token 作废） |
| POST | `/api/auth/logout` | 吊销当前 refresh 会话 |
| GET | `/api/auth/me` | 当前用户信息 |
| POST | `/api/auth/password` | 修改自己的密码（成功后吊销其他会话） |
| GET | `/api/status` | server / worker / 外部工具可用性 |
| GET | `/api/sources` | 源列表 |
| POST | `/api/sources` | 添加源 `{ rootPath }`，触发首扫并建立监听 |
| DELETE | `/api/sources/:id` | 移除源（保留已提取内容可选） |
| POST | `/api/sources/:id/rescan` | 全量重扫 |
| GET | `/api/assets` | 分页 + kind/source/时间过滤 |
| GET | `/api/assets/:id` | 详情 + content units |
| GET | `/api/assets/:id/file` | 原文件流（预览用，Range 支持） |
| POST | `/api/assets/:id/reveal` | Finder 定位（转发 worker `reveal`） |
| GET | `/api/index` | 浏览器搜索 bundle（ETag = index_version） |
| GET | `/api/thumbs/:unitId` | 缩略图（懒渲染的触发点） |
| POST | `/api/render/:assetId/:ordinal` | 请求渲染指定单元 |
| GET | `/api/jobs` | 任务列表与状态 |
| POST | `/api/assets/:id/retry` | 手动重试失败提取 |
| POST | `/api/export` | 选单元集合 + 目标格式 → 导出 job（M6；PDF 切割合并 / PPTX OOXML 手术） |
| GET | `/api/admin/users` | 用户列表（super_admin） |
| PATCH | `/api/admin/users/:id` | 修改用户名 / 启用禁用（super_admin 不可被禁用） |
| POST | `/api/admin/users/:id/reset-password` | 管理员重置密码：返回一次性新密码，并吊销该用户全部会话 |
| DELETE | `/api/admin/users/:id` | 删除用户（不可删自己；连带吊销会话） |
| GET/PATCH | `/api/admin/settings` | 读取/设置 `allowRegistration` 等（super_admin） |

### 6.2 WebSocket 事件（`/api/ws`）

```json
{"event": "pipeline.snapshot", "revision": 57, "phase": "extract", "assetsDone": 42, "assetsTotal": 168, "jobsActive": 3}
{"event": "index.delta", "fromVersion": 41, "toVersion": 42, "upserted": [], "removed": ["01J9Z..."]}
{"event": "job.updated", "jobId": "01J9...", "status": "failed", "error": "TIMEOUT: soffice exceeded 120s"}
```

- `pipeline.snapshot` 采用**版本化快照**模式：server 计算呈现快照并带 revision，前端只渲染快照 diff，不从事件顺序推断状态
- `index.delta`：客户端发现 `fromVersion` 与本地版本不连续 → 回退全量拉 `/api/index`

### 6.3 Worker Protobuf 协议（stdio）

worker 协议由 `proto/` 下 buf 管理的 `.proto` 唯一权威定义，两端 codegen：Rust 走 prost（`build.rs` 消费 `pnpm gen:proto` 产出的 `descriptor.bin`，缺失时报清晰错误），TS 走 `@bufbuild/protobuf`（生成物进 `packages/protocol/gen/`，提交入库）。传输为 stdio 上的**长度分隔帧**（varint 长度前缀 + 消息体，帧上限 32 MB），单一 envelope `WorkerFrame` 作唯一解码点：

```protobuf
message WorkerFrame {
  oneof body {
    // server → worker 请求
    ScanRequest scan = 1;           // root
    ExtractRequest extract = 2;     // assetId + contentHash（栅栏）+ kind + want[] + options
    RenderRequest render = 3;       // assetId + contentHash + ordinal + want
    StatRequest stat = 4;           // paths[]
    CancelRequest cancel = 5;       // jobId
    WatchRequest watch = 6;         // sourceId + root
    UnwatchRequest unwatch = 7;     // sourceId
    RevealRequest reveal = 8;       // path
    OcrRequest ocr = 9;             // assetId + contentHash + ordinal
    ExportRequest export = 10;      // units[]（assetId+ordinal 集合）+ format(pdf|pptx)；M6
    // worker → server 事件与应答
    ReadyEvent ready = 20;          // 协议版本 + capabilities + tools 探测
    Response response = 21;         // 回带请求 id；ok 时按请求类型回填 result，否则 error
    ProgressEvent progress = 22;    // id + done/total + unit
    LogEvent log = 23;              // level + message
    FsEvent fs = 24;                // sourceId + path + kind
    OcrStatusEvent ocr_status = 25; // state + detail
  }
}

message ErrorInfo {
  ErrorCode code = 1; // TOOL_MISSING / TOOL_TIMEOUT / TOOL_NON_ZERO_EXIT / ... 枚举
  string message = 2;
  bool retryable = 3; // 超时/工具崩溃可重试；格式损坏/不支持不可重试
}
```

要点：

- **握手**：进程启动即发 `ready`（协议版本 + capabilities + 外部工具探测结果），server 据此降级功能（如无 soffice 则 PPT 只出文本不出缩略图）
- **栅栏三元组**：每个 extract/render 请求带 `assetId + contentHash`，响应原样带回；server 落库前校验，过期结果丢弃（fencing triple，防陈旧写）
- **fs 事件**：worker 只上报原始事件，去抖/聚合在 server 侧（编辑器连发写不应触发重复提取）
- **ocr**：worker 内部先渲染页图再送容器；容器懒启动期间的 ocr job 排队等待 `ocr_status: ready`
- stdout 上**只有 protobuf 帧**；人读日志走 `log` 事件或 stderr
- **调试**：`serve` 模式的管道是二进制；日常调试走一次性子命令（`extract` / `scan` / `doctor` / `ocr`，输出 JSON 文本，见 §7.2）

## 7. Rust Worker 设计

### 7.1 Workspace 结构

```text
rust/crates/mentro-worker/
├── Cargo.toml
└── src/
    ├── main.rs            # clap 入口：serve / extract / scan / doctor
    ├── cli/               # args.rs（clap derive）、shell.rs（双流输出）
    ├── proto/             # prost 生成类型（build.rs 消费 descriptor.bin，缺失报清晰错误）
    ├── serve.rs           # stdio 事件循环：读长度分隔帧 → 分发 → 并发执行 → 写帧
    ├── scan.rs            # jwalk 并行遍历 + blake3 + infer 嗅探
    ├── watch.rs           # notify 监听源目录 → fs 事件
    ├── reveal.rs          # Finder 定位等平台操作
    ├── ocr.rs             # PaddleOCR 容器生命周期 + HTTP 客户端（§7.6）
    ├── job.rs             # job 状态机、重试分类、熔断计数
    ├── extract/           # mod.rs 按 kind 分发；text.rs / pdf.rs / ooxml.rs / image.rs / media.rs
    ├── export/            # 导出（M6）：pptx.rs（OOXML 手术）/ pdf.rs（切割合并，lopdf）
    └── ext/               # 子进程封装：mod.rs / poppler.rs / soffice.rs / ffmpeg.rs / container.rs
```

V1 单二进制即可；若未来出现第二个 bin，再把 `proto/` 生成模块拆成 `mentro-proto` crate。

### 7.2 CLI 设计（Cargo 风格）

```bash
mentro-worker serve                          # protobuf 长驻模式（server spawn 用）
mentro-worker extract <path> [--json]        # 单文件提取，结果 JSON 到 stdout
mentro-worker scan <root> [--json]           # 扫描，输出文件记录流
mentro-worker doctor                         # 探测外部工具、容器运行时与版本
mentro-worker ocr <image> [--json]           # 单图 OCR（调试容器链路）
```

- 全局 flag：`--color {auto,always,never}`、`-v/--verbose`、`-q/--quiet`
- 自包含：不依赖 server 代码，可独立 `cargo build` / `cargo test` / 单独分发使用
- **双流输出**：人读状态/诊断 → stderr（固定左对齐状态列、绿/黄/红/暗四档），机器结果 → stdout；`--json` 时 stdout 仅 JSON
- 错误：`anyhow` 链 + 自定义退出码（0 成功 / 1 用户错误 / 101 内部失败 / 130 中断）

### 7.3 可靠性设计模式

| 模式 | Mentro 实现 |
| --- | --- |
| 身份栅栏（fencing triple） | 每个请求带 `assetId + contentHash`，响应回带，落库前校验，防陈旧写 |
| 数据目录锁 + 专用退出码 | server 对 `data/` 加锁，重复启动 → 专用退出码 + 明确报错 |
| 类型化杀灭通道（防 PID 复用） | 外部工具的杀灭命令走 mpsc 通道，只由仍持有原 `tokio::process::Child` 的 task 执行 |
| 进程组杀灭 | Unix `process_group(0)`：soffice/ffmpeg 放独立进程组，超时先 SIGTERM 组、宽限后 SIGKILL 组，防孙进程（soffice.bin 等）泄漏 |
| 外部工具并发隔离 | LibreOffice 经 Gotenberg 进程池（并发管理在容器内，worker 侧限流 2）；ffmpeg 用独立并发池 |
| 外部资源独占所有权 + 观察文件 | PaddleOCR 容器由 worker 独占持有：观察文件 + `docker inspect` 认领/回收（§7.6） |
| 崩溃循环熔断 | 同一 asset 连续 3 次提取失败 → `failed`，不再自动重试，等手动 retry 或重扫 |
| 退出处置状态机 | job 状态机 + `retryable` 错误分类；deadline 驱动重试，不在 handler 里 sleep |
| 版本化进度快照 | `pipeline.snapshot` 事件带 revision，节流渲染；前端只渲染快照 diff |
| 双流 CLI 输出 | stderr 人读 / stdout 机器（§7.2） |
| 每日滚动分级日志 | worker 日志写 `data/logs/worker/`，tracing + 滚动 appender |
| 纯状态机内联测试 | `#[cfg(test)]` 只测无 IO 的状态机（§11） |
| pnpm 编排多语言构建 | `pnpm build:worker` 编排 cargo 并拷贝二进制 |

**明确不做**：gRPC / SignalR 等重型 RPC（单机父子 IPC，裸 protobuf 帧足够）；浏览器侧 protobuf（HTTP/WS 保持 JSON + zod）；独立 Agent 进程（TS backend 承担）；worker 断线重连（父子同生命周期，daemon 化时再引入）。

### 7.4 并发模型

- `serve.rs` 单事件循环读 stdin，分发到 job 任务；在途上限默认 `num_cpus / 2`（`MENTRO_WORKER_CONCURRENCY` 可调）
- LibreOffice（经 Gotenberg）worker 侧并发限 2，池化管理交给容器；ffmpeg/ffprobe 池 = 2；Poppler/Rust 原生提取只受在途上限约束
- 每次 `extract` 内部：先文本（快、必成），后渲染（慢、可失败可降级）——渲染失败不影响文本入索引
- OCR 页请求并发 ≤ 2（CPU 推理）；容器懒启动期间相关 job 排队，不占并发槽

### 7.5 外部工具封装契约（`ext/mod.rs`）

```rust
pub async fn run(cmd: PreparedCommand, timeout: Duration) -> Result<Output, ExtError>
// 契约：
// - Unix: process_group(0)；超时 → SIGTERM 进程组 → 3s 宽限 → SIGKILL 进程组
// - 杀灭经类型化通道发给持有 Child 的 task（防 PID 复用误杀）
// - stdout/stderr 限量捕获（16 MB 环形缓冲）；需要流式时走逐行回调，回调故障 fail-open
// - 每类工具声明探测方式（--version），doctor 与 serve 握手共用
```

`ExtError` → 协议错误码映射：`TOOL_MISSING` / `TOOL_TIMEOUT` / `TOOL_NON_ZERO_EXIT` / `OUTPUT_TOO_LARGE` / `CANCELLED` / `UNSUPPORTED` / `INVALID_INPUT` / `INTERNAL`。

LibreOffice 渲染走 **Gotenberg 现成镜像**（`gotenberg/gotenberg:8.x-libreoffice`，钉 tag），由 worker 独占持有（§7.6）。每次转换即一次 HTTP 调用，无需挂载工作目录：

```text
worker 读源文件字节
  → POST <office>/forms/libreoffice/convert（multipart）
  ← PDF 字节 → 写入 render/<assetId>.pdf
  → 宿主机 pdftoppm 出页图
```

- 进程池常驻热转换，无每次 soffice 冷启动；超时走 HTTP 客户端，容器无响应 → §7.6 回收重建
- 8.30 起内置字体栈精简（30+ → 8 包）：钉 tag，升级后必须跑 ref/ 渲染回归
- 用户版权字体：`<data>/office-fonts` 运行时挂载（M3 验证）或薄 Dockerfile `FROM gotenberg/gotenberg:8.x-libreoffice` + `COPY`

### 7.6 容器管理（mentro-office / mentro-paddle-ocr）

重依赖外部工具全部容器化，由 worker 独占持有，遵循「独占所有权 + 观察文件 + 崩溃恢复收尾」的管理模式。观察文件按容器存放（`data/containers/<name>.json`：容器名、端口、启动时间戳），worker 重启后 `docker inspect` 校验认领；不匹配则回收重建，绝不接管来历不明的容器。

**mentro-office（M3，Gotenberg 现成镜像 `gotenberg/gotenberg:8.x-libreoffice`）**：懒启动于首个需要渲染的 extract/render 请求；就绪探测 `/health`；文件经 HTTP 传输，无需挂载工作目录（§7.5）。

**mentro-paddle-ocr（M5，官方 serving 镜像）**：懒启动于首个 `ocr` action，就绪探测 `/health`，首次拉镜像可达数分钟、进度经 `ocr_status` 事件上报：

```bash
docker run -d --name mentro-paddle-ocr \
  -p 127.0.0.1:9300:9300 \
  -v <data>/paddle-cache:/root/.paddlex \
  <paddle-serving-image>   # PaddleX --serve --pipeline OCR，镜像 tag 于 M5 落地时锁定
```

- **运行时探测**：依次探测 `docker` 与 `podman` CLI（Docker Desktop / OrbStack / colima 均提供 `docker` CLI，无需特判）；全部缺失 → 对应 capability 缺失，功能优雅降级（Office 仅文本、OCR 不可用），Settings UI 给安装指引。部署产物以 docker compose 为一等目标；podman compose 兼容但非一等测试目标（其 rootless 优势主要在 Linux 部署）
- **请求协议**：`ocr` action 内部先渲染页图（pdftoppm 或复用缩略图）→ base64 POST → PaddleX serving JSON（文本 + 框 + 置信度）→ 写入对应 content_unit 的 text
- **失败处置**：容器崩溃自动重启一次，再失败则本 session OCR 熔断（UI 可手动重置）
- 模型与 Python 依赖全部封在镜像内：Mentro 仓库、worker 构建零 Python 依赖

## 8. 提取器矩阵

| 格式 | 文本提取 | 缩略图/渲染 | 定位粒度 | 工具 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| txt / md / csv / json | Rust 原生 | 无 | whole | — | M1 |
| pdf | `pdftotext`（`\f` 分页） | `pdftoppm` | page | poppler | M1 |
| pptx | OOXML：presentation.xml 定序 → slides/notes 的 `a:t` | Gotenberg(容器)→pdf→`pdftoppm` | slide | 自研 + Gotenberg | M3 |
| docx | OOXML：`w:t` + 标题样式 | Gotenberg(容器)→pdf | page | 自研 + Gotenberg | M3 |
| xlsx | sharedStrings + sheet 名 | 无 | sheet | 自研 | M3 |
| png / jpg / webp | EXIF（`kamadak-exif`） | `image` crate 缩放 | whole | Rust 原生 | M4 |
| mp4 / mov / mkv | —（M6 转写） | ffmpeg 抽帧（poster + 场景帧） | 时间段 | ffmpeg/ffprobe | M4 |
| mp3 / wav | —（M6 转写） | 无 | 时间 | ffprobe | M4 |
| heic | — | libheif | whole | libheif | M5 |
| epub / zip | zip + html 文本 | 封面 | chapter | Rust crate | M5 |
| 扫描版 PDF / 图片 OCR | PaddleOCR 容器（PP-OCRv5，中英） | — | page / whole | docker + PaddleX serving | M5 |

设计原则（沿用讨论结论）：**Rust owns the pipeline, not the formats**。每个提取器只输出统一的 Content Units；某工具渲染失真时换掉该提取器即可，不动核心。提取器带版本号（`extraction_version`），升级即全量重提取。

缩略图策略：扫描期只出 cover（第 1 页/幻灯片/海报帧），其余页懒渲染（`POST /api/render/...` 触发），保证大语料首扫速度。

**为什么 Office 渲染要经 PDF 中转**：LibreOffice/Gotenberg 没有可靠的逐页图像导出（图像过滤器只出第一页），PDF 是其唯一的一等全量导出格式；且 `render/<assetId>.pdf` 这一份缓存同时服务三个消费者——懒渲染缩略图（pdftoppm 按需出任意页任意分辨率）、pdf.js 浏览器跳页预览、M6 选页导出（直接切割合并，零再转换）。

## 9. 浏览器搜索

### 9.1 V1：MiniSearch

`/api/index` 下发 bundle（ETag = index_version），前端构建 MiniSearch：

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

- 字段：`title^3, fileName^2, text`；fuzzy 0.2、prefix、AND 语义
- 过滤（kind / source / 时间）在结果后置过滤（V1 数据量下足够快）
- bundle 存内存 + localStorage 记版本号；WS `index.delta` 增量合并
- 多端各拉一份 bundle（gzip + ETag 协商缓存）；移动端对体积敏感，§9.2 触发线同样适用

### 9.2 升级触发与路径

触发条件（任一）：内容单元 > 5 万、bundle > 50 MB、冷启动构建 > 500 ms。

路径 A：server 直接导出 FTS5 db 文件 → 浏览器 sql.js（SQLite WASM）查询。
路径 B：Tantivy → WASM，与 server 共用一套 Rust 搜索逻辑（讨论中的长期方向）。

搜索模块在 `apps/web/src/search/` 以接口隔离（`engine.ts` 定义 `SearchEngine` 接口），MiniSearch 只是第一个实现，替换不动 UI。

## 10. 前端设计

| 视图 | 内容 |
| --- | --- |
| Login | 登录 / 注册（`allowRegistration` 关闭时隐藏注册入口；首位用户注册页提示将成为管理员） |
| Search | 搜索框 + 过滤器（类型/源/时间）、结果卡片（缩略图 + 高亮摘要）、键盘导航 |
| AssetDetail | 单元列表（页/幻灯片缩略图 + 文本）、元数据、打开文件 / Finder 定位 |
| Settings | 源管理、任务监控（pipeline 快照渲染）、外部工具状态（doctor 结果）、用户管理（super_admin：列表 / 改名 / 禁用 / 重置密码 / 删除 / 注册开关）、修改自己的密码 |

预览交互：

- PDF：pdfjs-dist，跳到 `ordinal` 页
- PPT slide：服务端渲染的 webp 图
- 视频：`<video>` + `#t=start秒` 定位
- 图片：原图（`/api/assets/:id/file`）
- 文本：片段预览

UI 文案中文优先；响应式布局——手机 / 平板浏览器可用（搜索与预览为主战场）。

## 11. 测试与质量

### 11.1 Rust

- **内联单测**（`#[cfg(test)]`，只测无 IO 的纯逻辑）：proto 编解码 roundtrip、OOXML 解析（fixture 字节）、job 状态机与重试分类、熔断计数、scan 过滤规则
- **集成测试**（`tests/`，`CARGO_BIN_EXE_mentro-worker` spawn 真二进制）：`extract`/`doctor`/`scan` 的 stdout 字节断言；`serve` 模式喂 protobuf 帧验证握手与栅栏
- 依赖外部工具的用例以 `MENTRO_E2E=1` 门控（本机与专用 CI job 跑）；OCR 用例另需容器运行时 + 镜像（约 2 GB），以 `MENTRO_E2E_OCR=1` 单独门控，CI 默认不拉镜像

### 11.2 TypeScript

- vitest：HTTP/WS zod schema roundtrip、worker 协议（生成类型）编解码 roundtrip、index bundle 构建、delta 合并、queue 调度与熔断
- DB：临时 DB_PATH 上跑迁移 + 实体读写 roundtrip（selftest 形态）
- 集成测试：起 server + worker，扫 `testdata/`，断言入库与 bundle

### 11.3 语料测试（本地）

`pnpm test:corpus`：扫 `ref/` → 断言 ≥ 160 assets、PDF/PPTX 全部 `done`、单元数合理、人工挑选的 3–5 个已知文本命中正确页码。CI 不跑（语料不入库），CI 用 `testdata/` 小型合成夹具。

### 11.4 CI 与规范

- CI（GitHub Actions）：lint（prettier --check、eslint、cargo fmt --check、clippy -D warnings、pnpm migration:check、pnpm gen:proto 幂等检查——生成物与 .proto 必须同步）+ 单测矩阵（macOS / Ubuntu）；外部工具 e2e 单独 job（apt 安装 poppler/libreoffice/ffmpeg）。写 workflow 时按 hnrobert-github-actions 规范执行
- 迁移守卫：husky + lint-staged 跑 `pnpm migration:check`——staged 实体改动未附带新登记的迁移则拦截提交
- 代码规范：TS 按 hnrobert-typescript（Prettier 2-space/printWidth 80、eslint flat config、pnpm 钉 `packageManager`）；Markdown/YAML/JSON 按 hnrobert-docs-style；Rust 用 rustfmt 默认 + clippy
- 提交信息 Conventional Commits（hnrobert-commit-message）；git 操作遵循 hnrobert-git-safety

## 12. 里程碑

| 阶段 | 内容 | 验收标准（基于 ref/ 语料） | 规模 |
| --- | --- | --- | --- |
| M0 脚手架 | pnpm workspace、apps/server、apps/web、packages/protocol、proto/（buf + 双端 codegen）、rust workspace、规范文件（.editorconfig/.prettierrc/eslint.config.js 从技能 assets 拷贝）、CI 骨架 | `pnpm gen:proto` 双端生成物就绪；`pnpm dev` 同时起 server+web；`pnpm build:worker` 出二进制；CI 绿 | S |
| M1 用户+扫描+文本+服务端搜索 | 用户体系与 JWT（注册/登录/首个超管/注册开关/改密/管理端用户管理/会话吊销）、worker scan/stat/extract(text,pdf)+doctor；SQLite 迁移、job queue、FTS5；登录页 + 极简搜索页 | 首位注册者成为 super_admin 并可关闭注册；第二用户受开关控制；管理员重置密码后旧会话全部失效；ref/ 全量扫描完成；71 个 PDF 文本可搜并定位到页；重扫跳过未变文件 | L |
| M2 浏览器本地搜索+多端 | `/api/index` bundle、WS delta、MiniSearch、pdf.js 跳页预览、token 鉴权与非回环绑定 | 二次搜索本地 < 50 ms；文件变更增量生效；bundle gzip 后 < 20 MB；第二台设备经 LAN 全流程可用 | M |
| M3 Office | Gotenberg office 容器（现成镜像钉 tag）、pptx/docx/xlsx 文本（OOXML）、HTTP 渲染管线、页缩略图、懒渲染 | 19 个 PPTX 每页可搜、可看缩略图；PDF 页数与幻灯片数一致性校验通过（隐藏页等错位 case 被识别）；无容器运行时降级为仅文本；容器无响应/崩溃不影响 worker 存活（回收重建）；熔断生效 | L |
| M4 媒体+增量监听 | 图片 EXIF+缩略图、ffprobe 元数据、视频海报帧+时间定位、notify 增量监听（worker `watch`） | 58 PNG + 6 JPG 可搜可缩略；视频结果点击跳时间点；新增文件自动入索引 | M |
| M5 OCR + 补充格式 | PaddleOCR 容器（懒启动 + 生命周期管理 + 运行时探测）、heic、epub、docker compose 全家桶部署 | 扫描版海报文字可搜（中英）；无容器运行时的环境优雅缺失并明示；容器崩溃/OCR 失败不阻塞管线；compose 一键拉起后全功能可用 | L |
| M6 智能层 | Whisper 转写、embedding 语义搜索、Agent Tool API（含 PPTX 选页切割与 PDF 合成导出）、WASM 搜索评估 | 音视频可按内容搜；Agent 经 Tool API 完成"找+取+导出"闭环（PPTX 选页保真导出）；索引规模达到 §9.2 触发线时完成升级评估 | L+ |

规模：S ≈ 1–2 天，M ≈ 3–5 天，L ≈ 5–8 天（业余时间投入的粗估）。

M6 Agent Tool API 草案（Agent 只能经此 API 操作，不碰文件系统）：

```text
search(query, filters) -> SearchResult[]
get_asset(id) / get_unit(id) / get_context(unitId, before, after)
render(unitId) -> 图像
extract(units) -> 选页导出（PPTX：Rust OOXML 手术，部件原样拷贝；PDF：纯 PDF 切割合并）
transcribe(assetId) -> 带时间戳文本
```

## 13. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| LibreOffice 渲染失真（字体/SmartArt/公式） | 幻灯片预览与 PowerPoint 不一致 | 文本索引不依赖渲染；渲染失败降级为无缩略图；`<data>/office-fonts` 补版权字体（挂载或薄镜像）；macOS 可选 AppleScript 驱动 PowerPoint 导出作为替代渲染器（提取器可替换） |
| Gotenberg 第三方依赖（API 与镜像更新） | 升级后转换行为/字体变化 | 钉 tag，升级 = 显式决策 + ref/ 渲染回归；ext 层隔离使其整体可替换 |
| PDF 页 ↔ 幻灯片序号错位（隐藏页等） | 页级缩略图/导出选错页 | 提取时校验 pdfinfo 页数 == 幻灯片数；不一致则标记映射可疑、禁用该 asset 的页级操作 |
| 网络暴露文件内容 | 未授权访问泄露素材 | JWT 全端点鉴权；文件仅按 assetId 暴露、无路径参数；TLS 交反代；默认仍 127.0.0.1 |
| 认证安全（暴破 / 令牌泄露） | 账户被入侵 | bcrypt cost 12；登录限速；access 短时 + refresh 轮换可吊销；重置密码即吊销全部会话；JWT 密钥生成于 `data/`（备份即迁移） |
| soffice 启动慢、profile 锁 | 批量首转慢 | 独立 UserInstallation、全局串行、首批预热一个实例常驻评估 |
| 扫描版 PDF 无文本 | 搜不到 | V1 标记 no-text 不阻塞；M5 OCR 补齐 |
| 巨文件哈希/提取耗时 | 扫描与队列堵塞 | blake3（GB/s 级）；mtime+size 预筛；job 超时 + 熔断 |
| better-sqlite3 原生模块 | Node 版本升级需重编 | engines 钉 Node 22；CI 矩阵覆盖 darwin/ubuntu |
| TypeORM 1.x 主线较新 | API / 文档滞后 | 钉住小版本，升级经迁移 selftest 验证；每列显式 type 降低对 emitDecoratorMetadata 的依赖 |
| ref/ 语料不可入库 | CI 无法用真实语料 | ref/ 已 gitignore；CI 用 testdata/ 合成夹具；corpus 测试仅本地 |
| MiniSearch 规模上限 | 搜索变慢/内存涨 | §9.2 明确触发线与两条升级路径 |
| 外部工具缺失 | 功能降级 | doctor + capabilities 上报，UI 明示缺什么、装什么 |
| PaddleOCR 镜像 ~2 GB、首次拉取慢 | 首次 OCR 等待久 | 懒启动 + `ocr.status` 进度 + 模型缓存卷；tag 锁定后 README 提供预拉命令 |
| CPU 推理约 1–3 s/页 | 大文档 OCR 耗时 | 页级并发 ≤ 2 + 逐页进度；预留 GPU 直通参数位 |
| 容器运行时缺失（M3 起成为渲染硬依赖） | Office 缩略图与 OCR 不可用 | doctor 探测 docker/podman/OrbStack/colima；capability 优雅降级 + UI 指引；文本索引不受影响 |

## 14. 未来方向（记录，不承诺）

- 多源去重（同 content_hash 的缩略图/渲染缓存共享）
- WASM 搜索引擎（Tantivy）与 server 共用 Rust 搜索逻辑
- Agent workspace：跨文件"选页 → 合成新 PDF/PPTX"的素材操作闭环
- 时间胶囊视图（按 mtime/事件重组）、标签、收藏
- 角色细分与授权（如只读用户）、第三方登录（OAuth/OIDC）、公网部署参考配置（反代 + TLS）
- OCR GPU 直通（容器 `--gpus` 参数位已预留）
- Windows / Linux 适配（`open -R` 等平台点已隔离）
