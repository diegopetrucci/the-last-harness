import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlainTheme } from "../support/themes.ts";
import { liveDetailShortcutDisplay } from "../../src/shared/subagent-shortcuts.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";

const theme = createPlainTheme();
const hint = `Press ${liveDetailShortcutDisplay()} for live detail`;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function running(index: number, agent: string, extra: Record<string, unknown> = {}) {
  return {
    agent,
    task: "Do the work.",
    exitCode: 0,
    usage,
    tkTicket: { id: `t-${index}`, title: `Ticket ${index}` },
    childLocation: { childCwd: `/tmp/loc-${index}`, displayPath: `/tmp/loc-${index}` },
    progress: {
      index,
      agent,
      status: "running" as const,
      task: "x",
      recentTools: [],
      recentOutput: [],
      toolCount: 1,
      tokens: 0,
      durationMs: 10,
      activityState: "active_long_running" as const,
      currentTool: "read",
      currentToolArgs: "file.ts",
      currentToolStartedAt: 1,
    },
    ...extra,
  };
}

function render(mode: "single" | "parallel", results: unknown[], expanded: boolean): string[] {
  return renderSubagentResult!(
    {
      content: [{ type: "text", text: "running" }],
      details: { mode, totalSteps: results.length, results },
    } as never,
    { expanded },
    theme,
  ).render(140);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const find = (lines: string[], needle: string) => lines.filter((l) => l.includes(needle));

describe("foreground detail column", () => {
  it("collapsed single aligns details at column 4 and the hint at column 2", () => {
    const lines = render("single", [running(0, "worker")], false);
    const hints = find(lines, hint);
    assert.equal(hints.length, 1);
    const detail = lines.slice(1).filter((l) => l.trim() && l !== hints[0]);
    assert.ok(detail.length >= 3);
    for (const line of detail) assert.equal(indentOf(line), 4, line);
    assert.equal(indentOf(hints[0]!), 2);
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    assert.equal(nonEmpty[nonEmpty.length - 1], hints[0]);
  });

  it("collapsed multi aligns details at column 6 and the hint at column 2", () => {
    const lines = render("parallel", [running(0, "a"), running(1, "b")], false);
    const detail = lines.filter((l) => /ticket:|loc-/.test(l));
    const hints = find(lines, hint);
    assert.equal(hints.length, 1);
    assert.ok(detail.length >= 4);
    for (const line of detail) assert.equal(indentOf(line), 6, line);
    assert.equal(indentOf(hints[0]!), 2);
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    assert.equal(nonEmpty[nonEmpty.length - 1], hints[0]);
  });

  it("collapsed finished single status line shares the detail column", () => {
    const done = running(0, "worker", {
      progress: { ...running(0, "worker").progress, status: "completed" },
      finalOutput: "all good",
    });
    const lines = render("single", [done], false);
    assert.equal(indentOf(find(lines, "Done")[0]!), 4);
    assert.equal(indentOf(find(lines, "all good")[0]!), 4);
  });

  it("expanded single and multi use column 4 and expanded multi shows one hint", () => {
    const single = render("single", [running(0, "worker")], true);
    for (const needle of ["ticket:", "loc-0", hint]) {
      assert.equal(indentOf(find(single, needle)[0]!), 4, needle);
    }
    const multi = render("parallel", [running(0, "a"), running(1, "b")], true);
    assert.equal(find(multi, hint).length, 1);
    for (const line of multi.filter((l) => /ticket:|loc-/.test(l))) {
      assert.equal(indentOf(line), 4, line);
    }
  });
});
