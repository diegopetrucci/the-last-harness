import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("native completion notification renderer", () => {
	it("renders structured and legacy single notices result-first while retaining references when expanded", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { MAX_COMPLETION_MESSAGE_CHARS } from "./src/runs/background/notify.ts";
			import { setKeybindings } from "@earendil-works/pi-tui";
			import { KeybindingsManager } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
			setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+o" }));
			const events = { on() { return () => {}; }, emit() {} };
			let notifyRenderer;
			const fakePi = new Proxy({
				events,
				on() {},
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer(type, renderer) {
					if (type === "subagent-notify") notifyRenderer = renderer;
				},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!notifyRenderer) throw new Error("notification renderer was not registered");

			const theme = {
				fg(_name, text) { return text; },
				bg(_name, text) { return text; },
				bold(text) { return text; },
			};
			const content = "Background task completed: **worker**\n\n"
				+ "Async id: notify-render-1\n"
				+ 'Revive: subagent({ action: "resume", id: "notify-render-1", message: "..." })\n\n'
				+ "Done";
			const cases = [
				{
					name: "structured",
					message: {
						content,
						details: { agent: "worker", status: "completed", resultPreview: "Done", asyncId: "notify-render-1" },
					},
				},
				{ name: "legacy", message: { content } },
			];
			for (const testCase of cases) {
				const collapsed = notifyRenderer(testCase.message, { expanded: false }, theme).render(200).join("\n");
				const expanded = notifyRenderer(testCase.message, { expanded: true }, theme).render(200).join("\n");
				const collapsedPreview = collapsed.split("⎿  ")[1]?.split("\n", 1)[0] ?? "";
				if (!collapsedPreview.includes("Done")) throw new Error(testCase.name + " collapsed preview was not result-first: " + collapsed);
				if (collapsedPreview.includes("Async id")) throw new Error(testCase.name + " collapsed preview exposed async metadata: " + collapsed);
				if (!collapsed.includes("full notification")) throw new Error(testCase.name + " did not show the hidden-reference expand hint: " + collapsed);
				if (!/ctrl\+o full notification/i.test(collapsed)) throw new Error(testCase.name + " stopped using Pi's stock Ctrl+O notification expansion: " + collapsed);
				if (collapsed.includes("Ctrl+Shift+D full notification")) throw new Error(testCase.name + " incorrectly used subagent live detail for a completed notification: " + collapsed);
				if (!expanded.includes("Async id: notify-render-1")) throw new Error(testCase.name + " expanded output lost async id: " + expanded);
				if (!expanded.includes("Revive: subagent(")) throw new Error(testCase.name + " expanded output lost revive guidance: " + expanded);
			}

			const oversizedFormatted = "Background task completed: **oversized-worker**\n\n"
				+ "Async id: notify-render-oversized\n"
				+ 'Revive: subagent({ action: "resume", id: "notify-render-oversized", message: "..." })\n\n'
				+ "content-derived-result-" + "x".repeat(MAX_COMPLETION_MESSAGE_CHARS);
			const completionMarker = "\n… [completion message truncated]";
			const oversizedContent = oversizedFormatted.slice(0, MAX_COMPLETION_MESSAGE_CHARS - completionMarker.length) + completionMarker;
			const oversizedMessage = {
				content: oversizedContent,
				details: {
					agent: "oversized-worker",
					status: "completed",
					resultPreview: "structured-fallback-" + "y".repeat(1_100) + "… [summary truncated]",
					durationMs: 1_250,
					asyncId: "notify-render-oversized",
					resumeTarget: { sessionPath: "/tmp/structured-session.jsonl" },
					sessionLabel: "Session file",
					sessionValue: "/tmp/structured-session.jsonl-" + "z".repeat(2_000) + "unbounded-fallback-tail",
				},
			};
			const oversizedExpanded = notifyRenderer(oversizedMessage, { expanded: true }, theme).render(200).join("\n");
			if (!oversizedExpanded.includes("content-derived-result-")) throw new Error("oversized rendering ignored capped content: " + oversizedExpanded);
			if (!oversizedExpanded.includes("completion message truncated")) throw new Error("oversized rendering lost the content cap marker");
			if (oversizedExpanded.includes("structured-fallback-")) throw new Error("oversized rendering used the structured fallback instead of content");
			if (!oversizedExpanded.includes("1.3s")) throw new Error("oversized rendering lost structured duration metadata: " + oversizedExpanded);
			if (!oversizedExpanded.includes("structured-session.jsonl")) throw new Error("oversized rendering lost structured session metadata: " + oversizedExpanded);
			if (!oversizedExpanded.includes("reference truncated")) throw new Error("oversized rendering did not bound the structured session fallback");
			if (oversizedExpanded.includes("unbounded-fallback-tail")) throw new Error("oversized rendering exposed the structured session tail");
			if (oversizedExpanded.length > 10_000) throw new Error("oversized rendering exceeded the persisted notification bound: " + oversizedExpanded.length);
			if (!oversizedExpanded.includes("Async id: notify-render-oversized")) throw new Error("oversized rendering lost expanded async id");
			if (!oversizedExpanded.includes("Revive: subagent(")) throw new Error("oversized rendering lost expanded revive guidance");

			const shareErrorValue = "share failed: " + "private-detail-".repeat(200) + "unbounded-share-tail";
			const referenceMarker = "… [reference truncated]";
			const boundedShareError = shareErrorValue.slice(0, 500 - referenceMarker.length) + referenceMarker;
			const shareErrorContent = "Background task failed: **share-worker**\n\n"
				+ "Done with a share failure\n\nSession share error: " + boundedShareError;
			const shareErrorMessage = {
				content: shareErrorContent,
				details: {
					agent: "share-worker",
					status: "failed",
					resultPreview: "structured result",
					durationMs: 2_500,
					sessionLabel: "Session share error",
					sessionValue: "wrong-structured-value-" + "q".repeat(2_000),
				},
			};
			const shareErrorExpanded = notifyRenderer(shareErrorMessage, { expanded: true }, theme).render(200).join("\n");
			if (!shareErrorExpanded.includes("Done with a share failure")) throw new Error("share error rendering lost capped content result");
			if (!shareErrorExpanded.includes("session share error: share failed:")) throw new Error("share error rendering lost its normal label");
			if (!shareErrorExpanded.includes("reference truncated")) throw new Error("share error rendering lost the reference cap marker");
			if (shareErrorExpanded.includes("wrong-structured-value")) throw new Error("share error rendering did not prefer parsed capped session metadata");
			if (shareErrorExpanded.includes("unbounded-share-tail")) throw new Error("share error rendering exposed the oversized tail");
			if (!shareErrorExpanded.includes("2.5s")) throw new Error("share error rendering lost structured duration metadata");
			if (shareErrorExpanded.length > 2_000) throw new Error("share error expanded rendering was not bounded: " + shareErrorExpanded.length);
		`;
		const env = { ...process.env };
		delete env[SUBAGENT_CHILD_ENV];
		delete env[SUBAGENT_FANOUT_CHILD_ENV];
		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env, stdio: "pipe" },
		);
	});
});
