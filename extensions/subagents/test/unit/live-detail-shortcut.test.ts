import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentLiveDetailShortcut } from "../../src/extension/live-detail-shortcut.ts";
import { createSubagentLiveDetailController, liveDetailShortcutDisplay } from "../../src/shared/subagent-shortcuts.ts";
import { renderWidget } from "../../src/tui/render.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function widgetLines(widget: unknown, width = 180): string[] {
	return (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(
		undefined,
		theme,
	).render(width);
}

function runningJob() {
	return {
		asyncId: "live-detail-run",
		asyncDir: "/tmp/live-detail-run",
		status: "running",
		mode: "parallel",
		agents: ["reviewer"],
		activeParallelGroup: true,
		runningSteps: 1,
		completedSteps: 0,
		stepsTotal: 1,
		steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
	};
}

describe("subagent live-detail controller", () => {
	it("defers and deduplicates probes before toggling confirmed live rows", async () => {
		const controller = createSubagentLiveDetailController();
		const liveRendererState = {};
		let liveInvalidations = 0;
		let reenteredAsLive = false;
		function liveInvalidate(): void {
			liveInvalidations++;
			reenteredAsLive = controller.registerToolRow("tool-row", liveRendererState, liveInvalidate);
		}
		assert.equal(controller.registerToolRow("tool-row", liveRendererState, liveInvalidate), false);
		assert.equal(controller.registerToolRow("tool-row", liveRendererState, liveInvalidate), false);
		assert.equal(liveInvalidations, 0, "probe ran inside the initial render stack");

		await Promise.resolve();
		assert.equal(reenteredAsLive, true);
		assert.equal(liveInvalidations, 1, "duplicate registrations scheduled more than one probe");
		assert.equal(controller.registerToolRow("tool-row", liveRendererState, liveInvalidate), true);
		assert.equal(liveInvalidations, 1, "confirmed state was probed instead of returning immediately");

		const nonLiveRendererState = {};
		let nonLiveInvalidations = 0;
		const nonLiveInvalidate = () => {
			nonLiveInvalidations++;
		};
		assert.equal(controller.registerToolRow("tool-row", nonLiveRendererState, nonLiveInvalidate), false);
		assert.equal(controller.registerToolRow("tool-row", nonLiveRendererState, nonLiveInvalidate), false);
		assert.equal(nonLiveInvalidations, 0);
		await Promise.resolve();
		assert.equal(nonLiveInvalidations, 1);
		assert.equal(controller.registerToolRow("tool-row", nonLiveRendererState, nonLiveInvalidate), false);
		await Promise.resolve();
		assert.equal(nonLiveInvalidations, 1, "rejected state was probed more than once");

		assert.equal(controller.isExpanded(), false);
		assert.equal(controller.toggle(), true);
		assert.equal(controller.isExpanded(), true);
		assert.equal(liveInvalidations, 2);
		assert.equal(nonLiveInvalidations, 1);
		assert.equal(controller.toggle(), false);
		assert.equal(liveInvalidations, 3);
		assert.equal(nonLiveInvalidations, 1);

		controller.clearToolRows();
		controller.toggle();
		assert.equal(liveInvalidations, 3);
	});

	it("rejects deferred no-op and throwing invalidators without retaining them", async () => {
		const controller = createSubagentLiveDetailController();
		const noOpState = {};
		let noOpCalls = 0;
		const noOpInvalidate = () => {
			noOpCalls++;
		};
		assert.equal(controller.registerToolRow("unseen-no-op", noOpState, noOpInvalidate), false);
		assert.equal(controller.registerToolRow("unseen-no-op", noOpState, noOpInvalidate), false);

		const throwingState = {};
		let throwingCalls = 0;
		function throwingInvalidate(): void {
			throwingCalls++;
			controller.registerToolRow("unseen-throwing", throwingState, throwingInvalidate);
			throw new Error("not live");
		}
		assert.equal(controller.registerToolRow("unseen-throwing", throwingState, throwingInvalidate), false);
		assert.equal(noOpCalls, 0);
		assert.equal(throwingCalls, 0);

		await Promise.resolve();
		assert.equal(noOpCalls, 1);
		assert.equal(throwingCalls, 1);
		assert.equal(controller.registerToolRow("unseen-no-op", noOpState, noOpInvalidate), false);
		assert.equal(controller.registerToolRow("unseen-throwing", throwingState, throwingInvalidate), false);
		await Promise.resolve();
		assert.equal(noOpCalls, 1);
		assert.equal(throwingCalls, 1);

		controller.toggle();
		assert.equal(noOpCalls, 1);
		assert.equal(throwingCalls, 1);
	});

	it("reclaims a rebuilt live row only after its deferred invalidator re-enters", async () => {
		const controller = createSubagentLiveDetailController();
		const staleRendererState = {};
		let staleInvalidations = 0;
		function staleInvalidate(): void {
			staleInvalidations++;
			controller.registerToolRow("tool-row", staleRendererState, staleInvalidate);
		}
		assert.equal(controller.registerToolRow("tool-row", staleRendererState, staleInvalidate), false);
		assert.equal(staleInvalidations, 0);
		await Promise.resolve();
		assert.equal(staleInvalidations, 1);

		const rebuiltRendererState = {};
		let rebuiltInvalidations = 0;
		let reenteredAsLive = false;
		function rebuiltInvalidate(): void {
			rebuiltInvalidations++;
			reenteredAsLive = controller.registerToolRow("tool-row", rebuiltRendererState, rebuiltInvalidate);
		}

		assert.equal(controller.registerToolRow("tool-row", rebuiltRendererState, rebuiltInvalidate), false);
		assert.equal(rebuiltInvalidations, 0);
		await Promise.resolve();
		assert.equal(reenteredAsLive, true);
		assert.equal(rebuiltInvalidations, 1);
		controller.toggle();
		assert.equal(staleInvalidations, 1);
		assert.equal(rebuiltInvalidations, 2);
	});

	it("drops queued probes when tool rows are cleared", async () => {
		const controller = createSubagentLiveDetailController();
		const rendererState = {};
		let invalidations = 0;
		function invalidate(): void {
			invalidations++;
			controller.registerToolRow("tool-row", rendererState, invalidate);
		}

		assert.equal(controller.registerToolRow("tool-row", rendererState, invalidate), false);
		controller.clearToolRows();
		await Promise.resolve();
		assert.equal(invalidations, 0, "a stale queued probe ran after clearToolRows");
		controller.toggle();
		assert.equal(invalidations, 0);

		assert.equal(controller.registerToolRow("tool-row", rendererState, invalidate), false);
		await Promise.resolve();
		assert.equal(invalidations, 1, "the renderer state could not probe in the new generation");
		controller.toggle();
		assert.equal(invalidations, 2);
	});

	it("rerenders the widget through the shortcut handler without changing Pi expansion", () => {
		const controller = createSubagentLiveDetailController();
		let widgetRenders = 0;
		let renderRequests = 0;
		let piExpansionChanges = 0;
		const ctx = {
			hasUI: true,
			ui: {
				requestRender: () => {
					renderRequests++;
				},
				getToolsExpanded: () => true,
				setToolsExpanded: () => {
					piExpansionChanges++;
				},
			},
		} as never;

		assert.equal(
			handleSubagentLiveDetailShortcut(controller, ctx, () => {
				widgetRenders++;
			}),
			true,
		);
		assert.equal(
			handleSubagentLiveDetailShortcut(controller, ctx, () => {
				widgetRenders++;
			}),
			false,
		);
		assert.equal(widgetRenders, 2);
		// Pi 0.83 redraws after widget replacement; the extension must not
		// call the removed direct requestRender helper.
		assert.equal(renderRequests, 0);
		assert.equal(piExpansionChanges, 0);
	});

	it("keeps widget hints and detail independent from Pi Ctrl+O expansion", () => {
		assert.equal(liveDetailShortcutDisplay(), "Ctrl+Shift+D");
		let widget: unknown;
		const controller = createSubagentLiveDetailController();
		const ctx = {
			hasUI: true,
			ui: {
				getToolsExpanded: () => true,
				setWidget: (_key: string, value: unknown) => {
					widget = value;
				},
			},
		} as never;

		renderWidget(ctx, [runningJob()] as never, controller);
		const collapsed = widgetLines(widget).join("\n");
		assert.match(collapsed, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(collapsed, /output: \/tmp\/live-detail-run/);

		controller.setExpanded(true);
		const expanded = widgetLines(widget).join("\n");
		assert.doesNotMatch(expanded, /Press Ctrl\+Shift\+D for live detail/);
		assert.match(expanded, /output: \/tmp\/live-detail-run/);

		renderWidget(ctx, [], controller);
	});
});
