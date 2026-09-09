# Skill 材料问询、报告追问与运行性能优化方案

> 状态：Proposed，待分阶段实施
> 日期：2026-09-09
> 基线分支：`main`
> 基线提交：`b22b583`
> 适用范围：新建 Current Task；`single_skill`、`multi_skill`
> 关联基线：ADR-0013、ADR-0014、统一 Intake/Renderer 方案
> 设计原则：修复现有纵切，不建设通用聊天平台、数据平台、插件系统或新编排模式

## 1. 决策摘要

当前项目已经具备以下底层能力：

```text
用户需求
→ Stage 1 文字澄清
→ Skill 选择与冻结
→ Stage 2 动态材料表单
   ├── value
   ├── Markdown/TXT
   ├── CSV
   └── JPEG/PNG/WebP
→ owner/task/plan-bound Artifact
→ Native Skill 执行
→ Native Final Report
→ HTML/ZIP 报告
```

但现状还不能宣称“所有 Skill 都能正确收集所需材料”，也不能宣称“报告完成后可以继续围绕结果对话”。本方案按以下顺序补齐：

1. 为所有 active Skill 冻结明确、正确的 typed input requirements；
2. 保持 Stage 1 只澄清任务语义，Stage 2 作为唯一材料提交表单；
3. 修复 Stage 2 上传失败后表单消失、无法单项重试的问题；
4. 增加任务级、只基于已封存报告回答的连续追问；
5. 将执行期完整任务轮询改为轻量状态轮询；
6. 降低批量文件、CSV 和图片造成的内存与事件循环压力；
7. 恢复稳定、可解释的 CI 基线。

### 1.1 设计规模检查

完整方案横跨 Binding、Input Resolution、API、Web、Runtime、持久化和测试，实施必然超过 5 个文件。因此必须拆成独立提交和独立验收，不一次性重写。

最小实施顺序：

```text
Phase 0  恢复可信 CI
Phase 1  补齐 Skill 输入合同
Phase 2  修复 Stage 2 提交可靠性
Phase 3  增加报告后任务级追问
Phase 4  优化轮询与文件处理性能
Phase 5  人工业务验收与稳定版发布
```

Phase 3 是唯一新增业务纵切；其余均修复或收敛现有能力。

### 1.2 审核与测试原则

本方案不增加 Reviewer、模型自评或多轮全文审核。验证遵循“一个风险边界，一组证据”：

- 每个 Phase 开发时只运行直接相关的目标测试；
- 一个 Phase 合并前运行一次 `pnpm quality`；
- 所有 Phase 集成后只运行一次 production build、migration dry-run 和容器 Smoke；
- Skill 输入覆盖使用一张表驱动合同测试，不为每个 Skill 复制一套测试；
- 真实模型只做一个主路径和一个第二路径技术 Smoke，不运行七套重复场景；
- 报告内容质量、五 Tab、图片、打印和追问有用性由用户最后人工验收，不转成机械化 Reviewer；
- 同一验收条件不在 Phase 小节、总验收和 DoD 中重复列举。

## 2. 审计范围与证据

本次审计覆盖：

- `SkillLoader` 与 `orchestrator/skill-bindings.yaml`；
- `ResolvedPlanInputs` 合并和 PendingInput 生成；
- Stage 1 澄清、Stage 2 确认表单；
- 图片、CSV、Markdown/TXT multipart API；
- Visual/Dataset/Document Artifact Gate；
- Task 执行输入装配；
- Native Result、Final Report 和报告读取；
- Workbench Composer 与 Conversation API；
- 执行期轮询、Skill Catalog 扫描和文件内存路径；
- 当前 GitHub Actions 运行结果。

本轮定向执行以下测试：

```text
tests/stage2-plan.test.ts
tests/dataset-input-gate-store.test.ts
tests/document-input-gate-store.test.ts
tests/visual-input-gate-store.test.ts
tests/native-plan-input-resolution.test.ts
tests/current-flow-state.test.ts
```

结果：56 项测试全部通过。

当前 `b22b583` 对应 CI 状态：

- `quality`：成功；
- Playwright 独立 Job：一个 deadline 分类测试失败；
- Current real smoke：Secrets 门禁成功，但第一条 Gateway 调用返回 `LLMInvocationError`；
- 因此当前 `main` 的整体 Workflow 为失败，不能作为稳定版发布依据。

## 3. 当前能力矩阵

