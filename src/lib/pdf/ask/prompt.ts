import type { PdfAskThread } from "@/lib/pdf/ask/types";

export type BuildPdfAskPromptOpts = {
	/**
	 * True when this run will `session/new` (sticky off, empty binder, or
	 * after a forgotten resume). False when the vault primary will be resumed.
	 */
	includeHistory: boolean;
};

/**
 * Build a single-turn prompt for ACP.
 *
 * Prior local turns belong in the prompt only when the Host will not resume
 * an existing session. On sticky resume they already live in session memory;
 * re-sending them grows context quadratically. The card transcript is always
 * persisted in `marks/` regardless of this flag.
 */
export function buildPdfAskPrompt(
	thread: PdfAskThread,
	latestUserQuestion: string,
	opts: BuildPdfAskPromptOpts,
): string {
	const quote = thread.anchor.quote?.trim();
	const page = thread.anchor.page;
	const parts = [
		"You are helping the user read a research paper PDF in Agentero.",
		`Page: ${page}`,
	];
	if (thread.anchor.visualKind === "formula") {
		parts.push(
			"The user attached a crop containing a formula or technical expression.",
			"Explain its purpose, define the notation, describe how the terms interact, and connect it to the surrounding paper. Do not invent missing context.",
		);
	} else if (thread.anchor.visualKind === "figure") {
		parts.push(
			"The user attached a crop containing a figure, chart, table, or other visual region.",
			"Explain the visual structure, axes or legend when present, the main comparison, and the conclusion supported by the crop. Do not invent unreadable values.",
		);
	}
	if (quote) {
		parts.push("Quoted text from the PDF:", `> ${quote}`);
	}
	if (opts.includeHistory) {
		const history = thread.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.slice(0, -1)
			.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
			.join("\n\n");
		if (history) {
			parts.push("Earlier turns in this selection thread:", history);
		}
	}
	const q = latestUserQuestion.trim();
	parts.push(
		"User question:",
		q || "(no text)",
		opts.includeHistory
			? "Answer based on the quote and prior turns when possible. Be concise. If uncertain, say so."
			: "This continues the current Gtero session. Answer this new question from the quote and session memory. Be concise. If uncertain, say so.",
	);
	return parts.join("\n\n");
}

export { buildTranslatePrompt } from "@/lib/translate/prompt";
