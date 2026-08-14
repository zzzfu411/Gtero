# Gtero rebase onto upstream 0.6.0

**目标**：把 Gtero sticky 层干净 port 到当前官方 Agentero，修掉 P0，对齐版本与文档，让本仓可以继续当 Grok-first 阅读器迭代。

**基线变更**：分析时上游是 0.5.5。今日 `upstream/main` 已到 **0.6.0**（`e3525060`，比 Gtero `main` 超前 711 commits）。再钉 0.5.5 会立刻再落后一个大版本，因此本轮对齐 **upstream/main / v0.6.0**。

## 不变量

- 不改官方 Agentero 仓（`D:\AppStore\Agentero`）。
- 不碰用户 Vault、不提交 `scripts/*bbobasic*.py`。
- Gtero 语义保持：每 Vault 一条 sticky Grok 会话；fork 须确认；NOTES 只追加；关开关 = 上游行为。
- 传输仍是 ACP `session/resume`，不直连 xAI Chat API。
- 工作在独立 worktree：`D:\AppStore\Gtero-rebase`，分支 `rebase/upstream-v0.6.0`。合入 `main` 前不 force-push。

## 阶段

### A. Port Gtero 层（本轮主干）

从 Gtero `484e074` + `a38469f` 把下列**新文件**原样带上，并按上游 0.6 API 改 import：

| 新文件 | 职责 |
|---|---|
| `src/lib/agent/vault-session.ts` | binder |
| `src/lib/agent/gtero-run.ts` | sticky `runOnce` + lane |
| `src/lib/agent/gtero-prompts.ts` | 解释 / 综析 prompt |
| `src/lib/agent/notes-patch.ts` | 本地追加 NOTES |
| `src/lib/agent/paper-context.ts` | `[Gtero focus]` |
| `src/components/agent/gtero-fork-dialog.tsx` | fork 确认 |
| `docs/frontend/gtero.md` | 产品规格 |
| `test/gtero-session.test.ts` | 纯函数测 |
| `test/gtero-workspace.test.ts` | binder IO 测 |
| `test/vault-session.test.ts` | 若上游无同名则新增 |

**必须手工合并**（上游 0.6 已改过这些文件）：

- 前端：`use-agent-panel.ts`、`pdf-viewer.tsx`、selection menu/gutter/translate-card、settings agent rows、shell title/right sidebar
- Host：`features/agent/acp.rs`、`prompts.rs`、`settings`、`vault`、`pdf_parse`
- 设置类型 / defaults / i18n en+zh-CN
- paper-reader skill、`reader.ts`、pdf ask prompt
- README / AGENTS.md / architecture / todo / roadmap / mkdocs

合并原则：以上游 0.6 为底，把 Gtero 语义补进去；不要把 0.3.2 时代的周围代码带回来。

### B. P0 修复（在新基线上做，避免双修）

1. **事件竞态**（已修）：精读 / PDF 快车道 `subscribeAgentRun` 先订阅 `agent:completed|failed` 再 `runOnce`，按 session id 缓冲终端事件；`wait` 有超时（精读 30min / PDF 10min）。聊天面板仍用 `pendingTerminalEventsRef`。
2. **`refreshLibrary`**：失败保留旧 rows + `notifyError`，禁止 `setLibraryPapers([])`。
3. **`afterPaperImport`**：魔棒单条成功、本地 PDF 导入、单篇 Download 走同一后置（`maybeAutoRunPaperReader` + refresh）。

### C. 对齐

- 版本：跟随上游 **0.6.0**（`package.json` / Tauri / Cargo / CLI），Gtero 不另起版本号，除非要发独立包。
- 文档：路线图/TODO 不再写 0.2.1；补 Gtero 已完成项；删或标明 `export_papers_md` 伪 API。
- README 保持「非官方 fork」声明。
- updater：本轮**不改**公钥/endpoint（仍走官方 Agentero 更新源）。独立发版另开任务。
- 产品名：Host `productName` 仍为 Agentero，避免弄乱 identifier / 设置目录；README / 文档用 Gtero。
- i18n parity；`(empty response)` 走 `t()`。

### D. 验证

- `pnpm test`、`pnpm typecheck`、`pnpm exec biome check` 相关文件
- 能跑则 `cargo clippy -p agentero --all-targets -- -D warnings`
- 手工对照：`docs/frontend/gtero.md` 的开关 / fork / 写笔记 / resume 分类仍成立
- Windows liteparse：保留 Gtero 的 cfg 修复，不要回退

### E. 明确不做（本轮）

- MCP 阅读器、BM25 索引、headless `grok -p`、设置瘦身
- 独立安装包 / 改 updater 指向 `zzzfu411/Gtero`
- 合入 `main`、push、tag、发 Release（需你确认）
- 真机走查（本机 Tauri 窗口，计划完成后另做）

## 完成定义

1. `rebase/upstream-v0.6.0` 基于 `upstream/main`，包含完整 Gtero 层。
2. 三个 P0 在新树上已修，有测试或最小复现断言。
3. `pnpm test` + `pnpm typecheck` 绿。
4. 文档不再声称当前发布是 0.2.1。
5. 官方 `D:\AppStore\Agentero` 仍干净。