| 能力 | 当前状态 | 结论 |
|---|---|---|
| 初始需求输入 | 已支持 | Composer 文本与 `$skill-id` 直呼 |
| Stage 1 需求澄清 | 已支持 | 文字、选项、建议、假设编辑 |
| Stage 1 文件上传 | 未支持 | 当前没有文件控件 |
| Stage 2 普通值补充 | 已支持 | 单值与多值文本 |
| Stage 2 Markdown/TXT | 已支持 | UTF-8 multipart Artifact |
| Stage 2 CSV | 已支持 | 原文件 + 标准化 Profile Artifact |
| Stage 2 图片 | 已支持 | JPEG/PNG/WebP Binary Artifact |
| Multi Skill 共享材料 | 部分支持 | 相同 key 聚合一次，但来源兼容性需收紧 |
| 可选输入豁免 | 已支持 | 继续执行并写入 Gap |
| 必需输入阻断 | 已支持 | 未提供时不能确认 |
| 历史文件复用 | 未支持 | Artifact 与原 task/plan 强绑定 |
| 未声明附件主动上传 | 未支持 | 只有 PendingInput 才显示控件 |
| PDF/Office | 不支持 | 当前明确非目标 |
| 报告后继续输入 | 表面支持 | 实际创建新任务 |
| 基于原报告连续追问 | 未支持 | 无报告上下文、无任务级消息写入 |

## 4. 关键问题

### 4.1 Skill 的材料需求不会从正文自动推断

平台只有在 Binding 中声明以下字段后，才能生成正确控件：

```yaml
- key: user_research_dataset
  kind: dataset
  label: 用户研究数据
  description: 本次分析所需用户研究数据
  required: false
  multiple: false
  acceptedSources: [upload, database]
  question: 是否有可供本次分析使用的用户研究 CSV？
```

仅在 `SKILL.md` 中写“需要 CSV”或“需要截图”，不会自动出现上传控件。未绑定的 drop-in Skill 默认只获得 `research_goal`，不能自动发现任意材料需求。

这是正确的信任边界：平台不得从自然语言猜测文件种类、必需性、数量和权限。优化方向是补齐 Binding，而不是增加推断规则。

### 4.2 active Skill 的 typed input 覆盖不完整

当前有效文件输入主要覆盖：

#### 图片

- `accessibility-review`
- `competitive-app-analysis`
- `design-experience-review`
- `run-heuristic-evaluation`
- `industry-market-analysis`

#### 文档

- `code-open-feedback`
- `structure-interview-transcript`
- `synthesize-qualitative-insights`
- `industry-market-analysis`

#### CSV

- `generate-persona`
- `industry-market-analysis`

以下数据型 Skill 的 `analytics_dataset` 当前会退化为普通文本框：

- `analyze-satisfaction`
- `build-experience-metrics`
- `conversion-funnel-analysis`
- `feature-adoption-analysis`

以下材料虽然 `acceptedSources` 包含 `upload`，但 `kind` 仍为 `value`，前端不会显示文件控件：

- `competitive-analysis.user_materials`
- `jobs-to-be-done.user_materials`
- `jobs-to-be-done.qualitative_insights`

结论：上传基础设施完整，但 active Skill 的声明覆盖不足。

### 4.3 Stage 1 与 Stage 2 的职责需要明确

当前分层：

```text
Stage 1
└── 任务语义：目标、范围、结果类型、歧义、假设

Stage 2
└── 已选 Skill 的执行材料：文本、文档、CSV、图片
```

该分层保留。首版不在 Composer 或 Stage 1 建立“先上传、后猜角色”的临时附件池。否则需要新增未绑定文件生命周期、角色重新分配和清理逻辑，规模明显扩大。

用户文案应明确：Stage 1 是“确认需求”，Stage 2 是“补充材料并确认执行”。两者共同构成执行前问询阶段。

### 4.4 Stage 2 提交不是原子的，失败后不可恢复

当前前端顺序：

```text
setPhase('executing')
→ 逐个上传 visual
→ 逐个上传 dataset
→ 逐个上传 document
→ confirm plan
```

任一步失败后：

- 全局 phase 变为 `error`；
- Workbench 不再渲染 Stage 2；
- 浏览器中已选择的 `File` 状态随组件卸载丢失；
- 已上传成功的 Artifact 可能存在，但用户无法继续确认；
- 用户只能重新发起任务。

这是当前 Intake 最优先的可靠性缺口。

### 4.5 报告后输入并非连续对话

报告完成后 Composer 会重新启用，但 `submitInput()` 会：

- 清除当前任务状态；
- 不传当前 `conversationId`；
- 不传 Final Report、Source、Gap 或 Skill Result；
- 创建一个全新的任务。

即使仅补传 `conversationId` 也不够。当前规划服务使用 `conversationId` 做 ownership 和任务归组，但调用 Planner 时只传新的 `originalInput`，不会读取原报告。

### 4.6 执行期轮询重复传输完整 Plan

