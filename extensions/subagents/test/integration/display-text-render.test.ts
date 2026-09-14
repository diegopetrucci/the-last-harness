import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlainTheme } from "../support/themes.ts";
import { renderSubagentResult, buildWidgetLines } from "../../src/tui/render.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";
import { BINARY_CONTENT_PLACEHOLDER } from "../../src/shared/display-text.ts";
import type { AgentProgress, AsyncJobState, Details } from "../../src/shared/types.ts";

const theme = createPlainTheme();
const unsafe = "visible \x1b[31mred\x1b[0m\x07tail";

function assertTerminalSafe(text: string): void {
  assert.equal(text.includes("\x1b"), false, `unexpected ESC in ${JSON.stringify(text)}`);
  assert.equal(text.includes("\x07"), false, `unexpected BEL in ${JSON.stringify(text)}`);
  assert.match(text, /visible red tail/);
}

describe("TUI display boundaries", () => {
  it("sanitizes foreground live, history, and nested child text", () => {
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

  it("bounds newline-bearing child paths to one widget and result-card row", () => {
    const childLocation: ChildLocationSnapshot = {
      childCwd: "/tmp/bad\r\ndir",
      displayPath: "bad\r\ndir",
    };
    const job: AsyncJobState = {
      asyncId: "newline-path-widget",
      asyncDir: "/tmp/newline-path-widget",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          childLocation,
        },
      ],
      stepsTotal: 1,
    };
    const widgetRows = buildWidgetLines([job], theme, 180, false);
    const widgetLocationRows = widgetRows.filter((line) => line.includes("cwd:"));
    assert.equal(widgetLocationRows.length, 1);
    assert.match(widgetLocationRows[0]!, /bad\\r\\ndir/);
    assert.ok(!widgetLocationRows[0]!.includes("\r"));
    assert.ok(!widgetLocationRows[0]!.includes("\n"));

    const details: Details = {
      mode: "single",
      results: [
        {
          agent: "worker",
          task: "review",
          exitCode: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          childLocation,
        },
      ],
    };
    for (const expanded of [false, true]) {
      const resultRows = renderSubagentResult(
        { content: [{ type: "text", text: "done" }], details },
        { expanded },
        theme,
      ).render(180);
      const resultLocationRows = resultRows.filter((line) => line.includes("cwd:"));
      assert.equal(resultLocationRows.length, 1);
      assert.match(resultLocationRows[0]!, /bad\\r\\ndir/);
      assert.ok(!resultLocationRows[0]!.includes("\r"));
      assert.ok(!resultLocationRows[0]!.includes("\n"));
    }
  });

  it("keeps expanded widget progress records single-line and binary-safe", () => {
    const binary = "\x01\x02A".repeat(30) + "\x00";
    const fakeStatusRow = "  ⎿  fake-widget-row";
    const job: AsyncJobState = {
      asyncId: "single-line-widget-progress",
      asyncDir: "/tmp/single-line-widget-progress",
      status: "running",
      mode: "single",
      agents: ["worker"],
      updatedAt: 10_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          recentTools: [
            { tool: "inspect", args: `arg-one\r\n${fakeStatusRow}`, endMs: 1 },
            { tool: "binary-tool", args: binary, endMs: 2 },
          ],
          recentOutput: [`recent-one\r\nrecent-two`, binary],
        },
      ],
      stepsTotal: 1,
    };

    const rows = buildWidgetLines([job], theme, 180, true);
    assert.ok(rows.every((row) => !row.includes("\r") && !row.includes("\n")));
    assert.equal(
      rows.filter((row) => row.includes("arg-one") && row.includes("fake-widget-row")).length,
      1,
    );
    assert.equal(
      rows.filter((row) => row.includes("recent-one") && row.includes("recent-two")).length,
      1,
    );
    assert.equal(rows.filter((row) => row.includes(BINARY_CONTENT_PLACEHOLDER)).length, 2);
    assert.equal(rows.filter((row) => row.trimStart().startsWith("⎿  fake-widget-row")).length, 0);
  });

  it("keeps expanded result-card progress single-line, preserves documents, and retains binary placeholders", () => {
    const binary = "\x01\x02A".repeat(30) + "\x00";
    const progress: AgentProgress = {
      index: 0,
      agent: "worker",
      status: "running",
      task: "review",
      currentTool: "inspect",
      currentToolArgs: "--flag",
      recentTools: [
        { tool: "card-tool", args: "card-arg-one\r\n  ⎿  fake-card-row", endMs: 1 },
        { tool: "card-binary-tool", args: binary, endMs: 2 },
      ],
      recentOutput: ["card-recent-one\r\ncard-recent-two", binary],
      toolCount: 1,
      tokens: 1,
      durationMs: 1,
    };
    const details: Details = {
      mode: "single",
      results: [
        {
          agent: "worker",
          task: "review",
          exitCode: 0,
          finalOutput: "card-document-one\r\ncard-document-two",
          progress,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        },
      ],
    };

    const expandedRows = renderSubagentResult(
      { content: [{ type: "text", text: "running" }], details },
      { expanded: true },
      theme,
    ).render(180);
    assert.equal(
      expandedRows.filter((row) => row.includes("card-arg-one") && row.includes("fake-card-row"))
        .length,
      1,
    );
    assert.equal(
      expandedRows.filter(
        (row) => row.includes("card-recent-one") && row.includes("card-recent-two"),
      ).length,
      1,
    );
    const documentRowOne = expandedRows.findIndex((row) => row.includes("card-document-one"));
    const documentRowTwo = expandedRows.findIndex((row) => row.includes("card-document-two"));
    assert.notEqual(documentRowOne, -1);
    assert.notEqual(documentRowTwo, -1);
    assert.notEqual(documentRowOne, documentRowTwo);
    assert.equal(expandedRows.filter((row) => row.includes(BINARY_CONTENT_PLACEHOLDER)).length, 2);
    assert.equal(
      expandedRows.filter((row) => row.trimStart().startsWith("⎿  fake-card-row")).length,
      0,
    );

    const collapsedRows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "review",
              exitCode: 0,
              finalOutput: "collapsed-first\r\ncollapsed-second",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    ).render(180);
    assert.equal(collapsedRows.filter((row) => row.includes("collapsed-first")).length, 1);
    assert.equal(
      collapsedRows.some((row) => row.includes("collapsed-second")),
      false,
    );

    const multiRows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "empty-worker",
              task: "review",
              exitCode: 0,
              finalOutput: "\x1b[31m\x1b[0m",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
            {
              agent: "output-worker",
              task: "review",
              exitCode: 0,
              finalOutput: "visible output",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    ).render(180);
    assert.ok(multiRows.some((row) => row.includes("Done (no text output)")));
    assert.ok(multiRows.every((row) => !row.includes("\x1b")));

    const binaryRows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "review",
              exitCode: 0,
              finalOutput: binary,
              usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, cacheWrite: 0 },
            },
          ],
        },
      },
      { expanded: true },
      theme,
    ).render(180);
    assert.ok(binaryRows.some((row) => row.includes(BINARY_CONTENT_PLACEHOLDER)));

    const binaryTaskSingleRows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "worker",
              task: "review\x00",
              exitCode: 0,
              finalOutput: "task output",
              usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, cacheWrite: 0 },
            },
          ],
        },
      },
      { expanded: true },
      theme,
    ).render(180);
    assert.ok(
      binaryTaskSingleRows.some((row) => row.includes(`Task: ${BINARY_CONTENT_PLACEHOLDER}`)),
      "expanded single task should retain the binary placeholder",
    );

    const binaryTaskMultiRows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "worker",
              task: "review\x00",
              exitCode: 0,
              finalOutput: "task output",
              usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, cacheWrite: 0 },
            },
            {
              agent: "other-worker",
              task: "review",
              exitCode: 0,
              finalOutput: "other output",
              usage: { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, cacheWrite: 0 },
            },
          ],
        },
      },
      { expanded: true },
      theme,
    ).render(180);
    assert.ok(
      binaryTaskMultiRows.some((row) => row.includes(`task: ${BINARY_CONTENT_PLACEHOLDER}`)),
      "expanded multi task should retain the binary placeholder",
    );
  });

  it("bounds an error-less failed multiline result in a collapsed parallel card", () => {
    const firstLine = "failure detail line 0 with some extra words here";
    const laterLines = Array.from(
      { length: 40 },
      (_, index) => `later-line-${index} should stay out of the compact status`,
    ).join("\n");
    const rows = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "failed-worker",
              task: "run the worker",
              exitCode: 1,
              finalOutput: `${firstLine}\n${laterLines}`,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
            {
              agent: "healthy-worker",
              task: "run the worker",
              exitCode: 0,
              finalOutput: "healthy output",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    ).render(80);

    assert.ok(rows.some((row) => row.includes(`Error: ${firstLine}`)));
    assert.equal(
      rows.some((row) => row.includes("later-line-")),
      false,
    );
    assert.ok(rows.some((row) => row.includes("healthy-worker")));
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
