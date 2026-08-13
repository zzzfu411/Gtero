import { describe, expect, it } from "vitest";
import {
	handleGteroResumeFailure,
	selectStickySessionId,
	withGteroLane,
} from "@/lib/agent/gtero-run";
import {
	classifyGteroResumeError,
	formatGteroResumeError,
	GTERO_RESUME_REJECTED_PREFIX,
	type GteroResumeFailureKind,
} from "@/lib/agent/vault-session";

const copy = {
	sessionLost: "SESSION_LOST",
	sessionRetry: "SESSION_RETRY",
	fallback: "FALLBACK",
};

describe("selectStickySessionId", () => {
	it("resumes the primary when sticky and no explicit id is set", () => {
		expect(
			selectStickySessionId({
				sticky: true,
				primarySessionId: "primary-1",
			}),
		).toBe("primary-1");
	});

	it("omits the id when forking even if primary and explicit ids exist", () => {
		expect(
			selectStickySessionId({
				sticky: true,
				fork: true,
				sessionId: "existing",
				primarySessionId: "primary-1",
			}),
		).toBeUndefined();
	});

	it("keeps an explicit id when not forking", () => {
		expect(
			selectStickySessionId({
				sticky: true,
				sessionId: "fork-tab",
				primarySessionId: "primary-1",
			}),
		).toBe("fork-tab");
	});

	it("does not fill a primary id when sticky is off", () => {
		expect(
			selectStickySessionId({
				sticky: false,
				primarySessionId: "primary-1",
			}),
		).toBeUndefined();
	});

	it("does not invent an id when the binder has no primary", () => {
		expect(
			selectStickySessionId({
				sticky: true,
				primarySessionId: "  ",
			}),
		).toBeUndefined();
	});
});

describe("classifyGteroResumeError", () => {
	const table: Array<{
		name: string;
		error: string;
		kind: GteroResumeFailureKind;
		forget: boolean;
	}> = [
		{
			name: "Host permanent prefix",
			error: `${GTERO_RESUME_REJECTED_PREFIX}resume_session: unknown session`,
			kind: "rejected",
			forget: true,
		},
		{
			name: "Host prefix with invalid_params detail",
			error: `${GTERO_RESUME_REJECTED_PREFIX}resume_session: invalid_params`,
			kind: "rejected",
			forget: true,
		},
		{
			name: "15s Host timeout",
			error: 'Internal error: "resume_session timed out after 15s"',
			kind: "transient",
			forget: false,
		},
		{
			name: "transport never received",
			error: "resume_session: response to `session/resume` never received",
			kind: "transient",
			forget: false,
		},
		{
			name: "method_not_found",
			error: "resume_session: method_not_found",
			kind: "transient",
			forget: false,
		},
		{
			name: "request_cancelled",
			error: "resume_session: request_cancelled",
			kind: "transient",
			forget: false,
		},
		{
			name: "auth_required",
			error: "resume_session: auth_required",
			kind: "transient",
			forget: false,
		},
		{
			name: "parse_error",
			error: "resume_session: parse_error",
			kind: "transient",
			forget: false,
		},
		{
			name: "third-party unknown session",
			error: "unknown session",
			kind: "rejected",
			forget: true,
		},
		{
			name: "third-party session not found",
			error: "session not found",
			kind: "rejected",
			forget: true,
		},
		{
			name: "third-party invalid session",
			error: "invalid session identifier",
			kind: "rejected",
			forget: true,
		},
		{
			name: "bare resume_session is not enough",
			error: "resume_session failed",
			kind: "transient",
			forget: false,
		},
		{
			name: "unrelated error",
			error: "network timeout",
			kind: "other",
			forget: false,
		},
	];

	it.each(table)("$name → $kind (forget=$forget)", ({
		error,
		kind,
		forget,
	}) => {
		const classified = classifyGteroResumeError(error);
		expect(classified.kind).toBe(kind);
		expect(classified.kind === "rejected").toBe(forget);
		expect(classified.detail).not.toContain(GTERO_RESUME_REJECTED_PREFIX);
		const display = formatGteroResumeError(classified, copy);
		expect(display).not.toContain(GTERO_RESUME_REJECTED_PREFIX);
		if (kind === "rejected") expect(display).toBe(copy.sessionLost);
		if (kind === "transient") expect(display).toBe(copy.sessionRetry);
	});
});

describe("handleGteroResumeFailure", () => {
	it("returns session-lost copy without leaking the Host prefix", async () => {
		const display = await handleGteroResumeFailure({
			error: `${GTERO_RESUME_REJECTED_PREFIX}resume_session: gone`,
			vaultPath: "D:/vault",
			attemptedSessionId: "stale-1",
			copy,
		});
		expect(display).toBe("SESSION_LOST");
		expect(display).not.toContain(GTERO_RESUME_REJECTED_PREFIX);
	});

	it("returns retry copy for a 15s timeout", async () => {
		const display = await handleGteroResumeFailure({
			error: 'Internal error: "resume_session timed out after 15s"',
			vaultPath: "D:/vault",
			attemptedSessionId: "keep-1",
			copy,
		});
		expect(display).toBe("SESSION_RETRY");
	});
});

describe("withGteroLane", () => {
	it("serializes overlapping turns even when the first throws", async () => {
		const order: string[] = [];
		const first = withGteroLane(async () => {
			order.push("a-start");
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("a-throw");
			throw new Error("boom");
		});
		const second = withGteroLane(async () => {
			order.push("b");
			return 1;
		});
		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toBe(1);
		expect(order).toEqual(["a-start", "a-throw", "b"]);
	});
});
