/**
 * paper-reader workflow: run the paper-reader skill against a paper folder,
 * surface progress via background tasks, mark catalog `is_read` on success.
 *
 * Skill activation syntax is provider-specific (Host also adapts):
 * - Codex: `$paper-reader`
 * - Claude ACP: `/paper-reader`
 * - others: Agentero injects SKILL.md body (no native $ / / trigger)
 */
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import {
	type AgentPlanEntry,
	type AgentTemplate,
	listAgents,
	type RunOnceAccepted,
} from "@/lib/agent";
import {
	clearGteroRunAttempt,
	handleGteroResumeFailure,
	runOnceGtero,
} from "@/lib/agent/gtero-run";
import {
	AgentRunTimeoutError,
	PAPER_READER_RUN_TIMEOUT_MS,
	subscribeAgentRun,
} from "@/lib/agent/run-wait";
import { rememberGteroSession } from "@/lib/agent/vault-session";
import {
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
import { isTauri } from "@/lib/core/tauri";
import { setPaperIsRead } from "@/lib/paper/api";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import { loadSettings } from "@/lib/settings";
import { joinVaultPath } from "@/lib/vault";

const PAPER_READER_SKILL_ID = "paper-reader";

/** Prevent concurrent reads of the same paper (auto + Zap). */
const inflightReads = new Set<string>();

/** How this Agentero agent template expects skills to be named in the user prompt. */
type SkillMentionStyle = "dollar" | "slash" | "injected";

function skillMentionStyleForTemplate(
	template: AgentTemplate | string | null | undefined,
): SkillMentionStyle {
	switch (template) {
		case "claude-acp":
		case "openclaw":
		case "hermes":
			return "slash";
		default:
			return "injected";
	}
}

function formatSkillMention(skillId: string, style: SkillMentionStyle): string {
	switch (style) {
		case "dollar":
			return `$${skillId}`;
		case "slash":
			return `/${skillId}`;
		default:
			return `skill:${skillId}`;
	}
}

/**
 * Language line for paper-reader NOTES.md body, based on the resolved App
 * locale (`i18n.language` after settings load: `en` | `zh-CN`).
 * Fixed skill section headings stay English; only the body language changes.
 */
export function paperReaderLanguageInstruction(
	language: string = i18n.language,
): string {
	const lang = (language || "en").toLowerCase();
	if (lang.startsWith("zh")) {
		return "Write the NOTES.md body in Chinese (Simplified). Keep the fixed English section headings from the skill (e.g. ## Method).";
	}
	return "Write the NOTES.md body in English.";
}

/**
 * User-facing request body. Host will additionally prefix native triggers
 * (e.g. `$paper-reader` for Codex) and inject SKILL.md by style.
 */
export function buildPaperReaderUserPrompt(
	paperRel: string,
	style: SkillMentionStyle,
	language: string = i18n.language,
): string {
	const mention = formatSkillMention(PAPER_READER_SKILL_ID, style);
	const skillLine =
		style === "dollar"
			? `Activate and follow ${mention} (this agent uses $skill-id syntax).`
			: style === "slash"
				? `Activate and follow ${mention} (this agent uses /skill-id syntax).`
				: `Follow the paper-reader skill instructions Agentero injects into this prompt (${mention}). Do not wait for a separate $ or / command.`;

	return [
		skillLine,
		`Paper folder (Vault-relative): \`${paperRel}\`.`,
		"Prefer TeX under source/, else PAPER.md, else local PDF.",
		`Write structured lecture notes into \`${paperRel}/NOTES.md\`.`,
		paperReaderLanguageInstruction(language),
		"If NOTES.md already has substantial notes, APPEND a section headed `## Gtero · YYYY-MM-DD` instead of replacing user-written text.",
		"Keep [[wikilinks]]. End with ## Sources listing Vault-relative paths you read.",
	].join("\n");
}

async function resolveDefaultAgentTemplate(): Promise<AgentTemplate | null> {
	try {
		const list = await listAgents();
		const id = list.defaultId;
		if (!id) return list.agents[0]?.template ?? null;
		return list.agents.find((a) => a.id === id)?.template ?? null;
	} catch {
		return null;
	}
}

function planDetail(entries: AgentPlanEntry[]): string {
	if (!entries.length) {
		return i18n.t("app:tasks.paperReadRunning");
	}
	const active = entries.find(
		(e) => e.status === "in_progress" || e.status === "pending",
	);
	return (
		active?.content?.trim() ||
		entries[entries.length - 1]?.content?.trim() ||
		i18n.t("app:tasks.paperReadRunning")
	);
}

/**
 * Subscribe to agent:completed / agent:failed (and plan/tool progress)
 * *before* `runOnce`. Host `agent_run_once` is fire-and-forget; a fast
 * `agent:failed` is otherwise missed and the task hangs forever.
 */
async function subscribePaperReaderWait(taskId: string) {
	return subscribeAgentRun({
		timeoutMs: PAPER_READER_RUN_TIMEOUT_MS,
		timeoutError: i18n.t("app:tasks.paperReadTimeout"),
		onPlan: (ev) => {
			updateBackgroundTask(taskId, {
				detail: planDetail(ev.entries ?? []),
			});
		},
		onTool: (ev) => {
			const title = ev.title?.trim();
			if (title) {
				updateBackgroundTask(taskId, { detail: title });
			}
		},
	});
}

/**
 * Start paper-reader for a Vault-relative paper path.
 * Reports progress in the bottom-left background task floater.
 */
export async function runPaperReaderWorkflow(opts: {
	vaultRoot: string;
	/** Vault-relative paper folder, e.g. papers/1706.03762 */
	paperPath: string;
}): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.readDesktopOnly"));
	}
	const paperRel = opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!paperRel) {
		throw new Error(i18n.t("sidebar:fileTree.readFailed"));
	}
	if (inflightReads.has(paperRel)) {
		return;
	}
	inflightReads.add(paperRel);

	try {
		await enqueueBackgroundTask(
			{
				kind: "paperRead",
				title: i18n.t("app:tasks.paperRead"),
				detail: paperRel,
			},
			async ({ id, signal, setDetail }) => {
				setDetail(i18n.t("app:tasks.paperReadStarting"));

				const template = await resolveDefaultAgentTemplate();
				const skillStyle = skillMentionStyleForTemplate(template);
				const userPrompt = buildPaperReaderUserPrompt(paperRel, skillStyle);

				const waiter = await subscribePaperReaderWait(id);
				let sessionId: string | undefined;
				try {
					const accepted: RunOnceAccepted = await runOnceGtero({
						vaultPath: opts.vaultRoot,
						workflow: "paper_reader",
						target: paperRel,
						prompt: userPrompt,
						skillIds: [PAPER_READER_SKILL_ID],
						autoApprove: true,
						// Background workflow — never surface in Agent chat history.
						hideFromChatHistory: true,
					});
					sessionId = accepted.sessionId;
					const cancelAgent = () => {
						void invoke("agent_cancel_run", { sessionId: accepted.sessionId });
					};
					if (signal.aborted) {
						cancelAgent();
						throw new Error(i18n.t("app:tasks.cancelled"));
					}
					signal.addEventListener("abort", cancelAgent, { once: true });

					setDetail(i18n.t("app:tasks.paperReadRunning"));
					const result = await waiter.wait(accepted.sessionId, { signal });
					clearGteroRunAttempt(accepted.sessionId);
					if (result.providerSessionId) {
						await rememberGteroSession(
							opts.vaultRoot,
							result.providerSessionId,
						);
					}

					setDetail(i18n.t("app:tasks.paperReadMarking"));
					await setPaperIsRead(opts.vaultRoot, paperRel, true);
					setDetail(i18n.t("app:tasks.paperReadDone"));
				} catch (e) {
					if (signal.aborted || isBackgroundTaskCancelledError(e)) {
						throw e;
					}
					if (e instanceof AgentRunTimeoutError) {
						if (sessionId) {
							void invoke("agent_cancel_run", { sessionId });
						}
						throw e;
					}
					const msg = await handleGteroResumeFailure({
						error: e,
						copy: {
							sessionLost: i18n.t("agent:messages.sessionLost"),
							sessionRetry: i18n.t("agent:messages.sessionRetry"),
							fallback: e instanceof Error ? e.message : String(e),
						},
					});
					throw new Error(msg);
				} finally {
					waiter.dispose();
				}
			},
		);
	} finally {
		inflightReads.delete(paperRel);
	}
}

