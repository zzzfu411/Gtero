/**
 * Selection → 翻译 workflow for the EmbedPDF viewer: the one ephemeral mark kind.
 * A translate card is created straight from the selection menu, streams into the
 * open card, and disappears again unless it is hovered — so this cluster owns the
 * whole run lifecycle (`translateStreaming`, its cancel token, its error chrome)
 * plus the record write to `marks/<id>.json`.
 *
 * Its own hook because the run has two providers behind one UI contract: an ACP
 * Agent (streamed through the three agent listeners, cancellable) and a plain
 * translate provider (single await). Both funnel into `upsertTranslate` /
 * `persistTranslate` / `markTranslateFailure`, and nothing outside translate
 * touches them.
 *
 * Boundaries:
 * - the persisted array lives in {@link usePdfMarksIo}: setters and the mirror
 *   ref are injected, never re-declared here;
 * - card placement / hover lives in {@link usePdfCards}: this hook only opens,
 *   hides, and re-arms the hover-hide timer for its own card;
 * - `activeSessionRef` is shared with the ask cluster (at most one PDF agent run
 *   is in flight), so the parent owns it and injects it into both;
 * - the selection menu owns its own teardown, so the parent closes the menu and
 *   hands this hook the anchor.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import { cancelAgentRun, listAgents, runOnce } from "@/lib/agent";
import { buildExplainPrompt } from "@/lib/agent/gtero-prompts";
import { clearGteroRunAttempt, runOnceGtero } from "@/lib/agent/gtero-run";
import {
	appendNotesSection,
	formatSelectionNoteBody,
} from "@/lib/agent/notes-patch";
import {
	AgentRunDisposedError,
	AgentRunTimeoutError,
	DEFAULT_AGENT_RUN_TIMEOUT_MS,
	isAgentRunAbortError,
	subscribeAgentRun,
} from "@/lib/agent/run-wait";
import { rememberGteroSession } from "@/lib/agent/vault-session";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { gteroUserFacingError } from "@/lib/pdf/ask";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import {
	createTranslateRecord,
	deletePdfTranslate,
	finishedInsightForSelection,
	writePdfTranslate,
} from "@/lib/pdf/translate";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { loadSettings } from "@/lib/settings";
import {
	buildTranslatePrompt,
	prepareTranslateTask,
	resolveTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";
import { applyDiskChange } from "@/lib/workspace/actions";

export type UsePdfSelectionTranslateOptions = {
	/** Sidecar root for `marks/<id>.json` (null for loose PDFs — nothing persists). */
	paperAbsPath: string | null;
	/** Vault-relative provenance stamped into the record. */
	paperRelPath: string | null;
	/** Vault root passed to the Agent run as its cwd. */
	vaultPath: string | null;
	/** Viewer prop: open Translate settings from the error card. */
	onOpenSettings: PdfViewerProps["onOpenSettings"];
	/** Persisted translate records; owned by {@link usePdfMarksIo}. */
	translatesRef: RefObject<PdfTranslateRecord[]>;
	setTranslates: Dispatch<SetStateAction<PdfTranslateRecord[]>>;
	upsertTranslate: (rec: PdfTranslateRecord) => void;
	/** Open card, needed as a value: the auto-hide effect re-arms when it changes. */
	activeCard: ActiveSelectionCard | null;
	/** Cards cluster; owned by {@link usePdfCards}. */
	openCard: (card: ActiveSelectionCard) => void;
	hideActiveCard: () => void;
	scheduleHoverHide: () => void;
	cardHoverSurfaceRef: RefObject<boolean>;
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	/**
	 * Single in-flight PDF agent run, shared with the ask cluster. Parent-owned so
	 * either cluster can cancel the other's session token.
	 */
	activeSessionRef: RefObject<string | null>;
	/**
	 * Mirror of `translateStreaming`. Created by the parent because
	 * {@link usePdfCards} is declared first and reads it to keep a streaming
	 * translate card alive past hover.
	 */
	translateStreamingRef: RefObject<boolean>;
};

