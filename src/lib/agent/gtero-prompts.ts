/**
 * Prompt templates for Gtero fast/deep lanes.
 * Keep these short: selection explain must not dump the whole PDF.
 */

export function buildExplainPrompt(opts: {
	text: string;
	paperTitle?: string | null;
	paperRel?: string | null;
	page?: number | null;
}): string {
	const text = opts.text.trim();
	const where: string[] = [];
	if (opts.paperTitle?.trim()) where.push(`Paper: ${opts.paperTitle.trim()}`);
	if (opts.paperRel?.trim()) where.push(`Folder: \`${opts.paperRel.trim()}\``);
	if (opts.page && opts.page > 0) where.push(`Page ${opts.page}`);
	const loc = where.length ? `${where.join(" · ")}\n` : "";
	return [
		"Explain the selected passage for a researcher who is reading this paper.",
		loc.trim(),
		"Selected text:",
		`"""${text}"""`,
		"",
		"Reply in this structure, concise, no preamble:",
		"1. Translation (into the user's response language if set, else follow the selection).",
		"2. What this concept is (2–4 sentences).",
		"3. Why it appears here.",
		"4. Easy-to-confuse nearby ideas.",
		"5. Related terms (plain text; use [[wikilinks]] only if you already know the Vault path).",
		"Do not read the whole PDF unless this snippet is unintelligible without one nearby sentence.",
	].join("\n");
}

export function buildCorpusSynthesisPrompt(scopeHint?: string): string {
	const scope =
		scopeHint?.trim() ||
		"papers I have already read (catalog is_read / existing NOTES.md)";
	return [
		`Synthesize ${scope}.`,
		"Do not dump full PDFs into context.",
		"Search the vault catalog and read NOTES.md / PAPER.md of 5–15 relevant papers first.",
		"Output: theme map, method comparison, overlaps, gaps, and what to read next.",
		"Cite Vault-relative paths. Keep [[wikilinks]].",
		"Write the report to `notes/` as a new Markdown file named with today's date, and also reply here.",
	].join("\n");
}
