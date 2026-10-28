import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentLiveDetailShortcut } from "../../src/extension/live-detail-shortcut.ts";
import {
  createSubagentLiveDetailController,
  liveDetailShortcutDisplay,
} from "../../src/shared/subagent-shortcuts.ts";
import { renderWidget } from "../../src/tui/render.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function widgetLines(widget: unknown, width = 180): string[] {
  return (
    widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] }
  )(undefined, theme).render(width);
}

function runningJob() {
  return {
    asyncId: "live-detail-run",
    asyncDir: "/tmp/live-detail-run",
    status: "running",
    mode: "parallel",
    agents: ["reviewer"],
    runningSteps: 1,
    completedSteps: 0,
    stepsTotal: 1,
    steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
  };
}

describe("subagent live-detail controller", () => {
  it("toggles and sets expanded state", () => {
    const controller = createSubagentLiveDetailController();
    assert.equal(controller.isExpanded(), false);
    assert.equal(controller.toggle(), true);
    assert.equal(controller.setExpanded(false), false);
    assert.equal(controller.isExpanded(), false);
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
    // Pi redraws after widget replacement; the extension must not
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