前端运行阶段成功轮询后始终回到 2 秒间隔。每次调用完整 Task Read，可能重复返回：

- 冻结 Plan；
- Native Skill body；
- Reference 内容和文件元数据；
- PendingInput；
- Execution Step；
- Approval 与恢复信息。

Multi Skill 或大型 Skill Package 下会形成重复数据库读取、JSON 序列化和网络传输。

### 4.7 上传和解析存在内存峰值

当前 multipart 路由将每个文件的 chunks 全部 `Buffer.concat` 后再进入 Gate：

- visual 最多 12 张、每张 10 MiB；
- document 接口最多 20 个文件、每个 10 MiB；
- 并发请求会叠加 Node 内存和 GC 压力；
- 图片转 data URL 后还会增加约三分之一体积。

CSV 使用同步全量解析，并在完成行数组、列统计和唯一值集合后才判断标准化 Profile 是否超过 512 KiB。

### 4.8 Skill Catalog 每次重新扫描

`InstalledSkillCatalog.scan()` 会递归遍历 Skill 目录、读取 Frontmatter、检查文件并计算 Package Hash。生产包是静态的，重复扫描没有收益。

## 5. 目标用户流程

### 5.1 新任务

```text
用户输入需求或 $skill-id
    ↓
Stage 1：只澄清任务语义
    ↓
生成并选择 Plan
    ↓
Stage 2：聚合所有 Skill 的材料需求
    ├── 已从对话解析的输入
    ├── 待补充普通值
    ├── Markdown/TXT
    ├── CSV + 数据说明
    ├── 图片
    └── 可选资料豁免
    ↓
上传状态逐项完成
    ↓
最终确认
    ↓
执行与报告
```

### 5.2 上传失败

```text
某个材料上传失败
    ↓
Stage 2 保持可见
    ↓
成功项保持“已上传”
失败项显示原因和“重试”
    ↓
只重试失败项
    ↓
全部准备完成后确认
```

### 5.3 报告后追问

```text
Final Report 已封存
    ↓
“基于本报告继续提问”
    ↓
读取固定报告内容 + Source Catalog + Gap + 最近追问
    ↓
单次受控 LLM 回答
    ↓
保存用户问题与回答
    ↓
页面刷新后仍可回放
```

追问只解释报告，不自动重跑 Skill、不修改已封存报告。

## 6. Phase 0：恢复可信 CI

### 6.1 Playwright deadline 测试

当前失败表现：期望 `deadline_exceeded`，实际错误字段为 `undefined`。该测试依赖很短的真实时钟窗口，容易受到 GitHub Runner 调度影响。

优化要求：

- 不通过简单增加 sleep 或无限放宽时间解决；
- 将 deadline、launch completion 和 quarantine release 改为可控 Promise；
- 断言状态转换和结果分类，不断言脆弱的毫秒边界；
- 保留真实 Chromium 离线渲染 Smoke，但 timeout 单元测试使用确定性时序。

### 6.2 真实 Gateway Smoke

Secrets 已注入，但 GitHub-hosted Runner 上第一条 Gateway 调用失败。必须先确认：

- Gateway 是否只允许内网访问；
- DNS、TLS、出口 IP 或认证是否受限；
- 失败是连接、认证、模型路由还是 Actual Model drift。

如果 Gateway 是内网能力：

- 普通 `Quality` 继续使用 Mock/Fake；
- 真实 Provider Smoke 放到受保护的 self-hosted Runner 或人工触发环境；
- `ALLOW_REAL_PROVIDER=1` 继续只在命令级注入；
- 不把真实 Provider 失败伪装为 Quality 成功；
- 不在公网 Runner 上盲目重试。

### 6.3 Phase 0 验收

- deadline 分类通过一个确定性目标测试；
- 普通 `pnpm quality` 通过；
- Real Smoke 的 Runner、网络和凭据门禁明确；
- 在受保护环境执行一个主路径和一个第二路径技术 Smoke，失败可分类但不打印 Secret。

不要求连续多轮 CI、不在每次提交运行七场景真实调用。

## 7. Phase 1：补齐 Skill 输入合同

### 7.1 保持现有合同

首版不新增 Input v2，不新增格式 DSL。继续使用：

```ts
type SkillInputKind = 'value' | 'document' | 'visual' | 'dataset';
```

每个用户材料角色必须在 Binding 中明确：

- `key`
- `kind`
- `label`
- `description`
- `required`
- `multiple`
- `acceptedSources`
- `question`

### 7.2 输入种类规则

| kind | 用户输入形式 | 首版格式 |
|---|---|---|
| `value` | 单行、多行或逐项文本 | 字符串/字符串数组 |
| `document` | 本地文本材料 | `.md`、`.txt` |
| `dataset` | 结构化表格 | 单个 `.csv` |
| `visual` | 本地图片 | JPEG、PNG、WebP |

