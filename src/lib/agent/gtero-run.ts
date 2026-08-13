/**
 * Sticky Gtero ACP runs: resume the vault primary session unless the caller
 * already passed a session id or requested a fork.
 */

import type { RunOnceAccepted } from "@/lib/agent/api";
import { runOnce } from "@/lib/agent/api";
import {
	classifyGteroResumeError,
	forgetGteroSession,
	formatGteroResumeError,
	type GteroResumeCopy,
	isGteroSticky,
	loadGteroBinder,
} from "@/lib/agent/vault-session";

type RunOnceArgs = Parameters<typeof runOnce>[0];

export type GteroRunOnceRequest = RunOnceArgs & {
	/** Force session/new and record the result as a fork. */
	fork?: boolean;
};

type GteroAttempt = {
	vaultPath: string;
	attemptedSessionId: string;
};

/** Local run id → provider session id actually sent to session/resume. */
const attemptsByLocalId = new Map<string, GteroAttempt>();

export function registerGteroRunAttempt(
	localSessionId: string,
	attempt: GteroAttempt,
): void {
	const local = localSessionId.trim();
	if (!local) return;
	attemptsByLocalId.set(local, attempt);
}

export function clearGteroRunAttempt(localSessionId: string): void {
	attemptsByLocalId.delete(localSessionId.trim());
}

function takeGteroRunAttempt(
	localSessionId?: string,
): GteroAttempt | undefined {
	const local = localSessionId?.trim();
	if (!local) return undefined;
	const attempt = attemptsByLocalId.get(local);
	if (attempt) attemptsByLocalId.delete(local);
	return attempt;
}

let lane: Promise<void> = Promise.resolve();

export async function withGteroLane<T>(fn: () => Promise<T>): Promise<T> {
	const previous = lane;
	let release: () => void = () => undefined;
	lane = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await fn();
	} finally {
		release();
	}
}

/** Pure resume/fork id selection. `fork` always starts session/new. */
export function selectStickySessionId(opts: {
	sticky: boolean;
	fork?: boolean;
	sessionId?: string | null;
	primarySessionId?: string | null;
}): string | undefined {
	if (opts.fork) return undefined;
	const explicit = opts.sessionId?.trim();
	if (explicit) return explicit;
	if (!opts.sticky) return undefined;
	const primary = opts.primarySessionId?.trim();
	return primary || undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a sticky-resume failure, forget the attempted id when the rejection
 * is permanent, and return user-facing copy. Call this from every failure
 * surface (`agent:failed`, `runOnce` reject, paper-reader).
 */
export async function handleGteroResumeFailure(opts: {
	error: unknown;
	copy: GteroResumeCopy;
	/** Local ACP run id from `runOnce` / `agent:failed`. */
	localSessionId?: string;
	vaultPath?: string;
	/** Provider session id actually passed to session/resume. */
	attemptedSessionId?: string;
}): Promise<string> {
	const fromMap = takeGteroRunAttempt(opts.localSessionId);
	const vaultPath = opts.vaultPath?.trim() || fromMap?.vaultPath;
	const attemptedSessionId =
		opts.attemptedSessionId?.trim() || fromMap?.attemptedSessionId;
	const classified = classifyGteroResumeError(errorMessage(opts.error));
	if (classified.kind === "rejected" && vaultPath && attemptedSessionId) {
		try {
			await forgetGteroSession(vaultPath, attemptedSessionId);
		} catch {
			// Binder IO must not hide the user-facing error.
		}
	}
	return formatGteroResumeError(classified, opts.copy);
}

export async function fillStickySessionId(
	request: GteroRunOnceRequest,
): Promise<RunOnceArgs> {
	const { fork, ...rest } = request;
	if (fork) {
		return { ...rest, sessionId: undefined };
	}
	if (rest.sessionId?.trim() || !isGteroSticky()) return rest;
	const vaultPath = rest.vaultPath?.trim();
	if (!vaultPath) return rest;
	const binder = await loadGteroBinder(vaultPath);
	const sessionId = selectStickySessionId({
		sticky: true,
		sessionId: rest.sessionId,
		primarySessionId: binder.primarySessionId,
	});
	return sessionId ? { ...rest, sessionId } : rest;
}

export async function runOnceGtero(
	request: GteroRunOnceRequest,
): Promise<RunOnceAccepted> {
	return withGteroLane(async () => {
		const filled = await fillStickySessionId(request);
		const vaultPath = filled.vaultPath?.trim();
		const attemptedSessionId = filled.sessionId?.trim();
		try {
			const accepted = await runOnce(filled);
			if (vaultPath && attemptedSessionId) {
				registerGteroRunAttempt(accepted.sessionId, {
					vaultPath,
					attemptedSessionId,
				});
			}
			return accepted;
		} catch (error) {
			await handleGteroResumeFailure({
				error,
				vaultPath,
				attemptedSessionId,
				copy: {
					sessionLost: errorMessage(error),
					sessionRetry: errorMessage(error),
					fallback: errorMessage(error),
				},
			});
			throw error;
		}
	});
}
