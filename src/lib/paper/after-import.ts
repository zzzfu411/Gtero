/**
 * Unified post-import / post-download hook for auto paper-reader.
 *
 * Callers always invoke {@link afterPaperImport}; bulk (2+ papers in the
 * same user action) is skipped so a 10-paper paste cannot stampede Agent.
 * Fire-and-forget: never blocks the import UI.
 */

import { notifyError } from "@/lib/core/notify";
import { toVaultRelative } from "@/lib/core/path";
import { refreshLibrary } from "@/lib/paper/library-store";
import { notesPathForPaper } from "@/lib/paper/paths";
import {
	maybeAutoRunPaperReader,
	paperAssetsReadyForReader,
	shouldAutoRunAfterPaperImport,
} from "@/lib/paper/reader";
import { joinVaultPath, readVaultFile } from "@/lib/vault";
import { refreshTabNotes } from "@/lib/workspace/store";

export { AFTER_IMPORT_AUTO_READER_MAX } from "@/lib/paper/reader";

export type AfterPaperImportPaper = {
	/** Vault-relative paper folder, e.g. `papers/1706.03762`. */
	path?: string | null;
	/** Absolute paper directory (NOTES refresh + path fallback). */
	paperDir?: string | null;
	pdf?: boolean | null;
	tex?: boolean | null;
	paperMd?: boolean | null;
};

export type AfterPaperImportPlan =
	| { action: "skip"; reason: "empty" | "bulk" | "no-path" | "not-ready" }
	| { action: "read"; paperPath: string }
	| { action: "wait-download"; paperPath: string };

type PendingAutoRead = {
	vaultRoot: string;
	paperDir: string | null;
};

/** Single-import papers waiting for a JobCenter `downloadAssets` success. */
const pendingAutoRead = new Map<string, PendingAutoRead>();

export function normalizePaperRel(path: string | null | undefined): string {
	return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function resolvePaperRel(
	vaultRoot: string,
	paper: AfterPaperImportPaper,
): string {
	const fromPath = normalizePaperRel(paper.path);
	if (fromPath) return fromPath;
	const dir = (paper.paperDir ?? "").replace(/[\\/]+$/, "");
	if (!dir) return "";
	if (!vaultRoot) return normalizePaperRel(dir);
	return normalizePaperRel(toVaultRelative(vaultRoot, dir));
}

/**
 * Pure decision: skip bulk, read when assets are ready, otherwise wait for
 * the paper's download job (caller still enqueues that job).
 */
export function planAfterPaperImport(opts: {
	papers: AfterPaperImportPaper[];
	/** Total papers in this user action. Defaults to `papers.length`. */
	batchSize?: number;
	vaultRoot?: string;
	/**
	 * When assets are not ready, wait for a later `downloadAssets` job.
	 * Download-button callers already finished downloading — pass false.
	 */
	awaitDownload?: boolean;
}): AfterPaperImportPlan {
	const count = opts.batchSize ?? opts.papers.length;
	if (count <= 0 || opts.papers.length === 0) {
		return { action: "skip", reason: "empty" };
	}
	if (!shouldAutoRunAfterPaperImport(opts.papers.length, count)) {
		return { action: "skip", reason: "bulk" };
	}
	const paperPath = resolvePaperRel(opts.vaultRoot ?? "", opts.papers[0]);
	if (!paperPath) return { action: "skip", reason: "no-path" };
	if (paperAssetsReadyForReader(opts.papers[0])) {
		return { action: "read", paperPath };
	}
	if (opts.awaitDownload === false) {
		return { action: "skip", reason: "not-ready" };
	}
	return { action: "wait-download", paperPath };
}

function pendingKey(vaultRoot: string, paperRel: string): string {
	const vault = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	return `${vault}\0${paperRel}`;
}

function kickAutoReader(opts: {
	vaultRoot: string;
	paperPath: string;
	paperDir: string | null;
}): void {
	void maybeAutoRunPaperReader({
		vaultRoot: opts.vaultRoot,
		paperPath: opts.paperPath,
		assetsReady: true,
	})
		.then(async (started) => {
			if (!started) return;
			await refreshLibrary();
			if (!opts.paperDir) return;
			try {
				const content = await readVaultFile(notesPathForPaper(opts.paperDir));
				refreshTabNotes(opts.paperDir, content);
			} catch {
				// NOTES may not exist yet / tab not open
			}
		})
		.catch((e) => {
			notifyError(e instanceof Error ? e.message : String(e));
		});
}

/**
 * After a successful single-paper import or download.
 * Does not await the reader (progress lives in the task bar).
 */
export function afterPaperImport(opts: {
	vaultRoot: string;
	papers: AfterPaperImportPaper[];
	/** Total papers in this user action (e.g. magic-wand paste count). */
	batchSize?: number;
	/** @see planAfterPaperImport */
	awaitDownload?: boolean;
}): void {
	const plan = planAfterPaperImport({
		papers: opts.papers,
		batchSize: opts.batchSize,
		vaultRoot: opts.vaultRoot,
		awaitDownload: opts.awaitDownload,
	});
	if (plan.action === "skip") return;

	const paper = opts.papers[0];
	const paperDir =
		(paper.paperDir ?? "").replace(/[\\/]+$/, "") ||
		joinVaultPath(opts.vaultRoot, plan.paperPath);

	if (plan.action === "wait-download") {
		pendingAutoRead.set(pendingKey(opts.vaultRoot, plan.paperPath), {
			vaultRoot: opts.vaultRoot,
			paperDir,
		});
		return;
	}

	kickAutoReader({
		vaultRoot: opts.vaultRoot,
		paperPath: plan.paperPath,
		paperDir,
	});
}

/**
 * JobCenter `downloadAssets` terminal hook. Starts auto-reader only when
 * {@link afterPaperImport} registered this paper (single import waiting
 * for assets). Bulk Download jobs never register, so they cannot stampede.
 */
export function notifyPaperAssetsJobSettled(job: {
	kind: string;
	state: string;
	vaultPath: string;
	paperPath?: string | null;
}): void {
	if (job.kind !== "downloadAssets") return;
	const rel = normalizePaperRel(job.paperPath);
	if (!rel) return;
	const key = pendingKey(job.vaultPath, rel);
	const pending = pendingAutoRead.get(key);
	if (!pending) return;
	pendingAutoRead.delete(key);
	if (job.state !== "succeeded") return;
	kickAutoReader({
		vaultRoot: pending.vaultRoot,
		paperPath: rel,
		paperDir: pending.paperDir,
	});
}