/**
 * Whether local assets are enough to start paper-reader
 * (TeX, PAPER.md, or PDF — matching skill read order).
 */
export function paperAssetsReadyForReader(flags: {
	pdf?: boolean | null;
	tex?: boolean | null;
	paperMd?: boolean | null;
}): boolean {
	return Boolean(flags.tex || flags.paperMd || flags.pdf);
}

/** Auto paper-reader only for a single paper in one user action. */
export const AFTER_IMPORT_AUTO_READER_MAX = 1;

/**
 * Auto paper-reader is only for a single newly ingested paper.
 * Bulk wand paste / multi-PDF / library bib import must not fan out Agent runs.
 */
export function shouldAutoRunAfterPaperImport(
	importedCount: number,
	submitCount: number = importedCount,
): boolean {
	return (
		submitCount === AFTER_IMPORT_AUTO_READER_MAX &&
		importedCount === AFTER_IMPORT_AUTO_READER_MAX
	);
}

/**
 * After import / download: if Settings → Agent → auto paper-reader is on,
 * assets are ready, and catalog `is_read` is false, start paper-reader
 * (shows left-bottom progress). Returns true when a run started.
 *
 * Default setting is **off**. Does not throw on skip; rethrows agent/workflow
 * failures so callers can surface errors. Manual Zap always uses
 * {@link runPaperReaderWorkflow} directly.
 *
 * Callers: `afterPaperImport` from magic-wand (single), local PDF (single),
 * and single Download — not bulk ingest.
 */
export async function maybeAutoRunPaperReader(opts: {
	vaultRoot: string;
	/** Vault-relative paper folder */
	paperPath: string;
	/** Caller-known asset flags after ingest */
	assetsReady: boolean;
}): Promise<boolean> {
	if (!opts.assetsReady || !isTauri()) return false;
	if (!loadSettings().autoPaperReader) return false;
	const paperRel = opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!paperRel || inflightReads.has(paperRel)) return false;

	const abs = joinVaultPath(opts.vaultRoot, paperRel);
	try {
		const meta = await loadPaperMetadata(abs, opts.vaultRoot);
		if (meta?.is_read === true) return false;
	} catch {
		// No catalog row / unreadable — still try (workflow may work; mark may fail)
	}

	await runPaperReaderWorkflow({
		vaultRoot: opts.vaultRoot,
		paperPath: paperRel,
	});
	return true;
}
