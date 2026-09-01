import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlainTheme } from "../support/themes.ts";
import { renderSubagentResult, buildWidgetLines } from "../../src/tui/render.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

const theme = createPlainTheme();
const unsafe = "visible \x1b[31mred\x1b[0m\x07tail";

function assertTerminalSafe(text: string): void {
  assert.equal(text.includes("\x1b"), false, `unexpected ESC in ${JSON.stringify(text)}`);
  assert.equal(text.includes("\x07"), false, `unexpected BEL in ${JSON.stringify(text)}`);
  assert.match(text, /visible red tail/);
}

describe("TUI display boundaries", () => {
  it("sanitizes foreground live, history, and workflow-derived child text", () => {
    const result = {
      content: [{ type: "text" as const, text: "running" }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: unsafe,
            task: unsafe,
            exitCode: 0,
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            finalOutput: unsafe,
            progress: {
              index: 0,
              agent: unsafe,
              status: "running" as const,
              task: unsafe,
              currentTool: unsafe,
              currentToolArgs: unsafe,
              recentTools: [{ tool: unsafe, args: unsafe, endMs: 1 }],
              recentOutput: [unsafe],
              toolCount: 1,
              tokens: 0,
              durationMs: 1,
            },
          },
        ],
      },
    };
    const snapshot = structuredClone(result);

    for (const expanded of [false, true]) {
      const rendered = renderSubagentResult(result, { expanded }, theme).render(160).join("\n");
      assertTerminalSafe(rendered);
    }
    assert.deepEqual(result, snapshot);
  });

  it("renders an interrupted expanded single result as paused", () => {
    const rendered = renderSubagentResult(
      {
        content: [{ type: "text", text: "Paused" }],
        details: {
          mode: "single" as const,
          results: [
            {
              agent: "worker",
              task: "Pause the worker.",
              exitCode: 0,
              interrupted: true,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
          ],
        },
      },
      { expanded: true },
      theme,
    )
      .render(160)
      .join("\n");

    assert.match(rendered, /^paused worker(?:\n|$)/);
  });

  it("sanitizes async widget metadata, output, and nested child failures", () => {
    const job: AsyncJobState = {
      asyncId: "display-widget",
      asyncDir: "/tmp/display-widget",
      status: "running",
      mode: "single",
      agents: [unsafe],
      updatedAt: 10_000,
      steps: [
        {
          index: 0,
          agent: unsafe,
          status: "running",
          currentTool: unsafe,
          currentToolArgs: unsafe,
          recentTools: [{ tool: unsafe, args: unsafe, endMs: 1 }],
          recentOutput: [unsafe],
          children: [
            {
              id: "nested-widget",
              parentRunId: "display-widget",
              parentStepIndex: 0,
              depth: 1,
              path: [],
              state: "failed",
              agent: unsafe,
              error: unsafe,
            },
          ],
        },
      ],
      stepsTotal: 1,
    };
    const snapshot = structuredClone(job);

    for (const expanded of [false, true]) {
      const rendered = buildWidgetLines([job], theme, 180, expanded).join("\n");
      assertTerminalSafe(rendered);
    }
    assert.deepEqual(job, snapshot);
  });
});
