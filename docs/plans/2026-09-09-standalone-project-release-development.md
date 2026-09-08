# ai-x-lightweight 独立仓库、单镜像运行与发布开发方案

> 状态：Proposed，待实施
> 日期：2026-09-09
> 当前来源分支：`refactor/lightweight-skill-orchestration`
> 目标仓库：`yssssssssssss/ai-x-lightweight`
> 目标版本：`v0.1.0`
> 运行形态：单应用镜像 + 外部 PostgreSQL + 持久化 Artifact 目录
> 发布产物：GHCR 镜像 + GitHub Release
> 历史策略：保留当前分支的完整 Git ancestry，不 squash、不重新初始化历史

## 1. 决策摘要

本阶段把当前 linked worktree 转换为可独立 clone、构建、运行和发布的项目，但不改写业务 Runtime，不建设 Kubernetes、多容器微服务或通用部署平台。

目标结构：

```text
GitHub Repository
└── yssssssssssss/ai-x-lightweight
    ├── 完整 Git 历史
    ├── Node API
    ├── Vite Web build
    ├── Skill / Knowledge / Schema
    ├── Database migrations
    ├── Dockerfile
    ├── GHCR image
    └── GitHub Release

Production
├── ai-x-lightweight 单镜像
│   ├── Node API
│   ├── Web 静态文件
│   └── /api 同源路由
├── 外部 PostgreSQL
└── 持久化 RUN_WORKSPACE_ROOT
```

第一版只支持单应用实例。当前 Artifact Store 使用本地文件系统；在没有共享对象存储前，不支持多个应用副本同时对外服务。

### 1.1 设计规模检查

该任务必然同时涉及 Git、构建、运行、容器和 Release，修改文件会超过 5 个。首版仍限制为以下最小新增文件：

1. `README.md`
2. `tsconfig.build.json`
3. `Dockerfile`
4. `.dockerignore`
5. `.github/workflows/release.yml`

其他工作修改现有文件完成。不新增部署框架、配置中心、Helm、Kubernetes、Terraform、npm 发布或自动生产部署。

## 2. 当前状态与证据

### 2.1 已具备的独立运行基础

当前源码已经自包含：

- API、Web、Runtime、Skill、Knowledge、Schema 均在当前目录；
- 生产源码未发现对原 Worktree `/Users/heyunshen/work/PROJECT/jdc/ai-x` 的绝对路径依赖；
- 根目录和 Web 均有独立 lockfile；
- PostgreSQL migration 与 seed 可运行；
- `.env.example` 已列出主要 Runtime 配置；
- CI 已覆盖 TypeScript、Registry/Knowledge lint、全量测试、Web build 和真实 Smoke；
- `RUN_WORKSPACE_ROOT` 已作为 Artifact 根目录；
- API 已有 `/api/healthz` 和 SIGTERM/SIGINT 优雅关闭。

当前开发启动：

```text
pnpm dev:stack start
├── API 3001
└── Web 5173（Vite /api proxy → API）
```

### 2.2 尚未独立的部分

当前 `.git` 是 linked worktree 指针：

```text
gitdir: /Users/heyunshen/work/PROJECT/jdc/ai-x/.git/worktrees/ai-x-lightweight
```

当前 common Git directory 与远端仍属于原仓库：

```text
Git common dir：/Users/heyunshen/work/PROJECT/jdc/ai-x/.git
origin：https://github.com/yssssssssssss/ai-x.git
```

当前工程缺少：

- 根目录 README；
- API production build；
- 根目录统一 `build/start`；
- API 静态托管 Web；
- Dockerfile；
- 生产 Artifact volume 约定；
- Release workflow；
- GHCR 镜像；
- 独立仓库 fresh-clone 验证。

### 2.3 当前工作区前置条件

编写本方案时当前 Worktree 不是干净发布快照，存在未提交和未跟踪文件。开始独立化前必须：

```text
逐项确认改动归属
→ 完成并提交，或移动到明确分支
→ git status 干净
→ 完整质量门禁通过
```

不得从脏 Worktree 制作新仓库首个 Release。

## 3. 目标

### 3.1 Git 目标

