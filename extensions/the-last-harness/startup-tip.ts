export const TLH_STARTUP_TIPS = [
	"Use /review to open TLH’s interactive review picker for branch, commit, PR, or folder reviews.",
	"Run /annotate-git-diff for a native review window across branch, commit, or all-files scopes.",
	"Use /annotate-last-message to mark up the latest assistant reply before your next prompt.",
	"Run /context to inspect where your context window is going before a long follow-up.",
	"Use /usage to check TLH usage status or toggle the weekly usage window.",
	"Use /switch-primary-agent to pick architect, rush, product, bug-hunter, or disabled for this session.",
	"Press Shift+Tab to cycle TLH primary agents without leaving the keyboard.",
	"Press Ctrl+Shift+E to show or hide skills, prompts, extensions, and themes in the TLH header.",
	"Run /fork to branch from an earlier user message and explore an alternate path.",
	"Run /tree to navigate the session tree and jump between branches.",
	"Use /name to give the current session a label you can spot later.",
	"Use /reload to pick up new keybindings, extensions, skills, prompts, and themes.",
	"Prefix a shell command with ! to send its output into the chat, or !! to run it without adding the output to the model context.",
	"Run /tlh-changelog to review what’s new in this TLH build.",
	"At any point, you can ask the oracle for a second opinion.",
] as const;

export function selectTlhStartupTip(random: () => number = Math.random): string | undefined {
	if (TLH_STARTUP_TIPS.length === 0) {
		return undefined;
	}

	const index = Math.min(TLH_STARTUP_TIPS.length - 1, Math.floor(random() * TLH_STARTUP_TIPS.length));
	return TLH_STARTUP_TIPS[index];
}

const processStartupTip = selectTlhStartupTip();

export function getTlhStartupTip(): string | undefined {
	return processStartupTip;
}