若一个业务概念同时允许“粘贴简短文字”和“上传文件”，不要把 `kind: value` 与 `acceptedSources: upload` 混用。最小做法是保留原业务 key 作为文件输入，再增加一个可选文字 key，例如：

```text
user_materials       document
user_material_notes  value
```

Skill Prompt 可同时消费两者。这样既保留原材料语义，也让 UI 和执行合同保持确定性。

### 7.3 首批修正映射

| Skill | key | 当前 | 目标 |
|---|---|---|---|
| analyze-satisfaction | analytics_dataset | value | dataset，required |
| build-experience-metrics | analytics_dataset | value | dataset，optional |
| conversion-funnel-analysis | analytics_dataset | value | dataset，optional |
| feature-adoption-analysis | analytics_dataset | value | dataset，optional |
| competitive-analysis | user_materials | value/upload 混合 | user_materials=document；增加可选 notes |
| jobs-to-be-done | user_materials | value/upload 混合 | user_materials=document；增加可选 notes |
| jobs-to-be-done | qualitative_insights | value/upload 混合 | qualitative_insights=document；增加可选 notes |

`acceptedSources` 只声明当前平台真正能解析的来源。当前没有历史 Artifact/数据库材料选择器，因此用户文件 requirement 首版只声明 `upload`；不得仅因未来可能复用而提前声明 `database`。Knowledge/Tool 继续只用于已有执行期绑定。

### 7.4 Multi Skill 合并规则

相同 key 跨 Skill 聚合时：

- `kind` 必须一致；
- `multiple` 必须一致；
- `required` 使用 OR：任一 Skill 必需则整体必需；
- 一个实际来源必须被所有目标 Skill 接受；
- `acceptedSources` 使用交集语义，而不是当前的并集语义；
- 交集为空时计划失败，要求各 Skill 使用不同 key 或修正 Binding；
- 一个上传结果继续绑定全部 `targetInvocationIds`。

这样才能保证“只问一次”不会让某个 Skill 收到其合同不接受的来源。

### 7.5 新 Skill 接入清单

Skill 进入 active 前只做一次合同确认：

1. 输入的 `kind/required/multiple/acceptedSources` 是否明确；
2. 缺失输入是阻断还是形成 Gap；
3. 与其他 Skill 共用 key 时合同是否兼容；
4. 选中的控件是否能把材料送入该 Skill。

Registry lint 只检查结构一致性，不新增人工审批人或 Reviewer。

### 7.6 Phase 1 验收

由 §15 的一张表驱动测试覆盖全部 active Skill，再增加一组 Multi 共享/冲突合同测试；不为每个 Skill 复制测试文件。

## 8. Phase 2：Stage 2 提交可靠性

### 8.1 前端状态

上传期间不要提前把全局 Task phase 改为 `executing`。增加仅存在于 Web 的 Intake 提交状态：

```ts
type IntakeSubmissionState =
  | 'idle'
  | 'uploading'
  | 'confirming'
  | 'error';
```

每个 role 维护：

```ts
interface IntakeItemState {
  status: 'selected' | 'uploading' | 'uploaded' | 'error';
  uploadedInputId?: string;
  error?: string;
}
```

该状态不是数据库事件，不新增时间线系统。

### 8.2 提交流程

```text
客户端预校验
→ 为每个待上传 role 建立稳定 idempotency key
→ 最多 3 个 role 并发上传
→ 记录已成功 uploadedInputId
→ 失败时保留组件和 File
→ 只重试失败 role
→ 所有 role 成功后调用 confirm
→ confirm 成功后才进入 ready/executing
```

同一组文件和元数据重试必须复用原 idempotency key。文件选择或元数据变化后生成新 key。

### 8.3 客户端预校验

服务端仍是唯一可信边界；客户端只做即时反馈：

- 扩展名与 MIME 提示；
- 单文件 10 MiB；
- visual 最多 12 张；
- document 最多 20 个；
- dataset 只能一个 CSV；
- CSV 表头可解析；
- required role 是否已提供；
- optional role 是否明确豁免。

### 8.4 服务端保持的唯一校验

- owner；
- task state；
- active plan；
- pending role 与 kind；
- multiple；
- Idempotency-Key；
- 扩展名、MIME、真实二进制签名；
- 字节、像素、UTF-8、CSV 结构；
- Artifact Hash、SEALED 与绑定。

不要在 Planner、Web、Gate、Renderer 重复实现同一可信校验。

### 8.5 已上传但未确认的 Artifact

首版不建设上传草稿中心。处理规则：

