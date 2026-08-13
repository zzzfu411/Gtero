/**
 * Append-only NOTES.md patches. Never replace the whole file.
 */

const DEFAULT_HEADING_PREFIX = "## Gtero · ";

export function gteroNotesHeading(now = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${DEFAULT_HEADING_PREFIX}${y}-${m}-${d}`;
}

function lastExactLineIndex(text: string, line: string): number {
	let last = -1;
	let from = 0;
	while (from <= text.length) {
		const i = text.indexOf(line, from);
		if (i < 0) break;
		const beforeOk = i === 0 || text[i - 1] === "\n";
		const afterIdx = i + line.length;
		const afterOk = afterIdx === text.length || text[afterIdx] === "\n";
		if (beforeOk && afterOk) last = i;
		from = i + 1;
	}
	return last;
}

export function appendNotesSection(
	existing: string,
	body: string,
	opts?: { heading?: string; now?: Date },
): string {
	const heading = opts?.heading?.trim() || gteroNotesHeading(opts?.now);
	const snippet = body.trim();
	const section = `${heading}\n\n${snippet}\n`;
	const prev = existing.replace(/\s+$/, "");
	if (!prev) return `${section}\n`;

	const headingAt = lastExactLineIndex(prev, heading);
	if (headingAt < 0) {
		return `${prev}\n\n${section}\n`;
	}

	const afterHeading = headingAt + heading.length;
	const rest = prev.slice(afterHeading);
	// Only Gtero dated headings are section boundaries. Insight bodies may
	// contain `## ` lines (explain structure) that must not split the section.
	const nextHeading = rest.search(/\n## Gtero · /);
	if (nextHeading < 0) {
		return `${prev}\n\n${snippet}\n`;
	}
	const insertAt = afterHeading + nextHeading;
	const left = prev.slice(0, insertAt).replace(/\s+$/, "");
	const right = prev.slice(insertAt).replace(/^\n+/, "");
	return `${left}\n\n${snippet}\n\n${right}\n`;
}

export function formatSelectionNoteBody(opts: {
	quote: string;
	page?: number | null;
	insight?: string | null;
}): string {
	const page =
		opts.page && opts.page > 0 ? ` (p.${Math.floor(opts.page)})` : "";
	const quote = opts.quote.trim();
	const quoted = quote
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const source = page ? `\n\nSource${page}` : "";
	const insight = opts.insight?.trim();
	if (!insight) return `${quoted}${source}`;
	return `${quoted}${source}\n\n${insight}`;
}
