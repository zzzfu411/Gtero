import { isRecord, isRect } from "@/lib/pdf/marks/schema";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

/** Validate and normalize a translate JSON payload. Returns null if invalid. */
export function parsePdfTranslateRecord(
	raw: unknown,
): PdfTranslateRecord | null {
	if (!isRecord(raw)) return null;
	if (raw.version !== 1) return null;
	if (raw.kind !== "translate") return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.paperPath !== "string") return null;
	if (typeof raw.createdAt !== "string") return null;
	if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return null;
	if (!Array.isArray(raw.rects) || !raw.rects.every(isRect)) return null;

	const rec: PdfTranslateRecord = {
		version: 1,
		kind: "translate",
		id: raw.id,
		paperPath: raw.paperPath,
		createdAt: raw.createdAt,
		page: Math.max(1, Math.floor(raw.page)),
		rects: raw.rects as PdfTranslateRect[],
	};
	if (typeof raw.quote === "string") rec.quote = raw.quote;
	if (raw.mode === "explain" || raw.mode === "translate") rec.mode = raw.mode;
	if (typeof raw.updatedAt === "string") rec.updatedAt = raw.updatedAt;
	if (typeof raw.result === "string") rec.result = raw.result;
	if (typeof raw.error === "string") rec.error = raw.error;
	return rec;
}

function normalizedQuote(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * Finished explain/translate body for a PDF selection, if one exists.
 * Prefers explain over translate; then the most recently updated record.
 */
export function finishedInsightForSelection(
	records: PdfTranslateRecord[],
	opts: { quote: string; page: number; excludeIds?: Iterable<string> },
): string | null {
	const quote = normalizedQuote(opts.quote);
	if (!quote) return null;
	const page = Math.floor(opts.page);
	const excluded = new Set(opts.excludeIds ?? []);
	const matches = records.filter((r) => {
		if (excluded.has(r.id)) return false;
		if (r.error?.trim()) return false;
		if (!r.result?.trim()) return false;
		if (Math.floor(r.page) !== page) return false;
		return normalizedQuote(r.quote ?? "") === quote;
	});
	if (!matches.length) return null;
	const explain = matches.filter((r) => r.mode === "explain");
	const pool = explain.length ? explain : matches;
	pool.sort((a, b) =>
		(b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
	);
	return pool[0]?.result?.trim() ?? null;
}