- 同一页面重试复用 uploadedInputId；
- Plan Replan、Task Cancel 或输入被替换时，失效未绑定的上传 Artifact；
- 不新增周期清理任务或第二套上传账本；进程中断遗留物先作为可观测残余风险记录；
- 不回填历史任务。

### 8.6 Phase 2 验收

由 §15 用两条代表路径覆盖：一条成功提交图片/CSV/文档，一条在中途失败后保留表单、复用成功项并单项重试。owner/task/plan 隔离继续复用既有 Gate 与 API 合同测试。

## 9. Phase 3：报告后任务级追问

### 9.1 功能边界

追问支持：

- 解释报告结论；
- 追问某个 Source、Gap、Tab 或行动建议；
- 比较报告中的两个结论；
- 请求更简洁或更具体的表达；
- 多轮围绕同一报告继续问答。

追问不支持：

- 修改已封存 Final Report；
- 自动重新执行 Skill；
- 自动调用新 Tool 或联网补充事实；
- 将追问答案写回原报告；
- 通用跨任务长期记忆；
- 任意文件再次上传；
- 自动把“重做”解释成不可逆执行。

用户需要新事实、补材料或重跑时，UI 明确提供“创建修订任务”。

### 9.2 API

新增任务级接口：

```http
GET /api/control-tasks/:taskId/follow-ups
```

返回：

```json
{
  "messages": [
    {
      "id": "...",
      "role": "user",
      "content": "为什么优先做这一项？",
      "createdAt": "..."
    },
    {
      "id": "...",
      "role": "assistant",
      "content": "...",
      "sourceIds": ["S-1"],
      "gaps": [],
      "createdAt": "..."
    }
  ]
}
```

```http
POST /api/control-tasks/:taskId/follow-ups
Idempotency-Key: <uuid>
Content-Type: application/json
```

请求：

```json
{
  "message": "为什么优先做这一项？"
}
```

响应：

```json
{
  "id": "...",
  "answer": "...",
  "sourceIds": ["S-1"],
  "gaps": [],
  "createdAt": "..."
}
```

### 9.3 服务端前置条件

- 用户已认证；
- task 属于当前 owner；
- task 状态为 `completed` 或 `completed_with_gaps`；
- Final Report Artifact 存在且 SEALED；
- 输入非空且在固定长度边界内；
- Idempotency-Key 有效；
- 同一请求只产生一次外部 LLM 调用和一次 assistant message。

### 9.4 报告上下文

不得把 HTML、ZIP、Base64 图片或整个 Workspace 发送给模型。构造固定文本视图：

```text
Report title
Summary
Native primary markdown，或 ReportDocument 的确定性文本投影
Source Catalog
Gaps
最近的任务级追问
当前问题
```

ReportDocument 投影规则：

- 保留 Tab、Section、Block 标题；
- markdown 使用原文本；
- table 转为行列文本；
- metric 使用 label/value/note；
- image 只使用 caption、altText、assetId，不发送图片字节；
- quadrant/timeline/wireframe 转为确定性文本；
- 不执行 Renderer，不读取 HTML。

上下文使用一个固定总预算，不新增环境配置。超过预算时按章节边界裁剪，并在模型上下文中标记“部分报告章节未纳入本轮追问”。优先级：

1. 当前问题；
2. 最近追问；
3. Report Summary 与 Gaps；
4. 与 Source ID 对应的报告正文；
5. 其余章节。

首版不建设向量检索。若无法在固定预算内可靠选择相关章节，发送 Summary、Gaps、Source Catalog 和从头按章节边界截取的正文。

### 9.5 LLM 输出合同

单次调用只返回：

```ts
interface TaskFollowUpAnswerV1 {
  answerMarkdown: string;
  sourceIds: string[];
  gaps: string[];
}
```

约束：

- `sourceIds` 必须属于 Final Report Source Catalog；
- 不得发明新 URL、Source、事实或数字；
- 证据不足时直接说明；
- 只能解释当前封存报告；
- 用户请求新研究时提示创建修订任务；
- 用户可见内容使用中文。

### 9.6 持久化

首版复用现有 `messages` 表，不新增 follow-up 表或通用事件系统。

消息 `content` 使用版本化 JSON：

```json
{
  "version": "task-follow-up-message-v1",
  "taskId": "...",
  "text": "...",
  "sourceIds": [],
  "gaps": []
}
```

规则：

- user 和 assistant 各一条 message；
- `conversation_id` 使用 task 已有 Conversation；
- assistant message 的 `artifact_id` 指向本轮依据的 Final Report Artifact；
- 使用现有 control command reservation 保证 LLM 调用幂等；
- GET 接口只返回 `content.taskId` 等于当前 task 的 follow-up message；
- `listMessages` 增加 `created_at`，不迁移旧消息；
- 历史非 follow-up message 不进入任务追问 UI。

