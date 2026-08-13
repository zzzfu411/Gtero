import { describe, expect, it } from "vitest";
import {
	buildCorpusSynthesisPrompt,
	buildExplainPrompt,
} from "@/lib/agent/gtero-prompts";
import { fillStickySessionId } from "@/lib/agent/gtero-run";
import {
	appendNotesSection,
	formatSelectionNoteBody,
	gteroNotesHeading,
} from "@/lib/agent/notes-patch";
import {
	compactFocus,
	focusEquals,
	formatFocusBlock,
	notesRelForPaper,
} from "@/lib/agent/paper-context";

describe("notes-patch", () => {
	it("creates a dated heading and does not overwrite prior notes", () => {
		const heading = gteroNotesHeading(new Date("2026-08-13T12:00:00Z"));
		expect(heading).toBe("## Gtero · 2026-08-13");
		const next = appendNotesSection(
			"# Decoding\n\nUser lecture notes.",
			"> quote",
			{
				heading,
			},
		);
		expect(next.startsWith("# Decoding")).toBe(true);
		expect(next).toContain("User lecture notes.");
		expect(next).toContain("## Gtero · 2026-08-13");
		expect(next).toContain("> quote");
	});

	it("formats a selection as a blockquote with page and insight", () => {
		const body = formatSelectionNoteBody({
			quote: "decoder-based heads",
			page: 3,
			insight: "A head that maps tokens to a scalar.",
		});
		expect(body).toContain("> decoder-based heads");
		expect(body).toContain("Source (p.3)");
		expect(body).toContain("A head that maps tokens to a scalar.");
		expect(body.indexOf("Source (p.3)")).toBeLessThan(
			body.indexOf("A head that maps tokens to a scalar."),
		);
	});

	it("keeps the page anchor when there is no insight", () => {
		const body = formatSelectionNoteBody({
			quote: "decoder-based heads",
			page: 3,
		});
		expect(body).toBe("> decoder-based heads\n\nSource (p.3)");
	});

	it("preserves wikilinks in quote and insight", () => {
		const body = formatSelectionNoteBody({
			quote: "see [[papers/x]]",
			page: 1,
			insight: "cf. [[notes/y]]",
		});
		expect(body).toContain("[[papers/x]]");
		expect(body).toContain("[[notes/y]]");
	});

	it("creates a section when the file is empty", () => {
		const heading = "## Gtero · 2026-08-13";
		const next = appendNotesSection("", "> quote", { heading });
		expect(next.startsWith(heading)).toBe(true);
		expect(next).toContain("> quote");
		expect(next.match(/## Gtero · 2026-08-13/g)?.length).toBe(1);
	});

	it("appends under an existing same-day Gtero heading", () => {
		const heading = "## Gtero · 2026-08-13";
		const existing = `# Decoding\n\n${heading}\n\n> first\n`;
		const next = appendNotesSection(existing, "> second", { heading });
		expect(next.match(/## Gtero · 2026-08-13/g)?.length).toBe(1);
		expect(next).toContain("> first");
		expect(next).toContain("> second");
		expect(next.indexOf("> first")).toBeLessThan(next.indexOf("> second"));
	});

	it("adds a new heading when the existing Gtero section is a different day", () => {
		const next = appendNotesSection(
			"# Decoding\n\n## Gtero · 2026-08-12\n\n> old\n",
			"> new",
			{ heading: "## Gtero · 2026-08-13" },
		);
		expect(next).toContain("## Gtero · 2026-08-12");
		expect(next).toContain("## Gtero · 2026-08-13");
		expect(next).toContain("> old");
		expect(next).toContain("> new");
	});

	it("does not treat insight ## headings as the next Gtero section", () => {
		const heading = "## Gtero · 2026-08-13";
		const existing = `${heading}\n\n> first\n\n## What this concept is\nA head.\n`;
		const next = appendNotesSection(existing, "> second", { heading });
		expect(next.match(/## Gtero · 2026-08-13/g)?.length).toBe(1);
		expect(next.indexOf("## What this concept is")).toBeGreaterThan(
			next.indexOf("> first"),
		);
		expect(next.indexOf("> second")).toBeGreaterThan(
			next.indexOf("## What this concept is"),
		);
	});
});

describe("paper-context", () => {
	it("omits an empty focus block and formats a compact delta", () => {
		expect(formatFocusBlock({})).toBe("");
		const block = formatFocusBlock({
			paperRel: "papers/LLMBBO/BBObasic/2501.19383",
			page: 3,
			selection: "decoder-based heads",
		});
		expect(block).toContain("[Gtero focus]");
		expect(block).toContain("page=3");
		expect(notesRelForPaper("papers/2501.19383")).toBe(
			"papers/2501.19383/NOTES.md",
		);
	});

	it("treats equivalent compacted focus as unchanged", () => {
		const a = compactFocus({ paperRel: "papers/x", page: 1 });
		expect(focusEquals(a, { paperRel: "papers/x", page: 1 })).toBe(true);
		expect(focusEquals(a, { paperRel: "papers/x", page: 2 })).toBe(false);
	});
});

describe("gtero-prompts", () => {
	it("keeps explain prompts snippet-sized", () => {
		const prompt = buildExplainPrompt({
			text: "decoder-based heads",
			page: 3,
			paperRel: "papers/2501.19383",
		});
		expect(prompt).toContain("decoder-based heads");
		expect(prompt).toContain("What this concept is");
		expect(prompt).toContain("Do not read the whole PDF unless");
	});

	it("asks corpus synthesis to search notes instead of stuffing PDFs", () => {
		const prompt = buildCorpusSynthesisPrompt("BBObasic");
		expect(prompt).toContain("NOTES.md");
		expect(prompt).toContain("Do not dump full PDFs");
	});
});

describe("fillStickySessionId", () => {
	it("does not invent a session id when the vault binder is empty", async () => {
		const filled = await fillStickySessionId({
			prompt: "hi",
			vaultPath: "D:/Research/AgenteroVault",
		});
		expect(filled.sessionId).toBeUndefined();
		expect(filled.prompt).toBe("hi");
	});

	it("strips sessionId when forking so ACP starts session/new", async () => {
		const filled = await fillStickySessionId({
			prompt: "hi",
			sessionId: "existing",
			fork: true,
		});
		expect(filled.sessionId).toBeUndefined();
		expect("fork" in filled).toBe(false);
	});

	it("keeps an explicit sessionId when not forking", async () => {
		const filled = await fillStickySessionId({
			prompt: "hi",
			sessionId: "existing",
		});
		expect(filled.sessionId).toBe("existing");
	});
});
