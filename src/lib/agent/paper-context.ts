/** Serializable paper focus injected into Gtero turns. */

export type PaperFocus = {
	paperRel?: string;
	title?: string;
	page?: number;
	selection?: string;
	notesRel?: string;
};

const MAX_SELECTION = 800;

export function compactFocus(focus: PaperFocus): PaperFocus {
	const next: PaperFocus = {};
	const paperRel = focus.paperRel?.trim().replace(/\\/g, "/");
	if (paperRel) next.paperRel = paperRel;
	const title = focus.title?.trim();
	if (title) next.title = title;
	if (
		typeof focus.page === "number" &&
		Number.isFinite(focus.page) &&
		focus.page > 0
	) {
		next.page = Math.floor(focus.page);
	}
	const selection = focus.selection?.trim();
	if (selection) {
		next.selection =
			selection.length > MAX_SELECTION
				? `${selection.slice(0, MAX_SELECTION)}…`
				: selection;
	}
	const notesRel = focus.notesRel?.trim().replace(/\\/g, "/");
	if (notesRel) next.notesRel = notesRel;
	return next;
}

export function focusEquals(
	a: PaperFocus | null | undefined,
	b: PaperFocus,
): boolean {
	const left = compactFocus(a ?? {});
	const right = compactFocus(b);
	return (
		left.paperRel === right.paperRel &&
		left.title === right.title &&
		left.page === right.page &&
		left.selection === right.selection &&
		left.notesRel === right.notesRel
	);
}

/** One-line delta for the agent prompt. Empty when there is nothing to say. */
export function formatFocusBlock(focus: PaperFocus): string {
	const compact = compactFocus(focus);
	if (!compact.paperRel && !compact.selection && !compact.title) return "";
	const parts: string[] = ["[Gtero focus]"];
	if (compact.paperRel) parts.push(`paper=\`${compact.paperRel}\``);
	if (compact.title) parts.push(`title=${JSON.stringify(compact.title)}`);
	if (compact.page) parts.push(`page=${compact.page}`);
	if (compact.notesRel) parts.push(`notes=\`${compact.notesRel}\``);
	if (compact.selection) {
		parts.push(`selection=${JSON.stringify(compact.selection)}`);
	}
	return parts.join(" ");
}

export function notesRelForPaper(paperRel: string): string {
	const rel = paperRel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return rel ? `${rel}/NOTES.md` : "NOTES.md";
}