当真实使用量证明 JSONB taskId 查询成为瓶颈后，再评估专用列或索引；首版不提前迁移。

### 9.7 Web

报告下方新增独立区块：

```text
基于本报告继续提问
[历史问答]
[输入框] [发送]
```

不要复用当前带运行模式、Skill 菜单和 Lab 按钮的全局 Composer。全局 Composer 继续用于新任务，报告追问使用小型任务级输入框。

UI 必须明确：

- “发送”是解释当前报告；
- “创建修订任务”会带上原 task ID 和用户的新要求创建新任务；
- 原报告不会被追问修改；
- 回答中的 Source ID 可定位到当前报告来源；
- 页面刷新后消息仍存在。

### 9.8 Phase 3 验收

由 §15 用四类测试覆盖：正常多轮与刷新恢复、owner/任务状态边界、幂等与 Source 子集、请求新研究时转为修订任务。既有 Final Report 和 Artifact 测试继续证明报告不可变；不新增 LLM Reviewer 或内容打分测试。

## 10. Phase 4：性能优化

### 10.1 轻量状态读取

新增 owner-bound 状态响应，避免执行期反复返回完整 Plan：

```http
GET /api/control-tasks/:taskId/status
```

最小响应：

```json
{
  "taskId": "...",
  "state": "executing",
  "stateVersion": 12,
  "updatedAt": "...",
  "currentAttemptId": "...",
  "steps": [
    {
      "stepNo": 1,
      "status": "succeeded",
      "startedAt": "...",
      "finishedAt": "..."
    }
  ]
}
```

客户端：

- 运行中先读 status；
- state、stateVersion、attempt 或 step digest 变化时再读完整 Task；
- 无变化时从 2 秒逐步退避到 4、8、16 秒；
- 状态变化后重置为 2 秒；
- 页面隐藏时暂停或降频；
- 不新增 WebSocket、消息总线或事件存储。

### 10.2 文件内存

分两步实施：

#### 第一步

- 前端提前校验数量和大小；
- Busboy 记录请求累计字节并尽早停止非法请求；
- visual 路由直接使用 12 文件上限，不先接受 20 个再由 Gate 拒绝；
- document 路由保留 20；
- 失败后立即 drain/close stream；
- 并发上传限制为 3 个 role。

#### 第二步

如压力测试仍显示明显峰值：

- multipart 文件先写 task-scoped 临时路径；
- Gate 每次只读取和验证一个文件；
- 成功后写入 Artifact；
- `finally` 删除临时文件；
- 峰值内存从“整批文件”降为“单文件 + 解码器”；
- 不引入对象存储或上传服务。

### 10.3 CSV

将 `csv-parse/sync` 路径改为增量处理：

- 逐行验证列宽；
- 增量计算 non-empty、unique、numeric min/max/mean；
- 增量估算标准化 Profile 大小；
- 超过模型视图预算时提前终止并返回现有 `dataset_too_large_for_analysis`；
- 原始 CSV 仍封存；
- 不自动采样后假装完整数据；
- 后续若需要抽样，必须作为显式用户选择和新合同处理。

### 10.4 图片

保留原始 Binary Artifact。模型调用可增加一个固定派生版本：

- 只在图片尺寸或字节超过模型合理输入范围时生成；
- 使用 `sharp`，不新增图像服务；
- 保留宽高比；
- 原图继续用于报告、下载和证据；
- 派生图只用于本次 LLM 请求；
- Manifest 记录原图 Hash 和派生图 Hash；
- 不持久化 data URL。

具体像素和质量值应以 Gateway 的真实限制为依据，在真实视觉 Smoke 前冻结；本方案不先发明配置项。

### 10.5 Skill Catalog

生产进程启动时生成一次 `InstalledSkillCatalogSnapshot`：

- catalog hash；
- InstalledSkill 元数据；
- package snapshot/hash；
- Binding 与 Tool readiness。

后续 Planner 和 `/skills` 复用该快照。Skill 变更通过重启应用生效。测试可注入临时 Catalog，不增加生产热更新。

### 10.6 报告读取

- Single Skill 完成页优先读取 Final Report，不重复获取等价 Skill Result 正文；
- Multi Skill 才读取 Contributor Result 列表；
- 历史列表继续只返回摘要，不加载报告；
- HTML/ZIP 继续按需 Blob 下载；
- Asset URL 保持 owner-bound。

### 10.7 前端 Bundle

当前生产 Bundle 不是首要瓶颈。只做低风险优化：

- 报告图表和非首屏 Lab 使用动态 import；
- 不为几十 KB 建设新的拆包配置面；
- 以 Vite build 输出和实际首次交互为依据。