- 新仓库的 `origin` 指向 `yssssssssssss/ai-x-lightweight`；
- 新仓库 `main` 指向当前独立化完成后的提交；
- 当前分支的完整祖先提交保留；
- 新 clone 的 `.git` 位于新目录自身；
- 原 `ai-x` 仓库与 Worktree 不被重写；
- 不 force-push，不 squash，不迁移旧 Issue/PR 数据。

### 3.2 运行目标

全新机器只需：

```text
Git clone
Node 22 + pnpm 9.12.1
PostgreSQL 16
环境变量
持久化目录
```

即可执行：

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
pnpm build
pnpm migrate:prod
pnpm start
```

访问同一个服务地址：

```text
/       → Web
/api/*  → API
```

### 3.3 发布目标

推送版本 Tag 后：

```text
v0.1.0
→ Quality
→ Web/API build
→ Docker build
→ GHCR push
→ GitHub Release
```

镜像：

```text
ghcr.io/yssssssssssss/ai-x-lightweight:<version>
```

### 3.4 运维目标

- 应用进程使用非 root 用户；
- 容器收到 SIGTERM 后停止 Recovery、关闭 HTTP 和数据库连接池；
- `/api/healthz` 可用于容器健康检查；
- 数据库迁移为独立部署步骤，不在每个应用副本启动时自动执行；
- `RUN_WORKSPACE_ROOT` 必须挂载持久卷；
- 运行密钥只通过环境或 Secret 注入，不进入镜像和 Release。

## 4. 非目标

本阶段不实现：

- Kubernetes / Helm；
- Terraform；
- 多地域部署；
- 多副本水平扩容；
- Artifact 对象存储；
- npm 包发布；
- 自动生产部署；
- 数据库高可用编排；
- Zero 桌面端容器化；
- O2/Joyspace 凭据打包；
- Playwright 浏览器打入默认生产镜像；
- 原仓库所有 Branch、Tag、Issue、PR 的完整镜像迁移；
- 对业务合同、Skill、Renderer 或报告内容做额外重构。

## 5. 目标生产架构

```text
                    ┌─────────────────────────────┐
                    │ ai-x-lightweight container  │
HTTPS / reverse     │                             │
proxy ─────────────▶│ Node / Express :3001        │
                    │ ├── /api/*                  │
                    │ ├── /api/healthz            │
                    │ └── Web static / SPA        │
                    └──────────┬─────────┬────────┘
                               │         │
                               │         └── Persistent volume
                               │             /app/run-workspaces
                               ▼
                      External PostgreSQL 16
```

外部 Provider：

```text
LLM Gateway
Tavily
可选 O2 / Joyspace
可选 external Tool services
```

应用镜像不内置上述服务或凭据。

## 6. Git 独立化方案

### 6.1 冻结源提交

在当前 Worktree：

1. 完成或归档所有未提交改动；
2. 运行完整门禁；
3. 创建独立化提交；
4. 记录源提交 SHA；
5. 不修改原 `main`。

### 6.2 创建空目标仓库

目标仓库应为空，不自动创建 README、License 或 `.gitignore`，避免产生无关根提交。

建议仓库名：

```text
yssssssssssss/ai-x-lightweight
```

仓库可见性由 owner 决定，不影响技术方案。

### 6.3 推送完整分支历史

在当前 linked worktree 中增加临时远端：

```bash
git remote add standalone <new-repository-url>
git push standalone refactor/lightweight-skill-orchestration:main
```

该操作会把当前提交及其全部祖先历史推送到新仓库，不会 squash。

不要执行：

```bash
git init
git push --mirror
git push --all
git push --force
```

第一版只推送形成新 `main` 所需的 ancestry；不把原仓库所有实验 Branch 和无关 Tag 全部带入。

### 6.4 从新仓库重新 clone

推送后必须创建新目录：

```bash
git clone <new-repository-url> ai-x-lightweight-standalone
cd ai-x-lightweight-standalone
git rev-parse --git-common-dir
git remote -v
```

验收：

```text
.git 是新 clone 自身目录
origin 指向 ai-x-lightweight
源提交可在 git log 中追溯
原 ai-x Worktree 未变化
```

当前 linked worktree 不直接改造成独立 `.git`，避免损坏原仓库 Worktree 元数据。

### 6.5 新仓库设置

- 默认分支：`main`；
- 启用 Actions；
- 配置 GHCR package 权限；
- 配置必要 Secrets/Variables；
- 将 Issue tracker 文档从 `yssssssssssss/ai-x` 更新到新仓库；
- 确认 Branch Protection 与 CI required checks；
- 原 PR #43 在新仓库验证后关闭或保留只读说明，不将其当作新仓库 Release 入口。

## 7. 项目身份调整

修改根 `package.json`：

```json
{
  "name": "ai-x-lightweight",
  "version": "0.1.0",
  "private": true
}
```

修改 `apps/web/package.json`：

```json
{
  "name": "@ai-x-lightweight/web",
  "version": "0.1.0",
  "private": true
}
```

`private: true` 保留；本阶段不发布 npm 包。

更新：

- `AGENTS.md` Issue tracker；
- `CLAUDE.md` 中相同仓库说明；
- System Capabilities 中应用名称/版本来源；
- README 的镜像、仓库和启动命令。

不批量重命名领域内部 `user-research-ai` 数据库历史名，除非它直接显示给用户或阻止独立运行。

## 8. Production Build

### 8.1 新增 `tsconfig.build.json`

当前根 `tsconfig.json` 为 `noEmit`，不能产生生产 JavaScript。新增构建配置：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true,
    "declaration": false,
    "rewriteRelativeImportExtensions": true
  },
  "include": [
    "apps/agent-api/**/*.ts",
    "apps/orchestrator-runtime/**/*.ts",
    "database/**/*.ts",
    "packages/**/*.ts"
  ],
  "exclude": [
    "tests",
    "apps/web",
    "external-tools",
    "node_modules"
  ]
}
```

使用 TypeScript 5.7 的 `rewriteRelativeImportExtensions` 把源码 `.ts` import 改写为可运行 `.js` import，不引入 tsup/webpack/esbuild API bundler。

### 8.2 根脚本

修改 `package.json`：

```json
{
  "scripts": {
    "build:api": "tsc -p tsconfig.build.json",
    "build:web": "pnpm --dir apps/web build",
    "build": "pnpm build:api && pnpm build:web",
    "migrate:prod": "node dist/database/run-migrations.js",
    "start": "node dist/apps/agent-api/src/server.js"
  }
}
```

保留现有开发脚本：

```text
api:dev
dev:stack
```

`database/run-migrations.ts` 同步调整为从 `process.cwd()/database/migrations`（或显式 `MIGRATIONS_DIR`）读取 SQL；编译后的脚本不得假设 SQL 会由 TypeScript 自动复制到 `dist/database/migrations`。

`db:seed` 不进入生产启动流程。

### 8.3 构建输出

```text
dist/
├── apps/agent-api/
├── apps/orchestrator-runtime/
├── database/
└── packages/

