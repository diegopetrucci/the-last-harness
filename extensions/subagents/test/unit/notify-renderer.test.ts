import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("native completion notification renderer", () => {
  it("renders structured and legacy single notices result-first while retaining references when expanded", () => {
    const script = String.raw`
			import { createRequire } from "node:module";
			import { pathToFileURL } from "node:url";
			import registerSubagentExtension from "./src/extension/index.ts";
			import { MAX_COMPLETION_MESSAGE_CHARS } from "./src/runs/background/notify.ts";
			const piCodingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
			const piCodingAgentRequire = createRequire(piCodingAgentEntry);
			const piTuiEntry = piCodingAgentRequire.resolve("@earendil-works/pi-tui");
			const { setKeybindings } = await import(pathToFileURL(piTuiEntry).href);
			const { KeybindingsManager } = await import(new URL("./core/keybindings.js", piCodingAgentEntry).href);
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
			// The render-time display bound caps the preview so the "completion message truncated"
			// marker (which is deep in the content string) does NOT appear in the TUI output.
			// The model-facing content still carries it; the TUI shows a compact bounded preview.
			if (oversizedExpanded.includes("completion message truncated")) throw new Error("oversized rendering exposed the message-cap marker — display should be bounded at render time");
			// Render-time bounding applies: a preview longer than MAX_DISPLAY_SUMMARY_CHARS is
			// replaced with a compact truncated version ending with the display-bound marker.
			if (!oversizedExpanded.includes("preview truncated")) throw new Error("oversized rendering did not apply the render-time display bound: " + oversizedExpanded);
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

  it("renders wrapped control notices with a connected top border", () => {
    const script = String.raw`
			import { createRequire } from "node:module";
			import { pathToFileURL } from "node:url";
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CONTROL_MESSAGE_TYPE } from "./src/extension/control-notices.ts";
			const piCodingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
			const piCodingAgentRequire = createRequire(piCodingAgentEntry);
			const piTuiEntry = piCodingAgentRequire.resolve("@earendil-works/pi-tui");
			const { visibleWidth } = await import(pathToFileURL(piTuiEntry).href);
			const events = { on() { return () => {}; }, emit() {} };
			let controlRenderer;
			const fakePi = new Proxy({
				events,
				on() {},
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer(type, renderer) {
					if (type === SUBAGENT_CONTROL_MESSAGE_TYPE) controlRenderer = renderer;
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
			if (!controlRenderer) throw new Error("control renderer was not registered");

			const theme = {
				fg(_name, text) { return text; },
				bg(_name, text) { return text; },
				bold(text) { return text; },
			};
			const width = 38;
			const agent = "worker-with-a-long-renderer-name";
			const lines = controlRenderer({
				content: "worker needs attention",
				details: {
					source: "foreground",
					event: {
						type: "needs_attention",
						to: "needs_attention",
						ts: 1,
						runId: "run-control",
						agent,
						index: 0,
						message: "worker needs attention",
						reason: "idle",
					},
				},
			}, { expanded: false }, theme).render(width);

			if (lines.length < 4) throw new Error("expected a wrapped control notice: " + lines.join("\\n"));
			if (!lines.every((line) => visibleWidth(line) === width)) {
				throw new Error("every physical line must fit and pad to width " + width + ": " + lines.join("\\n"));
			}
			if (!/^╭.*─+╮$/.test(lines[0])) {
				throw new Error("top header must connect to ╮ with dashes: " + lines[0]);
			}
			const middle = lines.slice(1, -1);
			if (!middle.every((line) => /^│.*│$/.test(line) && !line.includes("─"))) {
				throw new Error("continuation and body rows must use space padding: " + middle.join("\\n"));
			}
			if (!middle.some((line) => / +│$/.test(line))) {
				throw new Error("expected visible space padding before a continuation/body border");
			}
			if (!lines.join("").replace(/\\s/g, "").includes(agent.replace(/\\s/g, ""))) {
				throw new Error("wrapped header lost the agent name: " + lines.join("\\n"));
			}
		`;
    const env = { ...process.env };
    delete env[SUBAGENT_CHILD_ENV];
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

  it("bounds the display of grouped notices and any other unparsed content at the render-time display cap", () => {
    // Defect 3: the renderer parser only matches the singular-completion header regex.
    // Grouped notices use 'Background tasks completed (N):' which does not match, so
    // the renderer falls through to new Text(content). Before the fix, the full 32 000-char
    // content was displayed. After the fix, the fallback bounds to MAX_DISPLAY_SUMMARY_CHARS.
    const script = String.raw`
			import { createRequire } from "node:module";
			import { pathToFileURL } from "node:url";
			import registerSubagentExtension from "./src/extension/index.ts";
			import { MAX_COMPLETION_MESSAGE_CHARS, MAX_DISPLAY_SUMMARY_CHARS } from "./src/runs/background/notify.ts";
			const piCodingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
			const piCodingAgentRequire = createRequire(piCodingAgentEntry);
			const piTuiEntry = piCodingAgentRequire.resolve("@earendil-works/pi-tui");
			const { setKeybindings } = await import(pathToFileURL(piTuiEntry).href);
			const { KeybindingsManager } = await import(new URL("./core/keybindings.js", piCodingAgentEntry).href);
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

			// A grouped notice: header does not match the singular regex, no structuredDetails.
			// The content is oversized (full MAX_COMPLETION_MESSAGE_CHARS envelope).
			const groupedContent = "Background tasks completed (4): **a**, **b**, **c**, **d**\n\n"
				+ "1. a\n" + "preview-a\n\n"
				+ "2. b\n" + "preview-b\n\n"
				+ "3. c\n" + "preview-c\n\n"
				+ "4. d\n" + "d".repeat(MAX_COMPLETION_MESSAGE_CHARS);
			const groupedMessage = { content: groupedContent }; // no structuredDetails
			const rendered = notifyRenderer(groupedMessage, { expanded: false }, theme).render(200).join("\n");

			// The truncation marker must appear (content is far over the cap).
			if (!rendered.includes("preview truncated")) {
				throw new Error("grouped notice renderer fallback must show the display-bound truncation marker, got: " + rendered.slice(0, 500));
			}
			// The bulk of the oversized tail must not appear. The bounded content includes
			// only a small prefix of the 32 000 'd'-chars (up to ~MAX_DISPLAY_SUMMARY_CHARS).
			// Without the fix, thousands of 'd'-chars would pass through; with it, at most
			// ~1 100 can appear before the truncation marker. Check for a run clearly larger
			// than the bounded slice allows.
			if (rendered.includes("d".repeat(2000))) {
				throw new Error("grouped notice renderer fallback must not expose the oversized tail");
			}
			// The rendered content (stripping per-line padding spaces) must be much
			// smaller than the full 32 000-char envelope. The content is bounded at
			// MAX_DISPLAY_SUMMARY_CHARS before Text wraps and pads each line to width.
			// With ~20 lines padded to 200 chars each: expected ~4000. Without the fix,
			// the full envelope produces ~36 000 chars rendered. Use 10x the display
			// cap as the generous upper bound (includes wrapping + padding overhead).
			const renderedContentChars = rendered.replace(/ +$/gm, "").length;
			if (renderedContentChars > MAX_DISPLAY_SUMMARY_CHARS * 10) {
				throw new Error("grouped notice renderer fallback exposed too much content: " + renderedContentChars + " chars (limit: " + (MAX_DISPLAY_SUMMARY_CHARS * 10) + ")");
			}
		`;
    const env = { ...process.env };
    delete env[SUBAGENT_CHILD_ENV];
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
