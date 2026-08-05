import type { ChildProcessCleanupResult } from "../../shared/types.ts";

interface LifecyclePrivacyInput {
	state?: string;
	pause?: { kind?: string };
}

export function isProtectedPausedLifecycle(input: LifecyclePrivacyInput | null | undefined): boolean {
	if (!input) return false;
	if (input.state === "pausing") return true;
	return input.state !== "running" && input.pause?.kind === "awaiting_supervisor";
}

export function protectedLifecycleText(label: "error" | "diagnosis" | "nested_warning"): string {
	switch (label) {
		case "error": return "Lifecycle status requires attention.";
		case "nested_warning": return "Nested status unavailable during the paused lifecycle.";
		case "diagnosis":
		default: return "Lifecycle state was refreshed for this paused run.";
	}
}

export function formatProtectedLifecycleCleanup(cleanup: ChildProcessCleanupResult): string {
	if (cleanup.terminated) return "confirmed.";
	if (cleanup.attempted || cleanup.escalatedToSigkill || cleanup.liveProcessesDetected !== undefined) return "unconfirmed.";
	return "pending confirmation.";
}
