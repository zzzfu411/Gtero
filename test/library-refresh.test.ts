import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { PaperMetadata } from "@/lib/paper";
import { listPapers } from "@/lib/paper/api";
import {
	libraryStore,
	refreshLibrary,
	setLibraryPapers,
} from "@/lib/paper/library-store";
import { getVaultPath } from "@/lib/vault/store";

vi.mock("@/lib/paper/api", () => ({
	listPapers: vi.fn(),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: vi.fn(() => "/vault"),
}));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: vi.fn(() => true),
}));
vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
}));

function paper(path: string, title = path): PaperMetadata {
	return {
		id: path.split("/").pop() ?? path,
		path,
		type: "arxiv",
		title,
		authors: [],
		tags: [],
		status: "completed",
		added_at: "",
		updated_at: "",
	};
}

const previous = [paper("papers/1706.03762", "Attention")];

describe("refreshLibrary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getVaultPath).mockReturnValue("/vault");
		vi.mocked(isTauri).mockReturnValue(true);
		vi.mocked(listPapers).mockReset();
		libraryStore.setState({
			papers: [],
			loading: false,
			paperMetaByRelPath: new Map(),
		});
	});

	it("keeps previous rows and notifyError when paper_list fails", async () => {
		setLibraryPapers(previous);
		vi.mocked(listPapers).mockRejectedValue(new Error("catalog locked"));

		await refreshLibrary();

		expect(libraryStore.getState().papers).toEqual(previous);
		expect(libraryStore.getState().loading).toBe(false);
		expect(notifyError).toHaveBeenCalledWith(expect.any(String), {
			id: "library-refresh",
		});
		expect(vi.mocked(notifyError).mock.calls[0]?.[0]).not.toBe("");
	});

	it("clears rows when no vault is open", async () => {
		setLibraryPapers(previous);
		vi.mocked(getVaultPath).mockReturnValue(null);

		await refreshLibrary();

		expect(libraryStore.getState().papers).toEqual([]);
		expect(listPapers).not.toHaveBeenCalled();
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("clears rows when not running in Tauri", async () => {
		setLibraryPapers(previous);
		vi.mocked(isTauri).mockReturnValue(false);

		await refreshLibrary();

		expect(libraryStore.getState().papers).toEqual([]);
		expect(listPapers).not.toHaveBeenCalled();
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("replaces rows when paper_list succeeds", async () => {
		setLibraryPapers(previous);
		const next = [paper("papers/2010.11929", "ViT")];
		vi.mocked(listPapers).mockResolvedValue(next);

		await refreshLibrary();

		expect(listPapers).toHaveBeenCalledWith("/vault");
		expect(libraryStore.getState().papers).toEqual(next);
		expect(notifyError).not.toHaveBeenCalled();
	});
});
