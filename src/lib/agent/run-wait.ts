/**
 * Subscribe to agent:* events before starting a fire-and-forget `runOnce`.
 * Host `agent_run_once` returns as soon as the run is accepted; a fast
 * `agent:failed` can land before the caller would otherwise attach listeners.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type AgentFailedEvent,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentStreamEvent,
	type AgentToolEvent,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentPlan,
	listenAgentStream,
	listenAgentTool,
} from "@/lib/agent/api";

/** Hard cap so a missed terminal event cannot hang PDF fast-lanes. */
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Paper-reader turns can run much longer than a PDF card. */
export const PAPER_READER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export class AgentRunTimeoutError extends Error {
	override readonly name = "AgentRunTimeoutError";
	constructor(message = "Agent run timed out") {
		super(message);
	}
}

export class AgentRunDisposedError extends Error {
	override readonly name = "AgentRunDisposedError";
	constructor() {
		super("Agent run subscription disposed");
	}
}

export function isAgentRunAbortError(error: unknown): boolean {
	return (
		(typeof DOMException !== "undefined" &&
			error instanceof DOMException &&
			error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function abortError(): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException("Aborted", "AbortError");
	}
	const err = new Error("Aborted");
	err.name = "AbortError";
	return err;
}

export type AgentRunListen<T> = (
	handler: (event: T) => void,
) => Promise<UnlistenFn>;

/** Injected in unit tests; production uses the Tauri `listenAgent*` helpers. */
export type AgentRunListeners = {
	listenCompleted: AgentRunListen<AgentResultPayload>;
	listenFailed: AgentRunListen<AgentFailedEvent>;
	listenStream?: AgentRunListen<AgentStreamEvent>;
	listenPlan?: AgentRunListen<AgentPlanEvent>;
	listenTool?: AgentRunListen<AgentToolEvent>;
};

export type SubscribeAgentRunOptions = {
	timeoutMs?: number;
	timeoutError?: string;
	listeners?: Partial<AgentRunListeners>;
	onStream?: (event: AgentStreamEvent) => void;
	onPlan?: (event: AgentPlanEvent) => void;
	onTool?: (event: AgentToolEvent) => void;
};

type Terminal =
	| { kind: "completed"; event: AgentResultPayload }
	| { kind: "failed"; error: string };

export type AgentRunSubscription = {
	/** Bind the accepted session and wait for completed / failed / timeout. */
	wait(
		sessionId: string,
		waitOpts?: { signal?: AbortSignal },
	): Promise<AgentResultPayload>;
	dispose(): void;
};

function pushBuffered<T>(
	bucket: Map<string, T[]>,
	sessionId: string,
	event: T,
) {
	const list = bucket.get(sessionId);
	if (list) list.push(event);
	else bucket.set(sessionId, [event]);
}

export async function subscribeAgentRun(
	opts: SubscribeAgentRunOptions = {},
): Promise<AgentRunSubscription> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
	const listenCompleted =
		opts.listeners?.listenCompleted ?? listenAgentCompleted;
	const listenFailed = opts.listeners?.listenFailed ?? listenAgentFailed;
	const listenStream =
		opts.listeners?.listenStream ??
		(opts.onStream ? listenAgentStream : undefined);
	const listenPlan =
		opts.listeners?.listenPlan ?? (opts.onPlan ? listenAgentPlan : undefined);
	const listenTool =
		opts.listeners?.listenTool ?? (opts.onTool ? listenAgentTool : undefined);

	let sessionId: string | null = null;
	let settled = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let abortUnsub: (() => void) | undefined;
	const unsubs: UnlistenFn[] = [];
	const terminals = new Map<string, Terminal>();
	const streams = new Map<string, AgentStreamEvent[]>();
	const plans = new Map<string, AgentPlanEvent[]>();
	const tools = new Map<string, AgentToolEvent[]>();
	let resolveWait: ((value: AgentResultPayload) => void) | null = null;
	let rejectWait: ((error: Error) => void) | null = null;

	const unlisten = () => {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
		abortUnsub?.();
		abortUnsub = undefined;
		for (const u of unsubs) {
			try {
				u();
			} catch {
				// ignore
			}
		}
		unsubs.length = 0;
		terminals.clear();
		streams.clear();
		plans.clear();
		tools.clear();
	};

	const finishOk = (event: AgentResultPayload) => {
		if (settled) return;
		settled = true;
		unlisten();
		resolveWait?.(event);
	};

	const finishErr = (error: Error) => {
		if (settled) return;
		settled = true;
		unlisten();
		rejectWait?.(error);
	};

	const replayProgress = (sid: string) => {
		for (const ev of streams.get(sid) ?? []) opts.onStream?.(ev);
		for (const ev of plans.get(sid) ?? []) opts.onPlan?.(ev);
		for (const ev of tools.get(sid) ?? []) opts.onTool?.(ev);
	};

	const bind = (sid: string) => {
		sessionId = sid;
		replayProgress(sid);
		const terminal = terminals.get(sid);
		if (timeoutMs > 0 && !terminal) {
			timeoutId = setTimeout(() => {
				finishErr(
					new AgentRunTimeoutError(opts.timeoutError ?? "Agent run timed out"),
				);
			}, timeoutMs);
		}
		if (!terminal) return;
		if (terminal.kind === "completed") finishOk(terminal.event);
		else finishErr(new Error(terminal.error));
	};

	unsubs.push(
		await listenCompleted((ev) => {
			if (sessionId) {
				if (ev.sessionId !== sessionId) return;
				finishOk(ev);
				return;
			}
			if (!terminals.has(ev.sessionId)) {
				terminals.set(ev.sessionId, { kind: "completed", event: ev });
			}
		}),
	);
	unsubs.push(
		await listenFailed((ev) => {
			if (sessionId) {
				if (ev.sessionId !== sessionId) return;
				finishErr(new Error(ev.error));
				return;
			}
			if (!terminals.has(ev.sessionId)) {
				terminals.set(ev.sessionId, { kind: "failed", error: ev.error });
			}
		}),
	);
	if (listenStream && opts.onStream) {
		unsubs.push(
			await listenStream((ev) => {
				if (sessionId) {
					if (ev.sessionId !== sessionId) return;
					opts.onStream?.(ev);
					return;
				}
				pushBuffered(streams, ev.sessionId, ev);
			}),
		);
	}
	if (listenPlan && opts.onPlan) {
		unsubs.push(
			await listenPlan((ev) => {
				if (sessionId) {
					if (ev.sessionId !== sessionId) return;
					opts.onPlan?.(ev);
					return;
				}
				pushBuffered(plans, ev.sessionId, ev);
			}),
		);
	}
	if (listenTool && opts.onTool) {
		unsubs.push(
			await listenTool((ev) => {
				if (sessionId) {
					if (ev.sessionId !== sessionId) return;
					opts.onTool?.(ev);
					return;
				}
				pushBuffered(tools, ev.sessionId, ev);
			}),
		);
	}

	return {
		wait(sid: string, waitOpts?: { signal?: AbortSignal }) {
			return new Promise<AgentResultPayload>((resolve, reject) => {
				if (settled) {
					reject(new AgentRunDisposedError());
					return;
				}
				resolveWait = resolve;
				rejectWait = reject;
				if (waitOpts?.signal?.aborted) {
					finishErr(abortError());
					return;
				}
				const onAbort = () => finishErr(abortError());
				waitOpts?.signal?.addEventListener("abort", onAbort, { once: true });
				abortUnsub = () =>
					waitOpts?.signal?.removeEventListener("abort", onAbort);
				bind(sid);
			});
		},
		dispose() {
			if (settled) {
				unlisten();
				return;
			}
			finishErr(new AgentRunDisposedError());
		},
	};
}
