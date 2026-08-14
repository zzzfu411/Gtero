import { describe, expect, it } from "vitest";
import type {
	AgentFailedEvent,
	AgentResultPayload,
	AgentStreamEvent,
} from "@/lib/agent/api";
import {
	AgentRunDisposedError,
	AgentRunTimeoutError,
	isAgentRunAbortError,
	subscribeAgentRun,
} from "@/lib/agent/run-wait";

function completed(sessionId: string, content = "ok"): AgentResultPayload {
	return {
		sessionId,
		messageId: "m1",
		content,
		sources: [],
	};
}

function failed(sessionId: string, error: string): AgentFailedEvent {
	return { sessionId, error };
}

function stream(sessionId: string, chunk: string): AgentStreamEvent {
	return { sessionId, chunk };
}

function deferredListeners() {
	let onCompleted: ((ev: AgentResultPayload) => void) | undefined;
	let onFailed: ((ev: AgentFailedEvent) => void) | undefined;
	let onStream: ((ev: AgentStreamEvent) => void) | undefined;
	return {
		emitCompleted: (ev: AgentResultPayload) => onCompleted?.(ev),
		emitFailed: (ev: AgentFailedEvent) => onFailed?.(ev),
		emitStream: (ev: AgentStreamEvent) => onStream?.(ev),
		listeners: {
			listenCompleted: async (handler: (ev: AgentResultPayload) => void) => {
				onCompleted = handler;
				return () => {
					onCompleted = undefined;
				};
			},
			listenFailed: async (handler: (ev: AgentFailedEvent) => void) => {
				onFailed = handler;
				return () => {
					onFailed = undefined;
				};
			},
			listenStream: async (handler: (ev: AgentStreamEvent) => void) => {
				onStream = handler;
				return () => {
					onStream = undefined;
				};
			},
		},
	};
}

describe("subscribeAgentRun", () => {
	it("resolves a completed event that arrived before wait()", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({ listeners: bus.listeners });
		bus.emitCompleted(completed("s1", "done"));
		await expect(sub.wait("s1")).resolves.toMatchObject({
			sessionId: "s1",
			content: "done",
		});
	});

	it("rejects a failed event that arrived before wait()", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({ listeners: bus.listeners });
		bus.emitFailed(failed("s1", "boom"));
		await expect(sub.wait("s1")).rejects.toThrow("boom");
	});

	it("ignores terminal events for other sessions", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({
			timeoutMs: 30,
			timeoutError: "TIMEOUT",
			listeners: bus.listeners,
		});
		const pending = sub.wait("mine");
		bus.emitFailed(failed("other", "nope"));
		bus.emitCompleted(completed("other", "nope"));
		bus.emitCompleted(completed("mine", "yes"));
		await expect(pending).resolves.toMatchObject({ content: "yes" });
	});

	it("replays buffered stream chunks after wait()", async () => {
		const bus = deferredListeners();
		const chunks: string[] = [];
		const sub = await subscribeAgentRun({
			listeners: bus.listeners,
			onStream: (ev) => {
				chunks.push(ev.chunk);
			},
		});
		bus.emitStream(stream("s1", "hel"));
		bus.emitStream(stream("other", "xxx"));
		bus.emitStream(stream("s1", "lo"));
		const pending = sub.wait("s1");
		bus.emitStream(stream("s1", "!"));
		bus.emitCompleted(completed("s1"));
		await pending;
		expect(chunks).toEqual(["hel", "lo", "!"]);
	});

	it("times out when no terminal event arrives", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({
			timeoutMs: 20,
			timeoutError: "TIMEOUT",
			listeners: bus.listeners,
		});
		await expect(sub.wait("s1")).rejects.toSatisfy(
			(err: unknown) =>
				err instanceof AgentRunTimeoutError && err.message === "TIMEOUT",
		);
	});

	it("keeps the first terminal event for a session", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({ listeners: bus.listeners });
		bus.emitCompleted(completed("s1", "first"));
		bus.emitFailed(failed("s1", "later"));
		await expect(sub.wait("s1")).resolves.toMatchObject({ content: "first" });
	});

	it("rejects with AbortError when the wait signal aborts", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({ listeners: bus.listeners });
		const ac = new AbortController();
		const pending = sub.wait("s1", { signal: ac.signal });
		ac.abort();
		await expect(pending).rejects.toSatisfy(isAgentRunAbortError);
	});

	it("dispose rejects a pending wait without a user-facing timeout", async () => {
		const bus = deferredListeners();
		const sub = await subscribeAgentRun({ listeners: bus.listeners });
		const pending = sub.wait("s1");
		sub.dispose();
		await expect(pending).rejects.toBeInstanceOf(AgentRunDisposedError);
	});
});
