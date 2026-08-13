import { handleGteroResumeFailure } from "@/lib/agent/gtero-run";
import type { GteroResumeCopy } from "@/lib/agent/vault-session";

export type { GteroResumeCopy };

/** Map a Gtero/ACP throw to a toast/card string. Forgets a rejected sticky id. */
export async function gteroUserFacingError(
	error: unknown,
	copy: GteroResumeCopy,
	ctx?: {
		localSessionId?: string;
		vaultPath?: string;
		attemptedSessionId?: string;
	},
): Promise<string> {
	return handleGteroResumeFailure({
		error: error ?? "",
		copy,
		...ctx,
	});
}
