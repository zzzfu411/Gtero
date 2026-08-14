import { describe, expect, it } from "vitest";

import { planAfterPaperImport } from "@/lib/paper/after-import";
import {
	AFTER_IMPORT_AUTO_READER_MAX,
	paperAssetsReadyForReader,
	shouldAutoRunAfterPaperImport,
} from "@/lib/paper/reader";

describe("shouldAutoRunAfterPaperImport", () => {
	it("allows a single magic-wand or local-PDF import", () => {
		expect(shouldAutoRunAfterPaperImport(1)).toBe(true);
		expect(shouldAutoRunAfterPaperImport(1, 1)).toBe(true);
	});

	it("blocks bulk wand paste even when each task imported one paper", () => {
		expect(shouldAutoRunAfterPaperImport(1, 12)).toBe(false);
	});

	it("blocks one input that expanded into many papers", () => {
		expect(shouldAutoRunAfterPaperImport(8, 1)).toBe(false);
	});

	it("blocks multi-PDF import", () => {
		expect(shouldAutoRunAfterPaperImport(0)).toBe(false);
		expect(shouldAutoRunAfterPaperImport(2)).toBe(false);
		expect(shouldAutoRunAfterPaperImport(24, 24)).toBe(false);
	});
});

describe("paperAssetsReadyForReader", () => {
	it("is ready when any of PDF / TeX / PAPER.md exists", () => {
		expect(paperAssetsReadyForReader({ pdf: true })).toBe(true);
		expect(paperAssetsReadyForReader({ tex: true })).toBe(true);
		expect(paperAssetsReadyForReader({ paperMd: true })).toBe(true);
	});

	it("is not ready when every flag is missing or false", () => {
		expect(paperAssetsReadyForReader({})).toBe(false);
		expect(
			paperAssetsReadyForReader({ pdf: false, tex: false, paperMd: false }),
		).toBe(false);
	});
});

describe("planAfterPaperImport", () => {
	const one = {
		path: "papers/1706.03762",
		paperDir: "/vault/papers/1706.03762",
		pdf: true,
	};

	it("reads a single paper when assets are ready", () => {
		expect(AFTER_IMPORT_AUTO_READER_MAX).toBe(1);
		expect(planAfterPaperImport({ papers: [one] })).toEqual({
			action: "read",
			paperPath: "papers/1706.03762",
		});
	});

	it("waits for download when the single paper has no local assets yet", () => {
		expect(
			planAfterPaperImport({
				papers: [{ path: "papers/1706.03762", pdf: false }],
			}),
		).toEqual({
			action: "wait-download",
			paperPath: "papers/1706.03762",
		});
	});

	it("skips a 10+ wand paste even if this task imported one paper", () => {
		expect(planAfterPaperImport({ papers: [one], batchSize: 12 })).toEqual({
			action: "skip",
			reason: "bulk",
		});
	});

	it("skips multi-PDF import", () => {
		expect(
			planAfterPaperImport({
				papers: [one, { ...one, path: "papers/1810.04805" }],
			}),
		).toEqual({ action: "skip", reason: "bulk" });
	});

	it("skips empty ingest", () => {
		expect(planAfterPaperImport({ papers: [] })).toEqual({
			action: "skip",
			reason: "empty",
		});
	});

	it("skips a finished Download that still has no readable assets", () => {
		expect(
			planAfterPaperImport({
				papers: [{ path: "papers/1706.03762", pdf: false }],
				awaitDownload: false,
			}),
		).toEqual({ action: "skip", reason: "not-ready" });
	});
});