## 11. 安全与数据边界

### 11.1 继续保留

- owner isolation；
- task/plan/attempt binding；
- Artifact SEALED 与 Hash；
- 图片真实签名、完整解码和 20MP 边界；
- 文档 UTF-8、扩展名和 MIME；
- CSV 结构与列宽；
- API Key、Authorization、JWT、Token、Secret、密码隐藏；
- 业务内容和 PII 原样处理；
- `ALLOW_REAL_PROVIDER=1` 只允许命令级注入。

### 11.2 追问边界

- 只读取当前 owner 的 Final Report；
- 不发送 HTML、ZIP、Base64 或不相关 Artifact；
- 不调用新 Tool；
- Source ID 必须来自报告；
- follow-up message 不改变 Task state；
- 不重新打开已封存 Plan；
- 不把追问当作审批或执行命令。

## 12. API 与合同变更清单

### 12.1 复用

- `SkillInputRequirement`
- `ResolvedPlanInputs`
- `PendingInput`
- Visual/Dataset/Document Upload API
- `messages`
- Control Command reservation
- Native Final Report
- SourceReference

### 12.2 新增的最小合同

- `TaskFollowUpMessageV1`
- `TaskFollowUpAnswerV1`
- `ControlTaskStatusResponseV1`
- Web-only `IntakeSubmissionState`

不新增：

- Native Plan v2；
- Native Result v2；
- Conversation v2；
- 通用 Attachment DSL；
- 通用 Chat Agent；
- Layout DSL；
- Reviewer 链。

## 13. 预计文件影响

### Phase 0

- `.github/workflows/ci.yml`
- 真实 Smoke Workflow（如需要，从 CI 拆为一个受保护 Workflow）
- `tests/playwright-page-capture-adapter.test.ts`
- 相关 deadline adapter 实现

### Phase 1

- `orchestrator/skill-bindings.yaml`
- `apps/orchestrator-runtime/src/input-resolution/resolved-plan-inputs.ts`
- `tests/native-plan-input-resolution.test.ts`
- `tests/skill-loader-schema.test.ts`
- 必要的规划测试

### Phase 2

- `apps/web/src/components/stages/Stage2Plan.tsx`
- `apps/web/src/hooks/useTaskFlow.ts`
- `apps/web/src/components/stages/stage2-plan-confirmation.ts`
- `apps/web/src/api/client.ts`
- `apps/agent-api/src/routes/control-tasks.ts`
- Intake/API/Workflow 测试

### Phase 3

- `packages/api-contract/control-workflow.ts` 或现有最接近的 Control API 合同文件
- `database/repository.ts`
- `apps/agent-api/src/routes/control-tasks.ts`
- `apps/agent-api/src/control-runtime.ts`
- Native Report 文本投影 helper
- `apps/web/src/pages/Workbench.tsx`
- 小型 Follow-up UI 组件
- API、owner、idempotency、上下文和 UI 测试

Phase 3 超过约 5 个文件。实施前必须再次做设计规模检查，并坚持任务级纵切，不扩展为通用聊天系统。

### Phase 4

- `apps/web/src/hooks/useTaskFlow.ts`
- `apps/web/src/api/client.ts`
- `apps/agent-api/src/routes/control-tasks.ts`
- `database/control-plane.ts`
- multipart 读取路径
- Dataset Gate
- Installed Skill Catalog
- 性能相关确定性测试

## 14. 实施提交建议

```text
fix: stabilize protected runtime checks
refactor: type active skill material requirements
fix: keep native intake recoverable during uploads
feat: add task-scoped report follow-ups
perf: poll lightweight task status
perf: bound material upload memory
perf: cache installed skill snapshots
```

每个提交只运行直接相关的目标测试。每个 Phase 合并前运行一次 `pnpm quality`；所有 Phase 集成后再统一运行 production build、migration dry-run 和容器 Smoke。不要在每个微小提交重复全量门禁，也不要把输入合同、追问和性能优化混成一个提交。

## 15. 验收方案

### 15.1 自动验证矩阵

| 风险边界 | 最少自动证据 |
|---|---|
| Skill 输入合同 | 一张表驱动测试覆盖全部 active Skill 的 key/kind/required/multiple/source；一组 Multi 共享与冲突用例 |
| Stage 2 Intake | 一条图片+CSV+文档成功路径；一条中途失败、保留状态并单项重试路径 |
| 上传安全 | 复用现有 Visual/Dataset/Document Gate 和 owner/task/plan API 合同 |
| 报告追问 | 正常多轮与刷新；owner/状态拒绝；幂等+Source 子集；新研究转修订任务 |
| 状态轮询 | fake timer 验证退避；状态变化只触发一次完整 Task Read |
| 文件性能 | 文件数/累计字节提前拒绝；CSV 超预算提前终止；Catalog 单进程只扫描一次 |

