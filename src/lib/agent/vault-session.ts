/**
 * Gtero vault binder: one durable Grok/ACP session per vault.
 * File: `{vault}/.agentero/grok-workspace.json`
 *
 * Pure parse/update helpers are testable without Tauri. Disk IO uses vault FS.
 */
import { isTauri } from "@/lib/core/tauri";
import { loadSettings } from "@/lib/settings";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";

export const GTERO_BINDER_SCHEMA = 1;
export const GTERO_BINDER_REL = ".agentero/grok-workspace.json";

export type GteroFork = {
	id: string;
	title: string;
	createdAt: string;
};

export type GteroBinder = {
	schema: typeof GTERO_BINDER_SCHEMA;
	provider: "grok-build";
	primarySessionId: string | null;
	title: string;
	createdAt: string;
	lastResumedAt: string | null;
	forks: GteroFork[];
};

export function emptyGteroBinder(now = new Date().toISOString()): GteroBinder {
	return {
		schema: GTERO_BINDER_SCHEMA,
		provider: "grok-build",
		primarySessionId: null,
		title: "Gtero · vault thread",
		createdAt: now,
		lastResumedAt: null,
		forks: [],
	};
}

export function gteroBinderPath(vaultPath: string): string {
	return joinVaultPath(
		joinVaultPath(vaultPath, ".agentero"),
		"grok-workspace.json",
	);
}

export function isGteroEnabled(): boolean {
	return loadSettings().gtero.enabled;
}

export function isGteroSticky(): boolean {
	const gtero = loadSettings().gtero;
	return gtero.enabled && gtero.sticky;
}

export function parseGteroBinder(raw: unknown): GteroBinder | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (o.schema !== GTERO_BINDER_SCHEMA) return null;
	if (o.provider !== "grok-build") return null;
	const primary =
		o.primarySessionId === null
			? null
			: typeof o.primarySessionId === "string" && o.primarySessionId.trim()
				? o.primarySessionId.trim()
				: null;
	if (typeof o.title !== "string") return null;
	if (typeof o.createdAt !== "string") return null;
	const lastResumedAt =
		o.lastResumedAt === null || o.lastResumedAt === undefined
			? null
			: typeof o.lastResumedAt === "string"
				? o.lastResumedAt
				: null;
	const forks = Array.isArray(o.forks)
		? o.forks
				.map((item): GteroFork | null => {
					if (!item || typeof item !== "object") return null;
					const f = item as Record<string, unknown>;
					if (typeof f.id !== "string" || !f.id.trim()) return null;
					return {
						id: f.id.trim(),
						title: typeof f.title === "string" ? f.title : f.id.slice(0, 8),
						createdAt:
							typeof f.createdAt === "string"
								? f.createdAt
								: new Date().toISOString(),
					};
				})
				.filter((item): item is GteroFork => item !== null)
		: [];
	return {
		schema: GTERO_BINDER_SCHEMA,
		provider: "grok-build",
		primarySessionId: primary,
		title: o.title,
		createdAt: o.createdAt,
		lastResumedAt,
		forks,
	};
}

export function rememberProviderSession(
	binder: GteroBinder,
	providerSessionId: string,
	opts?: { fork?: boolean; title?: string; now?: string },
): GteroBinder {
	const id = providerSessionId.trim();
	if (!id) return binder;
	const now = opts?.now ?? new Date().toISOString();
	const next: GteroBinder = {
		...binder,
		lastResumedAt: now,
		forks: binder.forks.slice(),
	};
	if (!next.primarySessionId) {
		next.primarySessionId = id;
		return next;
	}
	if (opts?.fork && id !== next.primarySessionId) {
		if (!next.forks.some((f) => f.id === id)) {
			next.forks.push({
				id,
				title: opts.title?.trim() || id.slice(0, 8),
				createdAt: now,
			});
		}
	}
	return next;
}

/** Drop a vanished ACP session so the next turn can create a new primary. */
export function forgetProviderSession(
	binder: GteroBinder,
	sessionId: string,
): GteroBinder {
	const id = sessionId.trim();
	if (!id) return binder;
	const next: GteroBinder = {
		...binder,
		forks: binder.forks.filter((f) => f.id !== id),
	};
	if (next.primarySessionId === id) {
		next.primarySessionId = null;
	}
	return next;
}

/** Host `GTERO_RESUME_REJECTED_PREFIX` — Display / `agent:failed.error` start with this. */
export const GTERO_RESUME_REJECTED_PREFIX = "gtero_resume_rejected: ";

export type GteroResumeFailureKind = "rejected" | "transient" | "other";

