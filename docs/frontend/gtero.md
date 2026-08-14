# Gtero（Grok 知识库线程）

Gtero 是 Agentero 上的 Grok-first 层：每个 Vault 复用一条 ACP 会话（默认 Grok Build），论文阅读、划词解释、精读与库综合走同一线程。不改 Host ACP 协议，也不把 xAI Chat API 当作传输。

产品名是 Gtero；仓库与 Host 仍叫 Agentero。关闭设置中的 Gtero 后行为回到上游「每次 `session/new`」。

## 粘性会话

| 项 | 说明 |
|---|---|
| 绑定文件 | `{vault}/.agentero/grok-workspace.json`（首次记住 session 后写入，非 `vault_create` 脚手架） |
| 默认 | `gtero.enabled` + `gtero.sticky` 均为开 |
| 恢复 | 未显式传 `sessionId` 时，`runOnceGtero` 填入 `primarySessionId` → ACP `session/resume` |
| 首次 | binder 为空则 `session/new`，完成后把 provider session 记为 primary |
| 分叉 | 侧栏「+」弹出应用内 Dialog；确认后 `session/new`，新 id 进 `forks[]`，**不替换** primary |
| 精读 / 划词 | 始终走 primary（即使当前聊天标签是 fork） |
| 恢复失败 | 见下方分类：仅**永久拒绝**忘掉该 id；超时/传输等保持指针并提示重试 |

Host 已支持 `session/resume`（`runOnce({ sessionId })`）。Gtero 只是在前端把 Vault 级 id 填进去，并用 lane 串行化，避免划词与聊天抢同一会话。

### 恢复失败分类

前端用一个分类器（`classifyGteroResumeError`）处理聊天、划词与精读的所有失败面。Host 契约见 [../backend/agent.md](../backend/agent.md)（前缀常量 `GTERO_RESUME_REJECTED_PREFIX`）；此处不重复 Host 码表。

| 种类 | 何时 | Binder | 用户文案 |
|---|---|---|---|
| 永久拒绝 (`rejected`) | 错误字符串**以** `gtero_resume_rejected: ` **开头**；或第三方 Agent 的「unknown session / session not found / invalid session」启发式（不含超时/取消/传输措辞） | `forgetGteroSession` 丢掉**本轮实际 resume 的 id**（不是重读 binder） | `messages.sessionLost` / `pdfAsk.sessionLost` / `selection.sessionLost`。展示前剥掉机器前缀 |
| 瞬时失败 (`transient`) | 15s 超时、传输 `never received`、`method_not_found`、`request_cancelled`、`auth_required`、`parse_error` 等（Host **不加**前缀） | **保留** sticky id，下次仍 resume 同一线程 | `messages.sessionRetry` / `pdfAsk.sessionRetry` / `selection.sessionRetry` |
| 其它 | 与 resume 无关的错误 | 不动 | 剥前缀后的原文或通用失败文案 |

`agent_run_once` 是 fire-and-forget：真正的拒绝通常走 `agent:failed`，而不是 `runOnce()` 的 Promise reject。精读 / PDF 快车道用 `subscribeAgentRun` **先**订阅并缓冲终端事件，再 `runOnce`；`wait` 超时（PDF 10 分钟、精读 30 分钟），避免漏事件后永久挂起。`runOnceGtero` 把填入的 provider session id 记在本地 run id 上；`handleGteroResumeFailure` 是唯一会分类 + 按需 forget + 返回展示文案的入口。

`rememberGteroSession` 与 resume 使用同一条件（`gtero.enabled && gtero.sticky`）。Gtero 开着但粘性关闭时成功的 turn **不会**改 binder。

## 双速车道

| 车道 | 入口 | 落盘 / UI |
|---|---|---|
| Fast | PDF 提问、翻译（Agent 提供方）、解释 | 选区卡片 + `marks/`；`hideFromChatHistory`；仍 resume sticky |
| Deep | 聊天、精读、库综合 | 同一 sticky session；精读也 `hideFromChatHistory` |
| 本地 | 写入笔记 | 不调 ACP；只追加 `NOTES.md` |

PDF 提问在 sticky resume 时**不再**把卡片历史塞进 prompt（已在会话记忆里）；`includeHistory` 仅在即将 `session/new` 时为 true。卡片 transcript 仍写入 `marks/`。

解释卡片复用翻译 record（`mode: "explain"`），页边针为灯泡。

「写入笔记」在 `{paper}/NOTES.md` 当日 `## Gtero · YYYY-MM-DD` 下追加：引用块 + 页码锚点（`Source (p.N)`）+ 已完成的解释/翻译正文（若有，优先解释）。不覆盖已有正文，也不发起新的 Agent 轮次。

## 库综合

空态建议「综合我已读过的论文」→ workflow `corpus_synthesis`。Host 要求先搜 catalog / 读 NOTES，禁止把整本 PDF 塞进上下文，报告写到 `notes/` 下以当天日期命名的新 Markdown，并在对话里回复。

## 精读

`paper-reader` Skill 与 Host `paper_reader` prompt：若 NOTES 已有实质笔记，追加 `## Gtero · YYYY-MM-DD`，不整文件替换。导入 stub（仅标题/摘要壳）仍可写五段讲义结构。

## 设置

设置 → Agent：

- **Gtero（Grok 知识库线程）**（`gtero.enabled`）：总开关
- **粘性会话**（`gtero.sticky`）：关闭后每次运行 `session/new`（解释 / 写笔记仍可用；写笔记不依赖 ACP）

`AppSettings.gtero` 前后端都有字段；缺省按默认补全，往返保留 `enabled` / `sticky`。

## 代码

| 路径 | 职责 |
|---|---|
| `src/lib/agent/vault-session.ts` | binder 读写、remember / forget |
| `src/lib/agent/gtero-run.ts` | sticky `runOnce` + lane |
| `src/lib/agent/run-wait.ts` | 先订阅再 `runOnce`；缓冲终端事件 + 超时 |
| `src/lib/agent/gtero-prompts.ts` | 解释 / 库综合 prompt |
| `src/lib/agent/notes-patch.ts` | 追加 NOTES 段落（引用 + 页码 + 解释） |
| `src/lib/agent/paper-context.ts` | `[Gtero focus]` 压缩块 |
| `src/lib/pdf/ask/prompt.ts` | 划词提问 prompt；resume 时不重发卡片历史 |
| `src/components/agent/use-agent-panel.ts` | 面板编排：粘性线程、分叉确认、vault binder 恢复 |
| `src/components/agent/hooks/use-agent-session-runtime.ts` | 聊天完成/失败；resume 分类 |
| `src/components/agent/hooks/use-agent-send.ts` | 库综合 / sticky send |
| `src/components/agent/gtero-fork-dialog.tsx` | 分叉确认 Dialog |
| `src/components/viewer/pdf/pdf-viewer.tsx` | PDF 阅读器外壳（0.6 布局，非 `embed/`） |
| `src/components/viewer/pdf/hooks/use-pdf-ask-threads.ts` | 划词提问 sticky ask |
| `src/components/viewer/pdf/hooks/use-pdf-selection-translate.ts` | 划词解释 / 写笔记 |
| `src/lib/paper/reader.ts` | 精读走 sticky + 追加 NOTES 指令 |

Host：`features/agent/prompts.rs`（`corpus_synthesis`、精读追加）、`features/settings`（`GteroSettings`）。ACP 会话本身见 [../backend/agent.md](../backend/agent.md)。
