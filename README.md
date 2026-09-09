# ai-x-lightweight

面向用户研究、竞品分析和设计诊断的原生 Skill 编排应用。项目包含需求理解、Single/Multi Skill 规划、材料上传、受控 Tool 调用、Artifact、恢复，以及确定性 HTML/ZIP 报告。

## 架构

```text
Browser
  └── Node / Express :3001
      ├── /api/*
      ├── Web static / SPA
      ├── Native Skill Runtime
      └── RUN_WORKSPACE_ROOT
            │
            ├── PostgreSQL 16
            ├── LLM Gateway
            └── Tool services
```

生产第一版使用一个应用实例和外部 PostgreSQL。`RUN_WORKSPACE_ROOT` 必须使用持久化目录；在切换共享对象存储前不要水平扩容应用副本。

## 材料输入与报告追问

选定 Skill 后，Stage 2 会按冻结的输入合同集中收集所需材料：

- Markdown/TXT：UTF-8，本地上传，单文件最大 10 MiB；
- CSV：单文件最大 10 MiB，并填写行含义、时间范围和采样方式；
- 图片：JPEG、PNG、WebP，单张最大 10 MiB，每项最多 12 张；
- 可选材料可明确跳过，并在最终报告中保留资料缺口。

任务完成后可在报告下方继续追问。追问只使用当前已封存报告、Source 和 Gap，不调用新 Tool、不重跑 Skill，也不修改原报告；需要补充新事实或重新分析时应创建新任务。

## 环境要求

- Node.js 22+
- pnpm 9.12.1
- PostgreSQL 16
- Docker 27+（构建镜像时）

## 安装

```bash
corepack enable
corepack prepare pnpm@9.12.1 --activate
pnpm install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
cp .env.example .env
```

至少配置：

```text
DATABASE_URL
JWT_SECRET
LLM_PROVIDER
LLM_MODEL_NAME
LLM_EXPECTED_ACTUAL_MODEL
TOOL_ADAPTER
```

使用真实模型和检索时还需要：

```text
LLM_GATEWAY_BASE_URL
LLM_GATEWAY_API_KEY
TAVILY_API_KEY
```

不要提交 `.env`，不要将凭据写入镜像。

## 本地开发

初始化数据库：

```bash
pnpm db:migrate
pnpm db:seed
```

启动完整开发栈：

```bash
pnpm dev:stack start
```

默认地址：

```text
Web  http://127.0.0.1:5173
API  http://127.0.0.1:3001
```

停止或重启：

```bash
pnpm dev:stack stop
pnpm dev:stack restart
```

## Production Build

```bash
pnpm build
```

输出：

```text
dist/          编译后的 API / Runtime / Database / Contracts
apps/web/dist  Web 静态文件
```

执行生产迁移：

```bash
NODE_ENV=production DATABASE_URL=... pnpm migrate:prod
```

启动：

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
API_PORT=3001 \
DATABASE_URL=... \
JWT_SECRET=... \
RUN_WORKSPACE_ROOT=/var/lib/ai-x-lightweight/workspaces \
pnpm start
```

同一端口提供：

```text
/              Web
/api/*         API
/api/healthz   Healthcheck
```

## Docker

构建：

```bash
docker build -t ai-x-lightweight:local .
```

迁移：

```bash
docker run --rm \
  --env-file .env.production.local \
  ai-x-lightweight:local \
  node dist/database/run-migrations.js
```

运行：

```bash
docker volume create ai-x-lightweight-workspaces

docker run --rm \
  --name ai-x-lightweight \
  -p 3001:3001 \
  --env-file .env.production.local \
  -v ai-x-lightweight-workspaces:/app/run-workspaces \
  ai-x-lightweight:local
```

验证：

```bash
curl --fail http://127.0.0.1:3001/api/healthz
```

默认镜像不安装 Chromium，不包含 O2、Zero 或 external Tool 后端。相应能力未接入时必须形成 Gap，不得模拟结果。

## 数据与备份

必须持久化并备份：

1. PostgreSQL
2. `RUN_WORKSPACE_ROOT`

数据库 Artifact 记录与文件工作区应在相近时间点备份。只恢复其中一方可能导致 Hash 或文件绑定不一致。

生产第一版只支持单应用副本。本地文件 Artifact 未迁移到共享存储前，不要同时启动多个生产副本。

## 质量门禁

```bash
pnpm quality
pnpm build
git diff --check
```

普通测试固定使用 mock/fake，不调用真实 Provider。GitHub-hosted Quality 不运行内网 Gateway Smoke。

真实 Smoke 仅在能够访问 Gateway 的本地内网环境显式、命令级开启：

```bash
ALLOW_REAL_PROVIDER=1 \
LLM_PROVIDER=gateway \
TOOL_ADAPTER=real \
pnpm smoke:current:real
```

不要把 `ALLOW_REAL_PROVIDER=1` 写入 `.env`。

## 发布

正式版本使用 Git Tag：

```text
v0.1.0-rc.1
v0.1.0
```

Tag workflow 将：

1. 运行 Quality 与 Production Build；
2. 构建 Docker 镜像；
3. 推送至 GHCR；
4. 创建 GitHub Release。

镜像：

```text
ghcr.io/yssssssssssss/ai-x-lightweight:<version>
```

部署时先执行匹配版本镜像中的 migration，再启动应用。

## 项目边界

当前支持：

- 原生 Skill Package
- Single/Multi Skill
- Markdown/TXT、CSV、JPEG/PNG/WebP
- Gateway、Tavily 和可选内部 Tool
- owner-bound Artifact
- HTML 与离线 ZIP 报告

当前不支持：

- 多副本 Artifact 写入
- PDF/Office 文件解析
- 默认生产镜像内浏览器取证
- 自动生产部署
- Kubernetes/Helm

## 安全

- 用户业务内容与 PII 按当前合同进入分析和报告；
- API Key、Authorization、JWT、Token、Secret 和密码继续隐藏；
- Quick Login 只能在显式 development + loopback 条件下启用；
- Production 必须提供独立 `JWT_SECRET` 与 PostgreSQL；
- Artifact 与报告读取保持 owner-bound；
- 镜像不得包含 `.env`、用户材料或运行工作区。

## Git 历史

该项目从 `ai-x` 的 `refactor/lightweight-skill-orchestration` 分支独立而来，并保留完整提交 ancestry。新仓库建立后，`main` 是唯一独立发布主线；原仓库仅作为历史来源，不作为运行时依赖。

完整独立化步骤见：

```text
docs/plans/2026-09-09-standalone-project-release-development.md
```