apps/web/dist/
├── index.html
└── assets/
```

构建前清理 `dist/`，并把根 `dist/` 加入 `.gitignore`。

## 9. Web/API 一体发行

### 9.1 Express 托管 Web

在所有 `/api` 路由注册完成后：

1. 检查 `apps/web/dist/index.html`；
2. 若存在，使用 `express.static` 托管静态资源；
3. 非 `/api` GET 请求回退到 `index.html`；
4. API 404 不得被 SPA fallback 吞掉；
5. 不存在 Web build 时保持 API-only 启动，日志明确说明 Web 未托管。

目标：

```text
GET /                  200 text/html
GET /assets/*          200 immutable asset
GET /api/healthz       200 application/json
GET /api/unknown       API 404，不返回 index.html
GET /task/deep-link    200 index.html
```

### 9.2 Host 与 Port

保留：

```text
API_PORT=3001
```

新增最小环境变量：

```text
HOST=0.0.0.0
```

本地开发脚本仍可绑定 `127.0.0.1`；Docker 必须绑定 `0.0.0.0`。

### 9.3 缓存

- `index.html`：`no-cache`；
- Vite hashed assets：长期 immutable；
- `/api`：沿用现有接口缓存策略；
- 报告与 owner-bound Asset 不改为公共缓存。

## 10. 生产配置与密钥

### 10.1 生产必需

```text
NODE_ENV=production
HOST=0.0.0.0
API_PORT=3001
DATABASE_URL
JWT_SECRET
RUN_WORKSPACE_ROOT=/app/run-workspaces
LLM_PROVIDER
TOOL_ADAPTER
```

真实 Provider 额外需要：

```text
LLM_GATEWAY_BASE_URL
LLM_GATEWAY_API_KEY
LLM_MODEL_NAME
LLM_EXPECTED_ACTUAL_MODEL
TAVILY_API_KEY
```

### 10.2 生产禁止

```text
DEV_QUICK_LOGIN_ENABLED=1
提交 .env
把密钥写入 Dockerfile
把密钥作为 Docker build args
持久设置 ALLOW_REAL_PROVIDER=1
```

`ALLOW_REAL_PROVIDER=1` 继续仅用于显式 Smoke 命令，不作为服务永久环境变量。

### 10.3 `.env.example`

调整为环境中立：

- 不把内网域名当成可直接运行的默认生产值；
- 标明 development-only 与 production-required；
- 加入 `HOST`；
- 说明 Artifact volume；
- 说明 Zero、O2 和 Labs 默认关闭；
- 保留凭据占位，不写真实值。

### 10.4 生产 Fail Fast

`NODE_ENV=production` 时：

- 缺 `DATABASE_URL` 拒绝启动，不回退 localhost；
- 缺 `JWT_SECRET` 拒绝启动；
- `LLM_PROVIDER=gateway` 时缺 Gateway 配置拒绝真实执行；
- `TOOL_ADAPTER=real` 时按实际启用 Tool 检查凭据；
- 开发/测试默认行为不因生产门禁改变。

校验只在配置加载边界执行一次，不在路由、Runtime 和 Tool 层重复。

## 11. 数据与 Artifact 持久化

### 11.1 PostgreSQL

生产 PostgreSQL 外置。部署流程：

```bash
pnpm migrate:prod
pnpm start
```

迁移必须幂等，应用启动不自动执行 seed。

### 11.2 Artifact

容器内约定：

```text
RUN_WORKSPACE_ROOT=/app/run-workspaces
```

必须挂载持久卷：

```text
宿主机 / 持久磁盘
→ /app/run-workspaces
```

需要备份：

- PostgreSQL；
- `RUN_WORKSPACE_ROOT`；
- 两者必须来自相近时间点，否则 Artifact Registry 与文件可能不一致。

### 11.3 单副本限制

第一版只能启动一个应用副本。若未来多副本，需要先把 Artifact Store 切到共享对象存储或共享文件系统，并重新验证锁、Hash 和恢复语义。本阶段不提前实现。

## 12. Docker 镜像

### 12.1 多阶段 Dockerfile

建议阶段：

```text
deps
→ 安装 root 与 apps/web 依赖

build
→ pnpm build

runtime
→ 仅生产依赖
→ dist API
→ apps/web/dist
→ migrations / schemas / orchestrator / skills / knowledge-base
```

运行镜像：

- `node:22-bookworm-slim`；
- 启用 corepack / pnpm 9.12.1；
- 使用非 root 用户；
- `WORKDIR /app`；
- `EXPOSE 3001`；
- `CMD ["node", "dist/apps/agent-api/src/server.js"]`；
- Healthcheck 请求 `/api/healthz`。

### 12.2 Runtime 必须复制的非代码目录

```text
database/migrations
orchestrator
schemas
skills
knowledge-base
harness（仅 Runtime 实际读取的配置）
apps/web/dist
```

不得复制：

```text
.git
.env
node_modules from host
run-workspaces contents
tests
docs
audit generated files
.pids
references / wiki mounts
external-tools source
```

### 12.3 Playwright

默认生产镜像：

```text
PLAYWRIGHT_CAPTURE_ENABLED=0
```

不安装 Chromium，控制镜像体积。未来确需浏览器取证时另建明确的 browser-enabled 镜像，不在第一版加入条件分支。

### 12.4 本地镜像验收

```bash
docker build -t ai-x-lightweight:local .
docker run --rm \
  -p 3001:3001 \
  --env-file .env.production.local \
  -v ai-x-workspaces:/app/run-workspaces \
  ai-x-lightweight:local
```

数据库使用外部 PostgreSQL，不在首版新增 Compose。

## 13. CI 调整

### 13.1 Quality Workflow

保留现有：

- PostgreSQL 16 Service；
- `pnpm install --frozen-lockfile`；
- Web 独立 install；
- migrations；
- `pnpm quality`；
- Web build；
- Playwright contract。

新增：

```text
pnpm build
Docker build（不 push）
production server smoke
```

### 13.2 Production Server Smoke

CI 中使用 mock/fake：

1. 启动 PostgreSQL；
2. 执行 `pnpm migrate:prod`；
3. 启动 `pnpm start`；
4. 检查 `/api/healthz`；
5. 检查 `/` 返回 Web；
6. 检查 `/api/unknown` 不返回 SPA；
7. 发送 SIGTERM；
8. 确认进程在超时内退出。

普通 CI 不调用真实 Provider。

## 14. Release Workflow

新增 `.github/workflows/release.yml`。

### 14.1 触发

```yaml
on:
  push:
    tags:
      - 'v*'
```

### 14.2 权限

```yaml
permissions:
  contents: write
  packages: write
```

### 14.3 Job 顺序

```text
checkout
→ setup Node/pnpm
→ install
→ migrate test DB
→ quality
→ pnpm build
→ docker buildx
→ login ghcr.io
→ push version/sha/latest tags
→ GitHub Release
```

### 14.4 镜像标签

对 `v0.1.0`：

```text
ghcr.io/yssssssssssss/ai-x-lightweight:0.1.0
ghcr.io/yssssssssssss/ai-x-lightweight:v0.1.0
ghcr.io/yssssssssssss/ai-x-lightweight:sha-<short>
ghcr.io/yssssssssssss/ai-x-lightweight:latest
```

预发布 `v0.1.0-rc.1` 不更新 `latest`。

### 14.5 Release 内容

- 自动生成 Release Notes；
- 记录 source SHA；
- 记录镜像完整名称；
- 记录 migration 说明；
- 记录已知限制：单副本、外部 PG、持久卷、默认无 Chromium/O2/Zero。

不上传 `.env`、运行工作区、真实报告或用户材料。

## 15. Real Provider 与 Release 的关系

Quality 与 Docker 构建必须不依赖真实 Provider。

发布前至少运行：

1. 一条真实 Industry Single；
2. 一条第二 Skill 或 Multi；
3. 验证 HTML、ZIP、图片和 Source；
4. 命令级设置 `ALLOW_REAL_PROVIDER=1`。

真实 Smoke 的凭据迁移到新仓库 Secrets：

```text
JWT_SECRET
LLM_GATEWAY_BASE_URL
LLM_GATEWAY_API_KEY
LLM_MODEL_NAME
LLM_EXPECTED_ACTUAL_MODEL
LLM_MODEL_ROUTES（可选）
TAVILY_API_KEY
```

`O2_BIN`、Joyspace 和 Labs 仍按可选能力处理；缺失时形成 Gap 或跳过对应 Smoke，不伪造结果。

## 16. README 内容

根 `README.md` 必须包含：

1. 项目定位；
2. 架构图；
3. 支持的 Skill 输入和报告；
4. 环境要求；
5. 本地开发；
6. 生产 build/start；
7. Docker 运行；
8. PostgreSQL migration；
9. Artifact volume；
10. Provider/Tool 配置；
11. 测试；
12. Release；
13. 当前限制；
14. 安全说明；
15. 原仓库历史来源。

README 不包含真实账号、密码、Token、内网密钥或本机绝对路径。

## 17. 文件改动规划

### 17.1 新增文件

```text
README.md
tsconfig.build.json
Dockerfile
.dockerignore
.github/workflows/release.yml
```

### 17.2 修改文件

```text
package.json
apps/web/package.json
apps/agent-api/src/server.ts
database/db.ts
database/run-migrations.ts
.env.example
.gitignore
.github/workflows/ci.yml
AGENTS.md
CLAUDE.md
相关 build/static/release tests
```

### 17.3 明确不修改

```text
Skill Package 正文
Native orchestration contracts
数据库业务 Schema
Renderer 内容合同
原 ai-x main
历史 Commit
```

## 18. 实施阶段

### Phase 0：冻结与清理

- 处理当前 dirty Worktree；
- 记录源 SHA；
- 全量门禁；
- 新增本方案；
- 不创建新仓库、不推送未验证代码。

验收：`git status` 干净，当前分支可重复构建。

### Phase 1：Production Build

- 新增 `tsconfig.build.json`；
- 新增 root build/start/migrate scripts；
- 验证编译后的 API；
- 不再依赖 `tsx watch` 作为生产入口。

验收：

```bash
pnpm build
pnpm migrate:prod
pnpm start
```

### Phase 2：单进程 Web/API

- API 托管 Web dist；
- SPA fallback；
- API 404 隔离；
- HOST/PORT；
- 静态缓存；
- 优雅关闭。

验收：同一端口完成 Web 和 API。

### Phase 3：Docker

- Dockerfile；
- `.dockerignore`；
- 非 root；
- Healthcheck；
- 持久卷；
- 外部 PG；
- 不内置 Chromium/O2/Zero。

验收：镜像在没有源码挂载的情况下启动。

### Phase 4：Fresh Clone 验收

在临时目录：

```text
clone
install
build
migrate
start
quality
Docker smoke
```

确认没有原 Worktree 路径、未跟踪文件或本地缓存依赖。

### Phase 5：新仓库

- 创建空仓库；
- 推当前分支 ancestry 到 `main`；
- fresh clone；
- 设置 origin、默认分支和 Actions；
- 迁移 Secrets/Variables；
- 更新仓库文档。

### Phase 6：Release

- Release workflow；
- 先发布 `v0.1.0-rc.1`；
- 从 GHCR 拉取并运行，不使用本机构建缓存；
- 通过后发布 `v0.1.0`。

### Phase 7：收尾

- 更新方案状态为 Implemented；
- 记录镜像 digest；
- 记录新仓库 URL；
- 原 Draft PR #43 添加迁移说明后关闭或归档；
- 原 Worktree 仅在新 clone 验证后清理。

## 19. 测试矩阵

### Build

- API TypeScript emit；
- `.ts` import 改写；
- Web production build；
- build 不依赖 `.env` 密钥；
- dist 不包含 tests 或本机路径。

### Static Serving

- `/`；
- hashed asset；
- SPA deep link；
- `/api/healthz`；
- API 404；
- owner-bound report/asset；
- no directory traversal。

### Runtime

- production env fail-fast；
- migration；
- login；
- Single Task；
- Multi Task；
- document/CSV/image upload；
- report HTML/ZIP；
- restart 后读取既有 Artifact；
- SIGTERM graceful shutdown。

### Docker

- build 无宿主 node_modules；
- non-root；
- healthcheck；
- external PG；
- persistent volume；
- container restart；
- no secrets in image history；
- no `.env` in image。

### Git

- 新仓库 main SHA；
- 完整 ancestry；
- origin 正确；
- `.git` 独立；
- 原仓库不变；
- clean fresh clone。

### Release

- RC tag；
- Quality；
- image push；
- version tags；
- Release Notes；
- pull-by-digest；
- cold-start smoke。

## 20. 发布演练

### 20.1 RC

```text
v0.1.0-rc.1
```

执行：

1. Tag；
2. GitHub Actions；
3. 从 GHCR 拉镜像；
4. 新 PostgreSQL Schema；
5. 新 Artifact volume；
6. migration；
7. 启动；
8. mock/fake Smoke；
9. 命令级真实 Smoke；
10. 停止并重启；
11. 验证历史任务和报告。

### 20.2 Stable

RC 不再修改功能，只修复发布阻断问题。Stable 使用新提交和新 Tag：

```text
v0.1.0
```

不得把 RC 镜像重新标记为 Stable 而不保留对应 Git SHA。

## 21. 验收标准

### Repository

- 新仓库存在；
- `main` 为当前独立实现；
- ancestry 保留；
- `.git` 独立；
- origin 新仓库；
- 原仓库未被改写。

### Build/Run

- fresh clone 可执行 `pnpm build`；
- production API 运行编译后 JS；
- Web/API 同端口；
- migration 可独立运行；
- 容器不依赖源码挂载；
- 容器重启后 Artifact 保留。

### Release

- GHCR 存在版本镜像；
- GitHub Release 存在；
- Release 与镜像 SHA 可追溯；
- CI/Quality/Web build/Docker smoke 通过；
- 两条真实路径通过或有明确外部阻塞记录。

### Security

- 镜像无 `.env` 和凭据；
- Quick Login 生产关闭；
- owner 隔离不变；
- Artifact/Hash 校验不变；
- 服务非 root；
- 只开放应用端口。

## 22. 风险与处理

| 风险 | 处理 |
|---|---|
| linked worktree 被误删或重建 `.git` | 只推远端后 fresh clone，不在当前目录 `git init` |
| 脏改动遗漏 | Phase 0 逐项提交/归档，clean gate |
| TypeScript emit 后 import 失效 | `rewriteRelativeImportExtensions` + compiled API smoke |
| Web deep link 404 | Express SPA fallback，API 前缀排除 |
| 容器重启丢报告 | `RUN_WORKSPACE_ROOT` 强制持久卷 |
| DB 与 Artifact 备份不一致 | 同窗口备份并记录版本 |
| 镜像过大 | 不复制 tests/docs/node_modules/external-tools，不装 Chromium |
| 多副本文件冲突 | v0.1.0 明确单副本 |
| 内网 Gateway 在部署环境不可达 | 发布前从目标网络执行真实 Smoke |
| Release 泄露密钥 | Runtime Secret 注入，禁止 build args/.env copy |
| 原仓库后续继续演进 | 新仓库成为唯一主线，旧仓库只留迁移说明 |

## 23. 回滚

### 代码回滚

- Release 使用不可变版本 Tag；
- 回滚到上一 GHCR digest；
- 不 force-push Tag。

### 数据库回滚

当前 migration 采用前向策略。若新版本 migration 不兼容：

- 停止部署；
- 恢复部署前数据库备份；
- 恢复匹配版本 Artifact volume；
- 启动上一镜像。

本阶段不新增自动 down migration 框架。

### 仓库迁移回滚

新仓库验证失败时：

- 保留当前原仓库分支和 linked worktree；
- 删除或修复新 clone；
- 不更改原 `main`；
- 不删除当前 Worktree；
- 修复后重新推送普通提交。

## 24. 建议提交顺序

```text
1. docs: define standalone project release plan
2. build: add production api and web build
3. feat: serve web assets from agent api
4. build: add standalone application image
5. docs: add standalone operations readme
6. ci: validate production image
7. ci: publish ghcr image and github release
8. chore: update standalone repository metadata
```

每个提交运行聚焦测试和 `git diff --check`。最终运行完整门禁与 fresh-clone smoke。

## 25. 完成定义

只有同时满足以下条件才算独立化完成：

- 当前改动全部有明确提交；
- 新仓库 `main` 保留完整 ancestry；
- 新 clone 不依赖原仓库 Git directory；
- 根目录有 README；
- `pnpm build` 成功；
- `pnpm start` 使用编译后 API；
- Web/API 同端口；
- PostgreSQL migration 独立执行；
- Docker 非 root 启动；
- Artifact volume 持久化；
- Quality、Web build、production smoke、Docker smoke 通过；
- GHCR RC 和 Stable 镜像可拉取；
- GitHub Release 与镜像/Commit 对齐；
- 真实 Single 与第二路径验收通过；
- 新仓库文档、Issue 路径和 Secrets 配置正确；
- 原 ai-x 仓库和 Worktree 未被破坏。

## 26. 时间估算

在部署目标网络、PostgreSQL 和 GitHub 权限已准备好的前提下：

```text
工作区冻结与文档       0.5–1 天
Production build/start  1–2 天
Web/API 一体发行        0.5–1 天
Docker 与持久化验证     1–2 天
新仓库与 fresh clone    0.5–1 天
Release workflow         1–2 天
真实 Smoke 与修复        1–3 天
```

合理总计：

```text
5–10 个工程日
```

若只要求独立仓库和本地开发运行，不要求生产镜像与 Release：

```text
约 1 个工程日
```

## 27. 最终判断

当前项目的业务源码和开发运行已经接近自包含；独立化的主要工作不是重写 Runtime，而是：

```text
Git 脱离 linked worktree
+ production build/start
+ Web/API 单镜像发行
+ PostgreSQL/Artifact 持久化合同
+ GHCR/GitHub Release
+ fresh-clone 验收
```

应先完成生产运行合同，再创建和切换新仓库。这样新仓库的第一个 `main` 和 `v0.1.0` 就是可运行、可验证、可回滚的独立版本，而不是仅复制了一份源码。