export type GteroResumeClassification = {
	kind: GteroResumeFailureKind;
	/** Prefix-stripped detail. Never contains the machine token. */
	detail: string;
};

export type GteroResumeCopy = {
	sessionLost: string;
	sessionRetry: string;
	fallback: string;
};

function peelAcpDisplay(error: string): string {
	const trimmed = error.trim();
	const wrapped = /^Internal error:\s*"(.*)"\s*$/s.exec(trimmed);
	return wrapped?.[1] ?? trimmed;
}

function stripRejectedPrefix(text: string): string {
	return text.startsWith(GTERO_RESUME_REJECTED_PREFIX)
		? text.slice(GTERO_RESUME_REJECTED_PREFIX.length).trim()
		: text;
}

function hasTransientMarker(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("timed out after") ||
		lower.includes("never received") ||
		lower.includes("method_not_found") ||
		lower.includes("method not found") ||
		lower.includes("request_cancelled") ||
		lower.includes("auth_required") ||
		lower.includes("parse_error") ||
		lower.includes("cancelled") ||
		lower.includes("aborted")
	);
}

function looksLikeResume(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("resume_session") ||
		lower.includes("session/resume") ||
		lower.includes("resume session")
	);
}

function looksLikeUnknownSession(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("unknown session") ||
		lower.includes("session not found") ||
		lower.includes("no such session") ||
		lower.includes("invalid session") ||
		lower.includes("invalid_session")
	);
}

/**
 * Single classifier for sticky `session/resume` failures.
 * See docs/frontend/gtero.md and docs/backend/agent.md.
 */
export function classifyGteroResumeError(
	error: string,
): GteroResumeClassification {
	const raw = error.trim();
	const peeled = peelAcpDisplay(raw);
	if (
		raw.startsWith(GTERO_RESUME_REJECTED_PREFIX) ||
		peeled.startsWith(GTERO_RESUME_REJECTED_PREFIX)
	) {
		const sourced = peeled.startsWith(GTERO_RESUME_REJECTED_PREFIX)
			? peeled
			: raw;
		return { kind: "rejected", detail: stripRejectedPrefix(sourced) };
	}
	if (hasTransientMarker(peeled) && looksLikeResume(peeled)) {
		return { kind: "transient", detail: peeled };
	}
	if (looksLikeUnknownSession(peeled) && !hasTransientMarker(peeled)) {
		return { kind: "rejected", detail: peeled };
	}
	if (looksLikeResume(peeled)) {
		return { kind: "transient", detail: peeled };
	}
	return { kind: "other", detail: peeled };
}

/** Map a classification to UI copy. Never leaks the Host prefix token. */
export function formatGteroResumeError(
	classified: GteroResumeClassification,
	copy: GteroResumeCopy,
): string {
	if (classified.kind === "rejected") return copy.sessionLost;
	if (classified.kind === "transient") return copy.sessionRetry;
	const detail = stripRejectedPrefix(classified.detail).trim();
	return detail || copy.fallback;
}

export async function loadGteroBinder(vaultPath: string): Promise<GteroBinder> {
	if (!vaultPath || !isTauri()) return emptyGteroBinder();
	try {
		const raw = await readVaultFile(gteroBinderPath(vaultPath));
		const parsed = parseGteroBinder(JSON.parse(raw) as unknown);
		return parsed ?? emptyGteroBinder();
	} catch {
		return emptyGteroBinder();
	}
}

export async function saveGteroBinder(
	vaultPath: string,
	binder: GteroBinder,
): Promise<void> {
	if (!vaultPath || !isTauri()) return;
	await writeVaultFile(
		gteroBinderPath(vaultPath),
		`${JSON.stringify(binder, null, 2)}\n`,
	);
}

export async function rememberGteroSession(
	vaultPath: string,
	providerSessionId: string,
	opts?: { fork?: boolean; title?: string },
): Promise<GteroBinder> {
	if (!isGteroSticky()) {
		return loadGteroBinder(vaultPath);
	}
	const current = await loadGteroBinder(vaultPath);
	const next = rememberProviderSession(current, providerSessionId, opts);
	if (JSON.stringify(current) !== JSON.stringify(next)) {
		await saveGteroBinder(vaultPath, next);
	}
	return next;
}

export async function forgetGteroSession(
	vaultPath: string,
	sessionId: string,
): Promise<GteroBinder> {
	const current = await loadGteroBinder(vaultPath);
	const next = forgetProviderSession(current, sessionId);
	if (JSON.stringify(current) !== JSON.stringify(next)) {
		await saveGteroBinder(vaultPath, next);
	}
	return next;
}
