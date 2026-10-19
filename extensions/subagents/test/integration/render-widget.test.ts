import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AsyncJobState } from "../support/render-widget-fixtures.ts";
import {
  buildWidgetLines,
  createWidgetTestIsolation,
  createWidgetTheme,
} from "../support/render-widget-fixtures.ts";

const theme = createWidgetTheme();
const widgetTestIsolation = createWidgetTestIsolation(theme);
beforeEach(widgetTestIsolation.beforeEach);
afterEach(widgetTestIsolation.afterEach);

const HINT = "Press Ctrl+Shift+D for live detail";
const childLocation = {
  childCwd: "/repos/app",
  displayPath: "~/repos/app",
  repoName: "app",
  branch: "main",
};

function indentOf(lines: string[], needle: string | RegExp): number {
  const line = lines.find((candidate) =>
    typeof needle === "string" ? candidate.includes(needle) : needle.test(candidate),
  );
  assert.ok(line, `line matching ${String(needle)} should be present`);
  return line.length - line.trimStart().length;
}

function hintLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes(HINT));
}

describe("async widget detail column and live-detail hint", () => {
  it("aligns single-job location, activity and hint at detail column 6", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "single",
          asyncDir: "/tmp/single",
          status: "running",
          mode: "single",
          agents: ["worker"],
          steps: [
            { index: 0, agent: "worker", status: "running", currentTool: "read", childLocation },
          ],
          stepsTotal: 1,
        },
      ],
      theme,
      160,
    );

    assert.equal(indentOf(lines, "worker"), 2);
    assert.equal(indentOf(lines, "~/repos/app"), 6);
    assert.equal(indentOf(lines, /\bread\b/), 6);
    assert.equal(indentOf(lines, HINT), 6);
    assert.equal(hintLines(lines).length, 1);
  });

  it("shows exactly one hint at column 2 after the last step of a parallel job", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "parallel",
          asyncDir: "/tmp/parallel",
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer", "writer"],
          runningSteps: 2,
          completedSteps: 1,
          stepsTotal: 3,
          steps: [
            { index: 0, agent: "scout", status: "complete" },
            { index: 1, agent: "reviewer", status: "running", currentTool: "read", childLocation },
            { index: 2, agent: "writer", status: "running", currentTool: "grep" },
          ],
        },
      ],
      theme,
      160,
    );

    assert.equal(hintLines(lines).length, 1);
    assert.equal(indentOf(lines, HINT), 2);
    assert.equal(lines.at(-1)?.trim(), HINT, "hint should follow the last step");
    assert.equal(indentOf(lines, "~/repos/app"), 6);
    assert.equal(indentOf(lines, /\bread\b/), 6);
  });

  it("shows exactly one hint for a multi-step parallel job in the multi-job list", () => {
    const parallel: AsyncJobState = {
      asyncId: "par-multi",
      asyncDir: "/tmp/par-multi",
      status: "running",
      mode: "parallel",
      agents: ["planner", "worker"],
      stepsTotal: 2,
      steps: [
        { index: 0, agent: "planner", status: "running", currentTool: "grep" },
        { index: 1, agent: "worker", status: "running", currentTool: "read" },
      ],
    };
    const other: AsyncJobState = {
      asyncId: "solo",
      asyncDir: "/tmp/solo",
      status: "running",
      mode: "single",
      agents: ["reviewer"],
      stepsTotal: 1,
      steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
    };
    const lines = buildWidgetLines([parallel, other], theme, 160);
    assert.equal(hintLines(lines).length, 1);
  });

  it("shows exactly one hint after the last job when 2+ jobs are running in the list", () => {
    const running = (id: string, agent: string): AsyncJobState => ({
      asyncId: id,
      asyncDir: `/tmp/${id}`,
      status: "running",
      mode: "single",
      agents: [agent],
      stepsTotal: 1,
      steps: [{ index: 0, agent, status: "running", currentTool: "read" }],
    });
    const parallel: AsyncJobState = {
      asyncId: "par",
      asyncDir: "/tmp/par",
      status: "running",
      mode: "parallel",
      agents: ["scout", "writer"],
      stepsTotal: 2,
      steps: [
        { index: 0, agent: "scout", status: "running", currentTool: "grep" },
        { index: 1, agent: "writer", status: "running", currentTool: "edit" },
      ],
    };
    const lines = buildWidgetLines(
      [running("a", "alpha"), parallel, running("b", "beta")],
      theme,
      160,
    );
    assert.equal(hintLines(lines).length, 1);
    assert.equal(lines.at(-1)?.trim(), HINT, "hint should follow the last job block");
    assert.equal(indentOf(lines, HINT), 6);
    assert.equal(
      hintLines(buildWidgetLines([running("a", "alpha"), parallel], theme, 160, true)).length,
      0,
    );
  });

  it("shows no hint in expanded mode and indents expanded detail under the detail column", () => {
    const now = Date.now();
    const job: AsyncJobState = {
      asyncId: "expanded",
      asyncDir: "/tmp/expanded",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: now,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "read",
          currentToolStartedAt: now - 1000,
          recentTools: [{ tool: "grep", args: "needle", endMs: now - 2000 }],
          recentOutput: ["recent output line"],
        },
      ],
    };
    const lines = buildWidgetLines([job], theme, 160, true);

    assert.equal(hintLines(lines).length, 0);
    assert.equal(indentOf(lines, "output:"), 6);
    assert.equal(indentOf(lines, "grep: needle"), 8);
    assert.equal(indentOf(lines, "recent output line"), 8);
  });
});