### 15.2 集成门禁

```text
Phase 开发中       仅目标测试
Phase 合并前       pnpm quality（一次）
全部 Phase 完成    pnpm build + migration dry-run + standalone container smoke（一次）
受保护真实环境     一个主路径 + 一个第二路径 real smoke（一次）
```

不在普通 GitHub Runner 上运行七场景真实调用，不用真实延迟毫秒值作为 CI 硬断言。

### 15.3 人工验收

按用户决定，最后只人工检查业务结果：

- Industry Single 与第二 Skill/Multi；
- 五 Tab 内容、图片、窄屏、键盘、打印、ZIP；
- 报告追问是否有用、是否忠于来源。

人工验收不增加独立 Reviewer 链，不要求每个 Phase 重复审核。

## 16. 可观测性

现有日志基础上只增加必要字段：

### Intake

- taskId
- planVersionId
- role
- kind
- fileCount
- byteCount
- status
- error type/code
- durationMs

不得记录文件正文、图片字节或 Secret。

### Follow-up

- taskId
- finalReportArtifactId
- requestId/idempotencyKey Hash
- contextBytes
- priorTurnCount
- sourceIdCount
- model identity
- durationMs
- error type/code

不得记录完整 Prompt、用户业务正文或凭据。

### Polling

- status read count
- full task read count
- unchanged poll count
- response byte size（聚合指标）

首版不引入监控平台；使用现有结构化日志和 CI/Smoke 证据。

## 17. 回滚

### Input Binding

- 单独回滚 Binding 提交；
- 不迁移历史 Task；
- 已冻结 Plan 保持不变。

### Intake UI

- 回滚 Web Intake 状态机；
- 上传 API 和 Artifact 合同不变。

### Follow-up

- 隐藏 Follow-up UI 并停止 POST 路由；
- 已保存 messages 保留只读；
- Final Report 和 Task 不受影响。

### Status Polling

- 回滚为完整 Task 轮询；
- 不改变数据库数据。

### 文件处理

- 保留原始 Artifact；
- 派生图片或临时文件可删除；
- 不改变报告引用的原始 Asset。

## 18. 风险与控制

| 风险 | 控制 |
|---|---|
| 修改 kind 导致旧任务不兼容 | 只影响新冻结 Plan，不迁移旧任务 |
| Multi 同 key 合并失败增加 | 明确来源交集，要求修正 Binding，不静默放宽 |
| 上传并发放大服务压力 | role 并发最多 3，服务端仍有硬边界 |
| Follow-up 发明新事实 | 固定报告上下文、Source 子集校验、禁用 Tool |
| Follow-up 修改报告语义 | 原 Report SEALED，消息单独保存 |
| JSONB taskId 查询变慢 | 首版会话量小；有数据后再决定索引 |
| 状态轮询漏进度 | status 返回 step 摘要，变化后拉完整 Task |
| Catalog 缓存看不到新 Skill | 生产通过重启生效，符合不可变发布模型 |
| 图片派生损失细节 | 原图保留；阈值以视觉 Smoke 冻结 |
| 公网 CI 无法访问 Gateway | 使用受保护 self-hosted/manual 环境 |

## 19. 明确非目标

本方案不做：

- PDF、DOCX、XLSX；
- OCR 平台；
- 任意文件解析插件；
- 未绑定附件池；
- 跨任务长期记忆；
- 通用 Chat Agent；
- 自动联网追问；
- 报告在线编辑器；
- 追问自动重写报告；
- 向量数据库或 RAG 平台；
- 对象存储迁移；
- 多副本部署；
- WebSocket/消息总线；
- 历史任务 backfill；
- Native v2 双轨；
- 新配置中心。

## 20. Definition of Done

全部满足后，本优化任务完成：

1. 所有 active Skill 的 typed requirement 与实际控件一致，Multi 共用输入只问一次且来源有效；
2. Stage 2 能提交图片、CSV、Markdown/TXT，并能在失败后保留状态、单项重试；
3. 报告完成后支持可恢复的任务级多轮追问，回答只基于 Final Report、Source 和 Gap；
4. 追问不会修改报告、重跑 Skill、调用新 Tool 或创建隐式新任务；
5. 执行期不再每 2 秒传输完整 Native Plan，文件和 CSV 处理有明确资源边界；
6. Skill Catalog 在生产进程内不重复扫描；
7. §15 的目标测试、一次集成门禁和两条受保护真实技术 Smoke 通过；
8. 业务内容质量由用户完成一次最终人工验收后再发布稳定版。
