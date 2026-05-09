import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HARNESS_PROMPT = `
## The Last Harness Defaults

The Last Harness package is installed. Prefer safe, transparent, and reviewable changes:

- Explain high-impact actions before taking them.
- Use the narrowest tool or command that solves the task.
- Preserve user-owned configuration unless explicitly asked to change it.
- Make installer and setup changes idempotent whenever possible.
- Document how to undo any persistent change.
`;

export default function theLastHarness(pi: ExtensionAPI) {
	pi.registerCommand("harness", {
		description: "Show The Last Harness package status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("The Last Harness package is installed and active.", "info");
		},
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n${HARNESS_PROMPT}`,
	}));
}
