export const TLH_STARTUP_TIPS = [
	"Use /review to open TLH’s interactive review picker for branch, commit, PR, or folder reviews.",
	"Run /annotate-git-diff for a native review window across branch, commit, or all-files scopes.",
	"Use /annotate-last-message to mark up the latest assistant reply before your next prompt.",
	"Run /context to inspect where your context window is going before a long follow-up.",
	"Use /usage to check TLH usage status or toggle the weekly usage window.",
	"Press Shift+Tab to switch to Rush for a small bounded task TLH can implement directly.",
	"Press Shift+Tab to switch to product for framing, tradeoffs, or implementation-ready ticket shaping.",
	"Press Shift+Tab to switch to bug-hunter for read-only debugging and root-cause analysis.",
	"Run /fork to branch from an earlier user message and explore an alternate path.",
	"Run /tree to rewind to previous messages.",
	"Use /name to give the current session a label you can spot later.",
	"Prefix a shell command with ! to send its output into the chat, or !! to run it without adding the output to the model context.",
	"Run /tlh-changelog to review what’s new in this TLH build.",
	"At any point, you can ask the oracle for a second opinion.",
] as const;

export function selectTlhStartupTip(random: () => number = Math.random): string | undefined {
	const tips: readonly string[] = TLH_STARTUP_TIPS;
	if (tips.length === 0) {
		return undefined;
	}

	const index = Math.min(tips.length - 1, Math.floor(random() * tips.length));
	return tips[index];
}

const processStartupTip = selectTlhStartupTip();

export function getTlhStartupTip(): string | undefined {
	return processStartupTip;
}
