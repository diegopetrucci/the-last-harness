export const TLH_STARTUP_TIPS = [
    "Use /review to open TLH’s interactive review picker for branch, commit, PR, or folder reviews.",
    "Run /annotate-git-diff for a native review window across branch, commit, or all-files scopes.",
    "Use /annotate-last-message to mark up the latest assistant reply before your next prompt.",
    "Run /transcribe once to choose a local model, then press Ctrl+Alt+Z to start and stop microphone dictation.",
    "Run /context to inspect where your context window is going before a long follow-up.",
    "Use /usage to check TLH usage status or toggle the weekly usage window.",
    "Press Shift+Tab to switch to Rush for a small bounded task TLH can implement directly.",
    "Press Shift+Tab to switch to product for framing, tradeoffs, or implementation-ready ticket shaping.",
    "Press Shift+Tab to switch to bug-hunter for read-only debugging and root-cause analysis.",
    "Use “disabled” mode (Shift+Tab) to keep TLH’s tools and subagents without architect-specific guidance.",
    "Project custom subagents live in .tlh/agents; ask TLH to use one by name.",
    "Pin model or effort defaults per role for a project using .tlh/defaults.json at the repository root.",
    "Run /fork to branch from an earlier user message and explore an alternate path.",
    "Run /tree to rewind to previous messages.",
    "Use /name to give the current session a label you can spot later.",
    "Prefix a shell command with ! to send its output into the chat, or !! to run it without adding the output to the model context.",
    "Run /tlh-changelog to review what’s new in this TLH build.",
    "Run `tlh doctor` in your terminal to check if your tlh installation is healthy",
    "Run /analyse-tlh-sessions to review recent tlh sessions for recurring issues (note: it's an expensive check!)",
    "At any point, you can ask the oracle for a second opinion.",
    "Run `/tokens` to know what's eating up your subscription limit.",
    "Ask the contrarian to stress-test a plan or decision by steelmanning the strongest opposing case.",
    "TLH can search the web, just ask it to.",
    "With `/experimental enable ci-failure-investigation` TLH auto-investigates failed CI checks, so you don't have to.",
    "After opening a PR, TLH automatically monitors CI and reports failures.",
    "Ask for a diagram or visual explanation and TLH will sketch logic, flows, or UI structure (show-me skill).",
];
export function selectTlhStartupTip(random = Math.random) {
    const tips = TLH_STARTUP_TIPS;
    if (tips.length === 0) {
        return undefined;
    }
    const index = Math.min(tips.length - 1, Math.floor(random() * tips.length));
    return tips[index];
}
const processStartupTip = selectTlhStartupTip();
export function getTlhStartupTip() {
    return processStartupTip;
}