export type PdfSelectionTranslate = {
	translateStreaming: boolean;
	translateError: string | null;
	/** Selection-menu action: create the record and start the run. */
	translateSelection: (anchor: PdfAskAnchor) => void;
	/** Selection-menu action: sticky Gtero explain card (mode=explain). */
	explainSelection: (anchor: PdfAskAnchor) => void;
	/** Selection-menu action: append quote + page + insight to NOTES.md. */
	writeSelectionNotes: (anchor: PdfAskAnchor) => void;
	/** Cancel the in-flight run; also wired into {@link usePdfCards}. */
	stopTranslateSession: () => void;
	/** Card header delete: drop the record from state + disk and close the card. */
	deleteTranslateCard: () => void;
	/** Error card action: open Translate settings. */
	openTranslateSettings: () => void;
	/** Per-kind chrome reset for card open / close (wired into `usePdfCards`). */
	clearTranslateError: () => void;
};

export function usePdfSelectionTranslate({
	paperAbsPath,
	paperRelPath,
	vaultPath,
	onOpenSettings,
	translatesRef,
	setTranslates,
	upsertTranslate,
	activeCard,
	openCard,
	hideActiveCard,
	scheduleHoverHide,
	cardHoverSurfaceRef,
	activeCardRef,
	activeSessionRef,
	translateStreamingRef,
}: UsePdfSelectionTranslateOptions): PdfSelectionTranslate {
	const { t } = useTranslation("viewer");
	const [translateStreaming, setTranslateStreaming] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);
	/** ACP session of the running translate turn (null for provider translate). */
	const translateSessionRef = useRef<string | null>(null);
	/** Per-run IPC unlisteners of the in-flight translate turn (null when idle). */
	const translateUnsubsRef = useRef<UnlistenFn[] | null>(null);
	/** True once the viewer unmounts; guards runs accepted after teardown. */
	const translateDisposedRef = useRef(false);

	// Closing the viewer must not strand the run's IPC listeners (or the run
	// itself): terminal events never arrive for a hung run, so teardown cannot
	// rely on the completed/failed handlers alone.
	useEffect(() => {
		translateDisposedRef.current = false;
		return () => {
			translateDisposedRef.current = true;
			const unsubs = translateUnsubsRef.current;
			translateUnsubsRef.current = null;
			if (unsubs) for (const u of unsubs) u();
			const sid = translateSessionRef.current;
			if (sid) {
				translateSessionRef.current = null;
				if (activeSessionRef.current === sid) activeSessionRef.current = null;
				void cancelAgentRun(sid).catch(() => undefined);
			}
			translateStreamingRef.current = false;
		};
	}, [activeSessionRef, translateStreamingRef]);

	const stopTranslateSession = useCallback(() => {
		const unsubs = translateUnsubsRef.current;
		translateUnsubsRef.current = null;
		if (unsubs) for (const u of unsubs) u();
		const sid = translateSessionRef.current;
		if (sid) {
			void cancelAgentRun(sid).catch(() => undefined);
			if (activeSessionRef.current === sid) activeSessionRef.current = null;
			translateSessionRef.current = null;
		}
		translateStreamingRef.current = false;
		setTranslateStreaming(false);
	}, [activeSessionRef, translateStreamingRef]);

	const clearTranslateError = useCallback(() => {
		setTranslateError(null);
	}, []);

	const openTranslateSettings = useCallback(() => {
		onOpenSettings?.();
	}, [onOpenSettings]);

	const persistTranslate = useCallback(
		async (rec: PdfTranslateRecord) => {
			if (!paperAbsPath) return;
			try {
				await writePdfTranslate(paperAbsPath, rec);
			} catch {
				// keep UI responsive
			}
		},
		[paperAbsPath],
	);

	const markTranslateFailure = useCallback(
		(id: string, message: string) => {
			const latest = translatesRef.current.find((r) => r.id === id);
			if (latest) {
				upsertTranslate({
					...latest,
					error: message,
					updatedAt: new Date().toISOString(),
				});
			}
			translateStreamingRef.current = false;
			setTranslateStreaming(false);
			setTranslateError(message);
		},
		[upsertTranslate, translatesRef, translateStreamingRef],
	);

	// Translate cards are ephemeral: once streaming ends, auto-hide unless the
	// pointer is still over the card, pin, or source highlight.
	const activeTranslateCardId =
		activeCard?.kind === "translate" ? activeCard.id : null;
	useEffect(() => {
		if (!activeTranslateCardId) return;
		if (translateStreaming) return;
		if (cardHoverSurfaceRef.current) return;
		scheduleHoverHide();
	}, [
		activeTranslateCardId,
		translateStreaming,
		scheduleHoverHide,
		cardHoverSurfaceRef,
	]);

	const translateSelection = useCallback(
		(anchor: PdfAskAnchor) => {
			const quote = anchor.quote?.trim();
			if (!quote) return;
			stopTranslateSession();
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const paperKey = paperRelPath || paperAbsPath || null;
			const rec = createTranslateRecord({
				paperPath,
				page: anchor.page,
				rects: anchor.rects,
				quote,
			});
			upsertTranslate(rec);
			// Menu action is not a hover surface; card auto-hides after result.
			cardHoverSurfaceRef.current = false;
			openCard({ kind: "translate", id: rec.id });
			translateStreamingRef.current = true;
			setTranslateStreaming(true);
			setTranslateError(null);

			const { providerId, targetLangName } = prepareTranslateTask({
				text: quote,
				context: { page: anchor.page, surface: "pdf-selection" },
			});

			if (providerId === "agent") {
				const prompt = buildTranslatePrompt({
					text: quote,
					targetLangName,
					page: anchor.page,
					surface: "pdf-selection",
				});
				void (async () => {
					try {
						const registry = await listAgents().catch(() => null);
						const resolved = resolveTranslateAgent(
							loadSettings().translate,
							registry,
						);
						if (!resolved.agentId) {
							const msg = t("selection.translateNoAgent");
							notifyError(msg);
							markTranslateFailure(rec.id, msg);
							return;
						}
						const agentId = resolved.agentId;
						const modelId = resolved.modelId;
						const waiter = await subscribeAgentRun({
							timeoutMs: DEFAULT_AGENT_RUN_TIMEOUT_MS,
							timeoutError: t("pdfAsk.agentTimeout"),
							onStream: (ev) => {
								if ((ev.kind ?? "message") === "thought") return;
								const latest =
									translatesRef.current.find((r) => r.id === rec.id) ?? rec;
								upsertTranslate({
									...latest,
									result: (latest.result ?? "") + ev.chunk,
									updatedAt: new Date().toISOString(),
									error: undefined,
								});
							},
						});
						const unsubs: UnlistenFn[] = [() => waiter.dispose()];
						translateUnsubsRef.current = unsubs;
						let sessionId: string | undefined;
						const cleanup = () => {
							waiter.dispose();
							if (translateUnsubsRef.current === unsubs)
								translateUnsubsRef.current = null;
							if (sessionId && translateSessionRef.current === sessionId)
								translateSessionRef.current = null;
							if (sessionId && activeSessionRef.current === sessionId)
								activeSessionRef.current = null;
							translateStreamingRef.current = false;
							setTranslateStreaming(false);
						};
						try {
							const accepted = await runOnce({
								prompt,
								agentId,
								modelId,
								sessionId:
									getAgentTranslateSessionId(paperKey, agentId, modelId) ??
									undefined,
								vaultPath: vaultPath ?? undefined,
								workflow: "free",
								autoApprove: true,
								hideFromChatHistory: true,
							});
							if (translateDisposedRef.current) {
								void cancelAgentRun(accepted.sessionId).catch(() => undefined);
								return;
							}
							sessionId = accepted.sessionId;
							translateSessionRef.current = sessionId;
							activeSessionRef.current = sessionId;
							const ev = await waiter.wait(sessionId);
							const latest =
								translatesRef.current.find((r) => r.id === rec.id) ?? rec;
							const next = {
								...latest,
								result: (ev.content || latest.result || "").trim(),
								updatedAt: new Date().toISOString(),
								error: undefined,
							};
							upsertTranslate(next);
							void persistTranslate(next);
							setTranslateError(null);
							if (ev.providerSessionId && ev.stopReason !== "cancelled") {
								setAgentTranslateSessionId(
									paperKey,
									agentId,
									modelId,
									ev.providerSessionId,
								);
							}
						} catch (waitErr) {
							if (sessionId) {
								void cancelAgentRun(sessionId).catch(() => undefined);
							}
							evictAgentTranslateSessionId(paperKey, agentId, modelId);
							if (
								translateDisposedRef.current ||
								waitErr instanceof AgentRunDisposedError ||
								isAgentRunAbortError(waitErr)
							)
								return;
							const msg =
								waitErr instanceof AgentRunTimeoutError
									? waitErr.message
									: waitErr instanceof Error
										? waitErr.message
										: t("pdfAsk.agentFailed");
							notifyError(msg);
							markTranslateFailure(rec.id, msg);
						} finally {
							cleanup();
						}
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						notifyError(message);
						markTranslateFailure(rec.id, message);
					}
				})();
				return;
			}

			void (async () => {
				try {
					const result = await runTranslate(
						{
							text: quote,
							context: { page: anchor.page, surface: "pdf-selection" },
						},
						{ providerId },
					);
					const latest =
						translatesRef.current.find((r) => r.id === rec.id) ?? rec;
					const next = {
						...latest,
						result: result.trim(),
						updatedAt: new Date().toISOString(),
						error: undefined,
					};
					upsertTranslate(next);
					void persistTranslate(next);
					translateStreamingRef.current = false;
					setTranslateStreaming(false);
					setTranslateError(null);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					markTranslateFailure(rec.id, message);
				}
			})();
		},
		[
			t,
			vaultPath,
			paperAbsPath,
			paperRelPath,
			stopTranslateSession,
			upsertTranslate,
			persistTranslate,
			markTranslateFailure,
			openCard,
			cardHoverSurfaceRef,
			translatesRef,
			activeSessionRef,
			translateStreamingRef,
		],
	);

	const explainSelection = useCallback(
		(anchor: PdfAskAnchor) => {
			const quote = anchor.quote?.trim();
			if (!quote) return;
			stopTranslateSession();
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const rec = createTranslateRecord({
				paperPath,
				page: anchor.page,
				rects: anchor.rects,
				quote,
				mode: "explain",
			});
			upsertTranslate(rec);
			cardHoverSurfaceRef.current = false;
			openCard({ kind: "translate", id: rec.id });
			translateStreamingRef.current = true;
			setTranslateStreaming(true);
			setTranslateError(null);

			const prompt = buildExplainPrompt({
				text: quote,
				paperRel: paperRelPath,
				page: anchor.page,
			});
			void (async () => {
				try {
					const registry = await listAgents().catch(() => null);
					const pdfAsk = resolveTranslateAgent(loadSettings().pdfAsk, registry);
					const translate = resolveTranslateAgent(
						loadSettings().translate,
						registry,
					);
					const resolved = pdfAsk.agentId ? pdfAsk : translate;
					if (!resolved.agentId) {
						const msg = t("selection.explainNoAgent");
						notifyError(msg);
						markTranslateFailure(rec.id, msg);
						return;
					}
					const waiter = await subscribeAgentRun({
						timeoutMs: DEFAULT_AGENT_RUN_TIMEOUT_MS,
						timeoutError: t("selection.agentTimeout"),
						onStream: (ev) => {
							if ((ev.kind ?? "message") === "thought") return;
							const latest =
								translatesRef.current.find((r) => r.id === rec.id) ?? rec;
							upsertTranslate({
								...latest,
								result: (latest.result ?? "") + ev.chunk,
								updatedAt: new Date().toISOString(),
								error: undefined,
							});
						},
					});
					const unsubs: UnlistenFn[] = [() => waiter.dispose()];
					translateUnsubsRef.current = unsubs;
					let sessionId: string | undefined;
					const cleanup = () => {
						waiter.dispose();
						if (translateUnsubsRef.current === unsubs)
							translateUnsubsRef.current = null;
						if (sessionId && translateSessionRef.current === sessionId)
							translateSessionRef.current = null;
						if (sessionId && activeSessionRef.current === sessionId)
							activeSessionRef.current = null;
						translateStreamingRef.current = false;
						setTranslateStreaming(false);
					};
					try {
						const accepted = await runOnceGtero({
							prompt,
							agentId: resolved.agentId,
							modelId: resolved.modelId,
							vaultPath: vaultPath ?? undefined,
							workflow: "free",
							autoApprove: true,
							hideFromChatHistory: true,
						});
						if (translateDisposedRef.current) {
							void cancelAgentRun(accepted.sessionId).catch(() => undefined);
							return;
						}
						sessionId = accepted.sessionId;
						translateSessionRef.current = sessionId;
						activeSessionRef.current = sessionId;
						const ev = await waiter.wait(sessionId);
						if (ev.providerSessionId && vaultPath) {
							void rememberGteroSession(vaultPath, ev.providerSessionId);
						}
						clearGteroRunAttempt(sessionId);
						const latest =
							translatesRef.current.find((r) => r.id === rec.id) ?? rec;
						const next = {
							...latest,
							result: (ev.content || latest.result || "").trim(),
							updatedAt: new Date().toISOString(),
							error: undefined,
						};
						upsertTranslate(next);
						void persistTranslate(next);
						setTranslateError(null);
					} catch (waitErr) {
						if (sessionId) {
							void cancelAgentRun(sessionId).catch(() => undefined);
						}
						if (
							translateDisposedRef.current ||
							waitErr instanceof AgentRunDisposedError ||
							isAgentRunAbortError(waitErr)
						)
							return;
						const message =
							waitErr instanceof AgentRunTimeoutError
								? waitErr.message
								: await gteroUserFacingError(
										waitErr,
										{
											sessionLost: t("selection.sessionLost"),
											sessionRetry: t("selection.sessionRetry"),
											fallback: t("pdfAsk.agentFailed"),
										},
										sessionId ? { localSessionId: sessionId } : undefined,
									);
						notifyError(message);
						markTranslateFailure(rec.id, message);
					} finally {
						cleanup();
					}
				} catch (e) {
					const message = await gteroUserFacingError(e, {
						sessionLost: t("selection.sessionLost"),
						sessionRetry: t("selection.sessionRetry"),
						fallback: t("pdfAsk.agentFailed"),
					});
					notifyError(message);
					markTranslateFailure(rec.id, message);
				}
			})();
		},
		[
			t,
			vaultPath,
			paperAbsPath,
			paperRelPath,
			stopTranslateSession,
			upsertTranslate,
			persistTranslate,
			markTranslateFailure,
			openCard,
			cardHoverSurfaceRef,
			translatesRef,
			activeSessionRef,
			translateStreamingRef,
		],
	);

	const writeSelectionNotes = useCallback(
		(anchor: PdfAskAnchor) => {
			const quote = anchor.quote?.trim();
			if (!quote) return;
			if (!paperAbsPath) {
				notifyError(t("selection.notesNoPaper"));
				return;
			}
			const notesPath = joinVaultPath(paperAbsPath, "NOTES.md");
			const streamingId =
				translateStreaming && activeCardRef.current?.kind === "translate"
					? activeCardRef.current.id
					: undefined;
			const insight = finishedInsightForSelection(translatesRef.current, {
				quote,
				page: anchor.page,
				excludeIds: streamingId ? [streamingId] : undefined,
			});
			void (async () => {
				try {
					let existing = "";
					try {
						existing = await readVaultFile(notesPath);
					} catch {
						existing = "";
					}
					const body = formatSelectionNoteBody({
						quote,
						page: anchor.page,
						insight,
					});
					await writeVaultFile(notesPath, appendNotesSection(existing, body));
					await applyDiskChange(notesPath);
					notifySuccess(t("selection.notesAppended"));
				} catch {
					notifyError(t("selection.notesFailed"));
				}
			})();
		},
		[paperAbsPath, translateStreaming, t, translatesRef, activeCardRef],
	);

	const deleteTranslateCard = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "translate"
				? activeCardRef.current.id
				: null;
		stopTranslateSession();
		if (id) {
			setTranslates((prev) => prev.filter((r) => r.id !== id));
			if (paperAbsPath) void deletePdfTranslate(paperAbsPath, id);
		}
		hideActiveCard();
	}, [
		paperAbsPath,
		stopTranslateSession,
		hideActiveCard,
		activeCardRef,
		setTranslates,
	]);

	return {
		translateStreaming,
		translateError,
		translateSelection,
		explainSelection,
		writeSelectionNotes,
		stopTranslateSession,
		deleteTranslateCard,
		openTranslateSettings,
		clearTranslateError,
	};
}
