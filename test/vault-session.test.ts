import { describe, expect, it, vi } from "vitest";
import {
	emptyGteroBinder,
	forgetProviderSession,
	parseGteroBinder,
	rememberGteroSession,
	rememberProviderSession,
} from "@/lib/agent/vault-session";
import { loadSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

vi.mock("@/lib/settings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/settings")>();
	return {
		...actual,
		loadSettings: vi.fn(() => ({
			...DEFAULT_SETTINGS,
			gtero: { enabled: true, sticky: true },
		})),
	};
});

describe("parseGteroBinder", () => {
	it("accepts a valid binder", () => {
		const parsed = parseGteroBinder({
			schema: 1,
			provider: "grok-build",
			primarySessionId: "abc-1",
			title: "Gtero · vault thread",
			createdAt: "2026-08-12T00:00:00.000Z",
			lastResumedAt: null,
			forks: [
				{
					id: "fork-1",
					title: "compare",
					createdAt: "2026-08-12T01:00:00.000Z",
				},
			],
		});
		expect(parsed?.primarySessionId).toBe("abc-1");
		expect(parsed?.forks).toHaveLength(1);
	});

	it("rejects the wrong schema or provider", () => {
		expect(
			parseGteroBinder({
				schema: 2,
				provider: "grok-build",
				primarySessionId: "x",
				title: "t",
				createdAt: "t",
				forks: [],
			}),
		).toBeNull();
		expect(
			parseGteroBinder({
				schema: 1,
				provider: "claude",
				primarySessionId: "x",
				title: "t",
				createdAt: "t",
				forks: [],
			}),
		).toBeNull();
	});
});

describe("rememberProviderSession", () => {
	it("promotes the first session to primary", () => {
		const next = rememberProviderSession(emptyGteroBinder("t0"), "sid-1", {
			now: "t1",
		});
		expect(next.primarySessionId).toBe("sid-1");
		expect(next.forks).toEqual([]);
		expect(next.lastResumedAt).toBe("t1");
	});

	it("records an explicit fork without replacing primary", () => {
		const base = rememberProviderSession(emptyGteroBinder("t0"), "sid-1", {
			now: "t1",
		});
		const forked = rememberProviderSession(base, "sid-2", {
			fork: true,
			title: "OmniPred vs Decoding",
			now: "t2",
		});
		expect(forked.primarySessionId).toBe("sid-1");
		expect(forked.forks).toEqual([
			{ id: "sid-2", title: "OmniPred vs Decoding", createdAt: "t2" },
		]);
	});

	it("does not duplicate fork ids", () => {
		const base = rememberProviderSession(emptyGteroBinder("t0"), "sid-1", {
			now: "t1",
		});
		const once = rememberProviderSession(base, "sid-2", {
			fork: true,
			now: "t2",
		});
		const twice = rememberProviderSession(once, "sid-2", {
			fork: true,
			now: "t3",
		});
		expect(twice.forks).toHaveLength(1);
	});
});

describe("forgetProviderSession", () => {
	it("clears primary when that session vanished", () => {
		const base = rememberProviderSession(emptyGteroBinder("t0"), "sid-1");
		const next = forgetProviderSession(base, "sid-1");
		expect(next.primarySessionId).toBeNull();
	});

	it("clears a vanished fork without dropping primary", () => {
		const base = rememberProviderSession(emptyGteroBinder("t0"), "sid-1", {
			now: "t1",
		});
		const forked = rememberProviderSession(base, "sid-2", {
			fork: true,
			now: "t2",
		});
		const next = forgetProviderSession(forked, "sid-2");
		expect(next.primarySessionId).toBe("sid-1");
		expect(next.forks).toEqual([]);
	});

	it("ignores an id that is not in the binder", () => {
		const base = rememberProviderSession(emptyGteroBinder("t0"), "sid-1");
		const next = forgetProviderSession(base, "missing");
		expect(next.primarySessionId).toBe("sid-1");
		expect(next.forks).toEqual([]);
	});
});

describe("rememberGteroSession sticky gate", () => {
	it("does not promote a session when sticky is off", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			...DEFAULT_SETTINGS,
			gtero: { enabled: true, sticky: false },
		});
		const next = await rememberGteroSession("D:/vault", "sid-new");
		expect(next.primarySessionId).toBeNull();
	});

	it("does not promote a session when Gtero is disabled", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			...DEFAULT_SETTINGS,
			gtero: { enabled: false, sticky: true },
		});
		const next = await rememberGteroSession("D:/vault", "sid-new");
		expect(next.primarySessionId).toBeNull();
	});

	it("records the session when sticky is on", async () => {
		vi.mocked(loadSettings).mockReturnValue({
			...DEFAULT_SETTINGS,
			gtero: { enabled: true, sticky: true },
		});
		const next = await rememberGteroSession("D:/vault", "sid-new");
		expect(next.primarySessionId).toBe("sid-new");
	});
});
