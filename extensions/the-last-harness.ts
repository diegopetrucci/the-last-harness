import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTlhAutocompleteProvider } from "./the-last-harness/autocomplete.js";
import { registerEffortCommand } from "./the-last-harness/effort.js";
import { createTlhFooter } from "./the-last-harness/footer.js";
import { registerGnosisCommand } from "./the-last-harness/gnosis.js";
import { createTlhHeader } from "./the-last-harness/header.js";
import { scheduleTlhLaunchTelemetry } from "./the-last-harness/launch-telemetry.js";
import { registerTlhPrimaryAgentRuntime } from "./the-last-harness/primary-agent-runtime.js";
import { collectStartupResources } from "./the-last-harness/resources.js";
import { getTlhHeaderUpdate, maybeNotifyAvailableTlhUpdate } from "./the-last-harness/update-check.js";
import type { StartupResources } from "./the-last-harness/types.js";

export default function theLastHarness(pi: ExtensionAPI) {
	const primaryAgentRuntime = registerTlhPrimaryAgentRuntime(pi, { env: process.env });
	if (!primaryAgentRuntime) {
		return;
	}

	registerGnosisCommand(pi);
	registerEffortCommand(pi);

	pi.on("session_start", async (event, ctx) => {
		await primaryAgentRuntime.applySessionStart(ctx);

		if (!ctx.hasUI) {
			return;
		}

		if (event.reason === "startup") {
			scheduleTlhLaunchTelemetry(ctx);
		}

		ctx.ui.addAutocompleteProvider(createTlhAutocompleteProvider);

		let resources: StartupResources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };
		try {
			resources = await collectStartupResources(ctx.cwd);
		} catch {
			// Keep startup resilient. The header can still render without resource details.
		}

		const headerUpdate = getTlhHeaderUpdate();

		if (typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((_tui, theme, footerData) =>
				createTlhFooter(pi, ctx, theme, () => primaryAgentRuntime.currentPrimaryAgentLabel(), footerData),
			);
		}
		if (typeof ctx.ui.setHeader === "function") {
			ctx.ui.setHeader((_tui, theme) => createTlhHeader(theme, resources, headerUpdate));
		}

		void maybeNotifyAvailableTlhUpdate(ctx).catch(() => undefined);
	});
}
