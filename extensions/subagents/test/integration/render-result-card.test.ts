import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlainTheme } from "../support/themes.ts";
import { finalizeSingleOutput } from "../../src/runs/shared/single-output.ts";
import { liveDetailShortcutDisplay } from "../../src/shared/subagent-shortcuts.ts";
import { truncateOutput, type Details, type SubagentToolResult } from "../../src/shared/types.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";
import {
  WHIMSICAL_THINKING_PHRASES,
  whimsicalThinkingPhrase,
} from "../../src/tui/whimsical-phrases.ts";

const theme = createPlainTheme();

const expandKey = liveDetailShortcutDisplay();
const expandHint = `Press ${expandKey} for full output`;
const liveDetailHint = `Press ${expandKey} for live detail`;
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function firstGrapheme(text: string): string {
  return Array.from(text.trimStart())[0] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withTerminalWidth<T>(columns: number, fn: () => T): T {
  const original = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: columns,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      value: original,
      configurable: true,
    });
  }
}

function withTerminalRows<T>(rows: number, fn: () => T): T {
  const original = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", {
    value: rows,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "rows", {
      value: original,
      configurable: true,
    });
  }
}

describe("renderSubagentResult", () => {
  it("shows a resolved foreground tk ticket once while active in compact and expanded cards", () => {
    const result = {
      agent: "worker",
      task: "Run `tk show psr-raw4` first.",
      exitCode: 0,
      usage: emptyUsage,
      tkTicket: { id: "psr-raw4", title: "Show active tk title" },
      progress: {
        index: 0,
        agent: "worker",
        status: "running" as const,
        task: "Run `tk show psr-raw4` first.",
        recentTools: [],
        recentOutput: [],
        toolCount: 1,
        tokens: 0,
        durationMs: 10,
      },
    };
    for (const expanded of [false, true]) {
      const text = renderSubagentResult!(
        {
          content: [{ type: "text", text: "running" }],
          details: { mode: "single", results: [result] },
        },
        { expanded },
        theme,
      )
        .render(120)
        .join("\n");
      assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
    }

    const completedText = renderSubagentResult!(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [{ ...result, progress: { ...result.progress, status: "completed" } }],
        },
      },
      { expanded: false },
      theme,
    )
      .render(120)
      .join("\n");
    assert.doesNotMatch(completedText, /ticket: Show active tk title/);
  });

  it("shows one foreground tk ticket indicator for active parallel children", () => {
    const text = renderSubagentResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          mode: "parallel",
          totalSteps: 2,
          results: [
            {
              agent: "ticketed",
              task: "Run `tk show psr-raw4` first.",
              exitCode: 0,
              usage: emptyUsage,
              tkTicket: { id: "psr-raw4", title: "Show active tk title" },
              progress: {
                index: 0,
                agent: "ticketed",
                status: "running",
                task: "ticket",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
            {
              agent: "plain",
              task: "Review the result.",
              exitCode: 0,
              usage: emptyUsage,
              progress: {
                index: 1,
                agent: "plain",
                status: "running",
                task: "plain",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    )
      .render(140)
      .join("\n");
    assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
  });

  it("ignores sparse historical result entries while preserving logical row indexes", () => {
    const validResult = {
      agent: "reviewer",
      task: "Review the change.",
      exitCode: 0,
      messages: [],
      usage: emptyUsage,
      finalOutput: "review complete",
      progress: {
        index: 1,
        agent: "reviewer",
        status: "completed" as const,
        task: "Review the change.",
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 1,
      },
    };
    const sparseResults: unknown[] = [];
    sparseResults[0] = null;
    sparseResults[1] = validResult;
    const details = {
      mode: "parallel" as const,
      totalSteps: 3,
      results: sparseResults,
    } as Details;
    const input: SubagentToolResult<Details> = {
      content: [{ type: "text", text: "done" }],
      details,
    };

    for (const expanded of [false, true]) {
      const text = renderSubagentResult!(input, { expanded }, theme).render(120).join("\n");
      assert.match(text, /1\/3 done/);
      assert.match(text, /Agent 2\/3: reviewer/);
      assert.doesNotMatch(text, /Agent 1\/3/);
    }
    assert.equal(sparseResults.length, 2);
    assert.equal(sparseResults[0], null);
    assert.equal(sparseResults[1], validResult);
  });

  it("renders one live-detail hint after all running foreground result rows", () => {
    const text = withTerminalWidth(140, () =>
      renderSubagentResult!(
        {
          content: [{ type: "text", text: "running" }],
          details: {
            mode: "parallel",
            totalSteps: 2,
            results: [
              {
                agent: "reviewer",
                task: "Review the change.",
                exitCode: 0,
                usage: emptyUsage,
                tkTicket: { id: "tlhf-first", title: "First ticket" },
                progress: {
                  index: 0,
                  agent: "reviewer",
                  status: "running",
                  task: "Review the change.",
                  currentTool: "read",
                  currentToolArgs: "reviewer.ts",
                  recentTools: [],
                  recentOutput: [],
                  toolCount: 1,
                  tokens: 0,
                  durationMs: 10,
                },
              },
              {
                agent: "writer",
                task: "Write the change.",
                exitCode: 0,
                usage: emptyUsage,
                progress: {
                  index: 1,
                  agent: "writer",
                  status: "running",
                  task: "Write the change.",
                  currentTool: "write",
                  currentToolArgs: "writer.ts",
                  recentTools: [],
                  recentOutput: [],
                  toolCount: 1,
                  tokens: 0,
                  durationMs: 10,
                },
              },
            ],
            artifacts: { dir: "/tmp/foreground-artifacts", files: [] },
          },
        },
        { expanded: false },
        theme,
      )
        .render(140)
        .join("\n"),
    );

    const lines = text.split("\n");
    const hintLines = lines.filter((line) => line.includes(liveDetailHint));
    assert.equal(hintLines.length, 1, "concurrent running rows should share one live-detail hint");
    assert.match(text, /artifacts: \/tmp\/foreground-artifacts/);

    const reviewerRowIndex = lines.findIndex((line) => line.includes("reviewer"));
    const reviewerTicketIndex = lines.findIndex((line) => line.includes("ticket: First ticket"));
    const reviewerActivityIndex = lines.findIndex((line) => line.includes("read: reviewer.ts"));
    const writerRowIndex = lines.findIndex((line) => line.includes("writer"));
    const writerActivityIndex = lines.findIndex((line) => line.includes("write: writer.ts"));
    const artifactsIndex = lines.findIndex((line) =>
      line.includes("artifacts: /tmp/foreground-artifacts"),
    );
    const hintIndex = lines.findIndex((line) => line.includes(liveDetailHint));

    assert.ok(reviewerRowIndex !== -1, "first agent row should be present");
    assert.ok(reviewerTicketIndex > reviewerRowIndex, "ticket should remain under its agent row");
    assert.ok(
      reviewerActivityIndex > reviewerTicketIndex,
      "first agent activity should remain after its ticket",
    );
    assert.ok(writerRowIndex !== -1, "second agent row should be present");
    assert.ok(
      writerActivityIndex > writerRowIndex,
      "second agent activity should remain in its row",
    );
    assert.ok(hintIndex > writerActivityIndex, "shared hint should follow all agent activity");
    assert.equal(
      artifactsIndex,
      hintIndex - 1,
      "artifacts should remain immediately before the shared hint",
    );
    assert.equal(hintIndex, lines.length - 1, "shared hint should be the final rendered card line");
  });

  it("keeps the shared live-detail footer after collapsed multi-agent truncation", () => {
    const text = withTerminalWidth(140, () =>
      withTerminalRows(10, () =>
        renderSubagentResult!(
          {
            content: [{ type: "text", text: "running" }],
            details: {
              mode: "parallel",
              totalSteps: 2,
              results: [
                {
                  agent: "reviewer",
                  task: "Review the change.",
                  exitCode: 0,
                  usage: emptyUsage,
                  progress: {
                    index: 0,
                    agent: "reviewer",
                    status: "running",
                    task: "Review the change.",
                    currentTool: "read",
                    currentToolArgs: "reviewer.ts",
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 1,
                    tokens: 0,
                    durationMs: 10,
                  },
                },
                {
                  agent: "writer",
                  task: "Write the change.",
                  exitCode: 0,
                  usage: emptyUsage,
                  progress: {
                    index: 1,
                    agent: "writer",
                    status: "running",
                    task: "Write the change.",
                    currentTool: "write",
                    currentToolArgs: "writer.ts",
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 1,
                    tokens: 0,
                    durationMs: 10,
                  },
                },
              ],
              artifacts: { dir: "/tmp/foreground-artifacts", files: [] },
            },
          },
          { expanded: false },
          theme,
        )
          .render(140)
          .join("\n"),
      ),
    );

    const lines = text.split("\n");
    assert.match(text, new RegExp(`lines hidden · ${escapeRegExp(expandKey)} expands`));
    assert.equal(
      lines.filter((line) => line.includes(liveDetailHint)).length,
      1,
      "truncation should retain one shared live-detail footer",
    );
    assert.match(lines.at(-1) ?? "", new RegExp(escapeRegExp(liveDetailHint)));
    assert.ok(lines.length <= 5, "collapsed output should respect the constrained line budget");
  });

  it("keeps the wrapped live-detail footer within a narrow collapsed height budget", () => {
    const text = withTerminalWidth(37, () =>
      withTerminalRows(10, () =>
        renderSubagentResult!(
          {
            content: [{ type: "text", text: "running" }],
            details: {
              mode: "parallel",
              totalSteps: 2,
              results: [
                {
                  agent: "reviewer",
                  task: "Review the change.",
                  exitCode: 0,
                  usage: emptyUsage,
                  progress: {
                    index: 0,
                    agent: "reviewer",
                    status: "running",
                    task: "Review the change.",
                    currentTool: "read",
                    currentToolArgs: "reviewer.ts",
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 1,
                    tokens: 0,
                    durationMs: 10,
                  },
                },
                {
                  agent: "writer",
                  task: "Write the change.",
                  exitCode: 0,
                  usage: emptyUsage,
                  progress: {
                    index: 1,
                    agent: "writer",
                    status: "running",
                    task: "Write the change.",
                    currentTool: "write",
                    currentToolArgs: "writer.ts",
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 1,
                    tokens: 0,
                    durationMs: 10,
                  },
                },
              ],
              artifacts: { dir: "/tmp/foreground-artifacts", files: [] },
            },
          },
          { expanded: false },
          theme,
        )
          .render(37)
          .join("\n"),
      ),
    );

    const lines = text.split("\n");
    const normalized = lines.join(" ").replace(/\s+/g, " ").trim();
    assert.equal(
      normalized.match(new RegExp(escapeRegExp(liveDetailHint), "g"))?.length,
      1,
      "narrow wrapping should retain exactly one live-detail hint",
    );
    const footerStart = lines.findIndex((line) => line.includes(`Press ${expandKey}`));
    assert.ok(footerStart !== -1, "wrapped live-detail footer should be present");
    assert.equal(
      lines.slice(footerStart).join(" ").replace(/\s+/g, " ").trim(),
      liveDetailHint,
      "wrapped live-detail footer should remain final",
    );
    assert.ok(lines.length <= 5, "narrow collapsed output should respect the line budget");
  });

  it("falls back to a bounded key summary when the footer cannot fit", () => {
    const tinyResult = {
      content: [{ type: "text" as const, text: "running" }],
      details: {
        mode: "parallel" as const,
        totalSteps: 2,
        results: ["reviewer", "writer"].map((agent, index) => ({
          agent,
          task: "Run the assigned task.",
          exitCode: 0,
          usage: emptyUsage,
          progress: {
            index,
            agent,
            status: "running" as const,
            task: "Run the assigned task.",
            currentTool: "read",
            currentToolArgs: `${agent}.ts`,
            recentTools: [],
            recentOutput: [],
            toolCount: 1,
            tokens: 0,
            durationMs: 10,
          },
        })),
      },
    };
    const text = withTerminalWidth(8, () =>
      withTerminalRows(10, () =>
        renderSubagentResult!(tinyResult, { expanded: false }, theme).render(8).join("\n"),
      ),
    );

    const lines = text.split("\n");
    assert.ok(lines.length <= 5, "tiny collapsed output should respect the line budget");
    assert.doesNotMatch(text, /Press|live detail|for live/);
  });

  it("indents the ticket line deeper than its agent row in multi-agent compact output", () => {
    const text = renderSubagentResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          mode: "parallel",
          totalSteps: 2,
          results: [
            {
              agent: "ticketed",
              task: "Run `tk show psr-ndnt` first.",
              exitCode: 0,
              usage: emptyUsage,
              tkTicket: { id: "psr-ndnt", title: "Indent ticket under agent" },
              progress: {
                index: 0,
                agent: "ticketed",
                status: "running",
                task: "ticket",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
            {
              agent: "plain",
              task: "Review the result.",
              exitCode: 0,
              usage: emptyUsage,
              progress: {
                index: 1,
                agent: "plain",
                status: "running",
                task: "plain",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    )
      .render(140)
      .join("\n");

    const lines = text.split("\n");
    const agentLineIndex = lines.findIndex((l) => l.includes("ticketed"));
    const ticketLineIndex = lines.findIndex((l) => l.includes("ticket: Indent ticket under agent"));
    assert.ok(agentLineIndex !== -1, "agent row should be present");
    assert.ok(ticketLineIndex !== -1, "ticket line should be present");
    assert.ok(ticketLineIndex > agentLineIndex, "ticket line should appear after agent row");

    const agentLine = lines[agentLineIndex]!;
    const ticketLine = lines[ticketLineIndex]!;
    const agentIndent = agentLine.length - agentLine.trimStart().length;
    const ticketIndent = ticketLine.length - ticketLine.trimStart().length;
    assert.ok(
      ticketIndent > agentIndent,
      `ticket line indent (${ticketIndent}) should exceed agent row indent (${agentIndent})`,
    );
  });

  it("indents the ticket line deeper than its agent row in multi-agent expanded output", () => {
    const text = renderSubagentResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          mode: "parallel",
          totalSteps: 2,
          results: [
            {
              agent: "ticketed",
              task: "Run `tk show psr-xpnd` first.",
              exitCode: 0,
              usage: emptyUsage,
              tkTicket: { id: "psr-xpnd", title: "Expanded indent ticket" },
              progress: {
                index: 0,
                agent: "ticketed",
                status: "running",
                task: "ticket",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
            {
              agent: "plain",
              task: "Review the result.",
              exitCode: 0,
              usage: emptyUsage,
              progress: {
                index: 1,
                agent: "plain",
                status: "running",
                task: "plain",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
          ],
        },
      },
      { expanded: true },
      theme,
    )
      .render(140)
      .join("\n");

    const lines = text.split("\n");
    const agentLineIndex = lines.findIndex((l) => l.includes("ticketed"));
    const ticketLineIndex = lines.findIndex((l) => l.includes("ticket: Expanded indent ticket"));
    assert.ok(agentLineIndex !== -1, "agent row should be present");
    assert.ok(ticketLineIndex !== -1, "ticket line should be present");
    assert.ok(ticketLineIndex > agentLineIndex, "ticket line should appear after agent row");

    const agentLine = lines[agentLineIndex]!;
    const ticketLine = lines[ticketLineIndex]!;
    const agentIndent = agentLine.length - agentLine.trimStart().length;
    const ticketIndent = ticketLine.length - ticketLine.trimStart().length;
    assert.ok(
      ticketIndent > agentIndent,
      `ticket line indent (${ticketIndent}) should exceed agent row indent (${agentIndent})`,
    );
  });

  it("suppresses visible body lines for initial async-start placeholders", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Async: reviewer [abc123]" }],
        details: { mode: "single", asyncId: "abc123", results: [] },
      },
      { expanded: false },
      theme,
    );

    assert.deepEqual(widget.render(120), []);
  });

  it("keeps non-async empty-result content visible", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Async: reviewer [abc123]" }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Async: reviewer \[abc123\]/);
  });

  it("keeps async error placeholders visible", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Failed to start async reviewer run." }],
        isError: true,
        details: { mode: "single", asyncId: "abc123", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Failed to start async reviewer run\./);
  });

  it("keeps management receipts visible even when they reference async runs", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Interrupt requested for async run abc123." }],
        details: { mode: "management", asyncId: "abc123", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Interrupt requested for async run abc123\./);
  });

  it("wraps the complete first-line summary for multiline structured management output", () => {
    const firstLine = "Managed agents: ".padEnd(220, "x");
    const output = `\n${firstLine}\n- reviewer\n- writer`;
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: output }],
        details: { mode: "management", results: [] },
      },
      { expanded: false },
      theme,
    );

    const lines = widget.render(120).map((line) => line.trimEnd());
    assert.match(lines[0]!, /^Managed agents:/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 120));
    assert.ok(
      lines.join("").replace(/\s/g, "").includes(`${firstLine} · 4 lines`.replace(/\s/g, "")),
    );
    assert.doesNotMatch(lines.join("\n"), /\.\.\.|…/);
    const hintLineIndex = lines.findIndex((line) => line.includes(expandHint));
    assert.ok(hintLineIndex > 0);
    assert.doesNotMatch(lines[0]!, /reviewer/);
  });

  it("keeps multiline structured zero-result errors visible", () => {
    const widget = renderSubagentResult!(
      {
        content: [
          { type: "text", text: "Error: management failed\nfirst diagnostic\nsecond diagnostic" },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Error: management failed/);
    assert.match(text, /first diagnostic/);
    assert.match(text, /second diagnostic/);
    assert.ok(!text.includes(expandHint));
  });

  it("keeps full multiline structured output when expanded", () => {
    const output = "Managed agents:\n- reviewer\n- writer";
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: output }],
        details: { mode: "management", results: [] },
      },
      { expanded: true },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Managed agents:/);
    assert.match(text, /- reviewer/);
    assert.match(text, /- writer/);
    assert.ok(!text.includes(expandHint));
  });

  it("collapses multiline structured single output using the same contract", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Run status:\nState: running\nTranscript: available" }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /^Run status:/);
    assert.match(text, /3 lines/);
    assert.ok(text.includes(expandHint));
    assert.doesNotMatch(text, /State: running/);
  });

  it("uses the live-detail shortcut independently of Pi's expand key", () => {
    assert.equal(expandKey, "Ctrl+Shift+D");
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Run status:\nState: running\nTranscript: available" }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /Press Ctrl\+Shift\+D for full output/);
    assert.doesNotMatch(text, /Press  for full output/);
  });

  it("styles keyboard instruction hints with the dim theme", () => {
    const hintStyles: string[] = [];
    const styledTheme = createPlainTheme((name, text) => {
      if (text.includes("Press ")) hintStyles.push(name);
      return text;
    });
    const activeResult = {
      agent: "worker",
      task: "review",
      exitCode: 0,
      usage: emptyUsage,
      progress: {
        index: 0,
        agent: "worker",
        status: "running" as const,
        task: "review",
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      },
    };
    renderSubagentResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: { mode: "single", results: [activeResult] },
      },
      { expanded: false },
      styledTheme,
    ).render(120);
    renderSubagentResult!(
      {
        content: [{ type: "text", text: "First line\nSecond line" }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      styledTheme,
    ).render(120);
    assert.deepEqual(hintStyles, ["dim", "dim"]);
  });

  it("preserves unstructured multiline and structured single-line output", () => {
    const unstructured = renderSubagentResult!(
      {
        content: [{ type: "text", text: "Error:\nfirst detail\nsecond detail" }],
        // isError=true prevents the multiline-compact fold so all lines remain visible.
        // details must be provided (required by AgentToolResult<Details>); empty results
        // combined with isError=true exercises the unstructured content display path.
        details: { mode: "single" as const, results: [] },
        isError: true,
      },
      { expanded: false },
      theme,
    )
      .render(120)
      .join("\n");
    assert.match(unstructured, /first detail/);
    assert.match(unstructured, /second detail/);
    assert.ok(!unstructured.includes(expandHint));

    const singleLine = renderSubagentResult!(
      {
        content: [{ type: "text", text: "No active async run transcript is available." }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      theme,
    )
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n");
    assert.equal(singleLine, "No active async run transcript is available.");
    assert.ok(!singleLine.includes(expandHint));
  });

  it("uses compacted tool-call summaries when messages were stripped", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "reviewer",
              task: "review",
              exitCode: 0,
              messages: undefined,
              toolCalls: [
                {
                  text: "$ npm test -- --watch...",
                  expandedText: "$ npm test -- --watch --runInBand --reporter=dot",
                },
              ],
              usage: emptyUsage,
            },
          ],
        },
      },
      { expanded: true },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /npm test -- --watch --runInBand --reporter=dot/);
  });

  it("shows the full task in expanded mode", () => {
    const longTask =
      "Review the auth flow, trace the race condition, and document the precise failing tool sequence at the end.";
    const collapsed = withTerminalWidth(40, () =>
      renderSubagentResult!(
        {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "reviewer",
                task: longTask,
                exitCode: 0,
                messages: [],
                usage: emptyUsage,
              },
            ],
          },
        },
        { expanded: false },
        theme,
      )
        .render(40)
        .join("\n"),
    );

    const expanded = withTerminalWidth(40, () =>
      renderSubagentResult!(
        {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "reviewer",
                task: longTask,
                exitCode: 0,
                messages: [],
                usage: emptyUsage,
              },
            ],
          },
        },
        { expanded: true },
        theme,
      )
        .render(40)
        .join("\n"),
    );

    const unwrap = (text: string) => text.replace(/\s+/g, "");
    assert.doesNotMatch(unwrap(collapsed), /precisefailingtoolsequenceattheend\./);
    assert.match(unwrap(expanded), /precisefailingtoolsequenceattheend\./);
  });

  it("uses glyph-first compact rendering for completed subagents", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "reviewer",
              task: "review",
              exitCode: 0,
              messages: [],
              usage: { ...emptyUsage, turns: 2 },
              progressSummary: { toolCount: 3, tokens: 1200, durationMs: 1500 },
              sessionFile: "/tmp/session.jsonl",
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /^✓ reviewer/);
    assert.doesNotMatch(text, /⟳ 2|3 tool uses|1\.2k token|1\.5s/);
    assert.match(text, /⎿  Done/);
    assert.match(text, /session: \/tmp\/session\.jsonl/);
  });

  it("keeps failure reasons visible in compact rendering", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "failed" }],
        details: {
          mode: "single",
          results: [
            {
              agent: "reviewer",
              task: "review",
              exitCode: 1,
              error: "boom",
              messages: [],
              usage: emptyUsage,
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /^✗ reviewer/);
    assert.match(text, /⎿  Error: boom/);
  });

  it("shows live detail hints for running single subagents without leaking paths in compact mode", () => {
    const now = Date.now();
    const result = {
      content: [{ type: "text" as const, text: "(running...)" }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: "review [Write to: /tmp/configured-output.md]",
            exitCode: 0,
            messages: [],
            artifactPaths: {
              inputPath: "",
              outputPath: "/tmp/reviewer_output.md",
              jsonlPath: "",
              transcriptPath: "",
              metadataPath: "",
            },
            usage: emptyUsage,
            progress: {
              index: 0,
              agent: "reviewer",
              status: "running" as const,
              task: "review",
              lastActivityAt: now - 2_000,
              currentTool: "read",
              currentToolArgs: "package.json",
              currentToolStartedAt: now - 3_000,
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 42,
              durationMs: 3_000,
            },
          },
        ],
      },
    };

    const compactText = renderSubagentResult!(result, { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactText, new RegExp(liveDetailHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(compactText, /active 2s ago/);
    assert.match(compactText, /⎿  read: package\.json \| 3\.0s/);
    assert.doesNotMatch(compactText, /configured-output\.md/);
    assert.doesNotMatch(compactText, /reviewer_output\.md/);

    const expandedText = renderSubagentResult!(result, { expanded: true }, theme)
      .render(120)
      .join("\n");
    assert.match(expandedText, /Output: \/tmp\/configured-output\.md/);
    assert.equal((expandedText.match(/Artifacts: \/tmp\/reviewer_output\.md/g) ?? []).length, 1);
  });

  it("cycles the full attributed thinking pool per turn and suppresses it for active tools", () => {
    assert.equal(WHIMSICAL_THINKING_PHRASES.length, 453);
    const firstCycle = WHIMSICAL_THINKING_PHRASES.map((_, turn) => whimsicalThinkingPhrase(turn));
    const repeatedCycle = WHIMSICAL_THINKING_PHRASES.map((_, turn) =>
      whimsicalThinkingPhrase(turn),
    );
    assert.deepEqual(repeatedCycle, firstCycle);
    assert.notDeepEqual(firstCycle, [...WHIMSICAL_THINKING_PHRASES]);
    assert.notEqual(firstCycle[0], WHIMSICAL_THINKING_PHRASES[0]);
    assert.equal(new Set(firstCycle).size, WHIMSICAL_THINKING_PHRASES.length);
    assert.equal(whimsicalThinkingPhrase(WHIMSICAL_THINKING_PHRASES.length), firstCycle[0]);

    const snapshotNow = 10_000;
    const makeResult = (
      turnCount: number,
      currentTool?: string,
      activityState?: "needs_attention" | "active_long_running",
    ) => ({
      content: [{ type: "text" as const, text: "(running...)" }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: "review",
            exitCode: 0,
            messages: [],
            usage: { ...emptyUsage, turns: turnCount },
            progress: {
              index: 0,
              agent: "reviewer",
              status: "running" as const,
              task: "review",
              lastActivityAt: snapshotNow,
              ...(activityState ? { activityState } : {}),
              ...(currentTool ? { currentTool, currentToolStartedAt: snapshotNow - 2_000 } : {}),
              recentTools: [],
              recentOutput: [],
              toolCount: 3,
              tokens: 1_200,
              durationMs: 4_000,
              turnCount,
            },
          },
        ],
      },
    });

    const compact = renderSubagentResult!(makeResult(0), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compact, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(0))}`));
    assert.ok(compact.indexOf(whimsicalThinkingPhrase(0)) < compact.indexOf("active now"));
    assert.doesNotMatch(compact, /3 tool uses|1\.2k token|4\.0s|⟳ 0/);

    const next = renderSubagentResult!(makeResult(1), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(1))));
    assert.doesNotMatch(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(0))));

    const activeTool = renderSubagentResult!(makeResult(0, "read"), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(activeTool, /⎿  read \| 4\.0s/);
    assert.match(activeTool, /active 2s ago/);
    assert.doesNotMatch(activeTool, new RegExp(escapeRegExp(whimsicalThinkingPhrase(0))));

    const expanded = renderSubagentResult!(makeResult(2), { expanded: true }, theme)
      .render(120)
      .join("\n");
    assert.match(expanded, /3 tools, 1\.2k tok, 4\.0s/);
    assert.match(expanded, /2 turns/);

    for (const activityState of ["needs_attention", "active_long_running"] as const) {
      const warning = renderSubagentResult!(
        makeResult(0, undefined, activityState),
        { expanded: false },
        theme,
      )
        .render(120)
        .join("\n");
      assert.doesNotMatch(warning, new RegExp(escapeRegExp(whimsicalThinkingPhrase(0))));
      // The fixture's lastActivityAt is sub-second, so the health label carries no age clause here.
      // These strings stand in for "a health warning replaced the thinking phrase" on the activity line.
      assert.match(
        warning,
        activityState === "needs_attention" ? /⎿  needs attention/ : /⎿  active but long-running/,
      );
    }
  });

  it("keeps running compact result output stable when progress is unchanged", async () => {
    const result = {
      content: [{ type: "text" as const, text: "(running...)" }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: "review",
            exitCode: 0,
            messages: [],
            usage: emptyUsage,
            progress: {
              index: 0,
              agent: "reviewer",
              status: "running" as const,
              task: "review",
              lastActivityAt: 2_000,
              currentTool: "read",
              currentToolArgs: "package.json",
              currentToolStartedAt: 1_000,
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 42,
              durationMs: 3_000,
            },
          },
        ],
      },
    };
    const first = renderSubagentResult!(result, { expanded: false }, theme).render(120);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = renderSubagentResult!(result, { expanded: false }, theme).render(120);

    assert.deepEqual(second, first);
  });

  it("advances running compact result glyphs when progress changes", () => {
    const renderGlyph = (toolCount: number) =>
      firstGrapheme(
        renderSubagentResult!(
          {
            content: [{ type: "text", text: "(running...)" }],
            details: {
              mode: "single",
              results: [
                {
                  agent: "reviewer",
                  task: "review",
                  exitCode: 0,
                  messages: [],
                  usage: emptyUsage,
                  progress: {
                    index: 0,
                    agent: "reviewer",
                    status: "running",
                    task: "review",
                    recentTools: [],
                    recentOutput: [],
                    toolCount,
                    tokens: 0,
                    durationMs: 0,
                  },
                },
              ],
            },
          },
          { expanded: false },
          theme,
        ).render(120)[0] ?? "",
      );

    assert.notEqual(renderGlyph(1), renderGlyph(2));
  });

  it("sanitizes production truncation paths in compact success previews and failure fallbacks", () => {
    const fullOutputPath = "/tmp/reviewer_full_output.md";
    const truncation = truncateOutput(
      "first useful line\nsecond line",
      { bytes: 1024, lines: 1 },
      fullOutputPath,
    );
    const makeResult = (exitCode: number) => ({
      content: [{ type: "text" as const, text: exitCode === 0 ? "done" : "failed" }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: "review [Write to: /tmp/configured-output.md]",
            exitCode,
            messages: [],
            usage: emptyUsage,
            artifactPaths: {
              inputPath: "",
              outputPath: "/tmp/reviewer_output.md",
              jsonlPath: "",
              transcriptPath: "",
              metadataPath: "",
            },
            truncation,
          },
        ],
      },
    });

    const compactSuccess = renderSubagentResult!(makeResult(0), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactSuccess, /⎿  Done/);
    assert.match(compactSuccess, /TRUNCATED: showing first 1 of 2 lines/);
    assert.doesNotMatch(compactSuccess, /configured-output\.md/);
    assert.doesNotMatch(compactSuccess, /reviewer_output\.md/);
    assert.doesNotMatch(compactSuccess, /reviewer_full_output\.md/);

    const compactFailure = renderSubagentResult!(makeResult(1), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactFailure, /⎿  Error: \[TRUNCATED: showing first 1 of 2 lines/);
    assert.doesNotMatch(compactFailure, /reviewer_full_output\.md/);

    const expandedText = renderSubagentResult!(makeResult(0), { expanded: true }, theme)
      .render(120)
      .join("\n");
    assert.match(expandedText, /full output at \/tmp\/reviewer_full_output\.md/);
    assert.match(expandedText, /Output: \/tmp\/configured-output\.md/);
    assert.match(expandedText, /Artifacts: \/tmp\/reviewer_output\.md/);
    assert.match(expandedText, /Full output: \/tmp\/reviewer_full_output\.md/);
  });

  it("sanitizes production file-only references in compact previews while expanded keeps the path", () => {
    const outputPath = "/tmp/file-only-review.md";
    const fullOutput = "file-only report";
    const finalized = finalizeSingleOutput({
      fullOutput,
      outputPath,
      outputMode: "file-only",
      exitCode: 0,
      savedPath: outputPath,
    });
    const result = {
      content: [{ type: "text" as const, text: finalized.displayOutput }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: `review [Write to: ${outputPath}]`,
            exitCode: 0,
            messages: [],
            usage: emptyUsage,
            finalOutput: finalized.displayOutput,
            outputReference: finalized.outputReference,
            savedOutputPath: finalized.savedPath,
          },
        ],
      },
    };

    const compactText = renderSubagentResult!(result, { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactText, /Output saved \(16 B, 1 line\)\. Read this file if needed\./);
    assert.doesNotMatch(compactText, /file-only-review\.md/);

    const expandedText = renderSubagentResult!(result, { expanded: true }, theme)
      .render(120)
      .join("\n");
    assert.match(expandedText, /Output: \/tmp\/file-only-review\.md/);
    assert.match(expandedText, /Output saved to: \/tmp\/file-only-review\.md/);
  });

  it("sanitizes production output-save errors in compact previews while expanded keeps details", () => {
    const outputPath = "/tmp/unwritable-review.md";
    const finalized = finalizeSingleOutput({
      fullOutput: "",
      outputPath,
      exitCode: 0,
      saveError: "permission denied",
    });
    const result = {
      content: [{ type: "text" as const, text: finalized.displayOutput }],
      details: {
        mode: "single" as const,
        results: [
          {
            agent: "reviewer",
            task: `review [Write to: ${outputPath}]`,
            exitCode: 0,
            messages: [],
            usage: emptyUsage,
            finalOutput: finalized.displayOutput,
            outputSaveError: finalized.saveError,
          },
        ],
      },
    };

    const compactText = renderSubagentResult!(result, { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactText, /Output file error \(expand for details\)/);
    assert.doesNotMatch(compactText, /unwritable-review\.md/);

    const expandedText = renderSubagentResult!(result, { expanded: true }, theme)
      .render(120)
      .join("\n");
    assert.match(expandedText, /Output file error: \/tmp\/unwritable-review\.md/);
    assert.match(expandedText, /permission denied/);
  });

  it("keeps paused multi-result runs visible in the compact headline", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "paused" }],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "worker",
              task: "pause",
              exitCode: 0,
              interrupted: true,
              messages: [],
              usage: emptyUsage,
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /^■ parallel/);
    assert.match(text, /⎿  Paused/);
  });

  it("keeps empty-output warnings visible in compact multi-result rendering", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "worker",
              task: "check without output target",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /⎿  Done \(no text output\)/);
    assert.doesNotMatch(text, /0ms/);
  });

  it("keeps pending placeholder steps pending in compact rendering", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          mode: "parallel",
          totalSteps: 2,
          results: [
            {
              agent: "a",
              task: "first",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
              progress: {
                index: 0,
                agent: "a",
                status: "running",
                task: "first",
                recentTools: [],
                recentOutput: [],
                toolCount: 0,
                tokens: 0,
                durationMs: 0,
              },
            },
            {
              agent: "b",
              task: "second",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
              progress: {
                index: 1,
                agent: "b",
                status: "pending",
                task: "second",
                recentTools: [],
                recentOutput: [],
                toolCount: 0,
                tokens: 0,
                durationMs: 0,
              },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const lines = widget.render(120);
    const pendingIndex = lines.findIndex((line) => /Agent 2\/2: b/.test(line));
    assert.notEqual(pendingIndex, -1);
    assert.match(lines[pendingIndex]!, /◦ Agent 2\/2: b · pending/);
    assert.doesNotMatch(lines[pendingIndex]!, /0ms/);
    assert.doesNotMatch(lines[pendingIndex + 1] ?? "", /Done \(no text output\)/);
  });

  it("hides compact multi output paths while expanded keeps them", () => {
    const result = {
      content: [{ type: "text" as const, text: "done" }],
      details: {
        mode: "parallel" as const,
        totalSteps: 2,
        results: [
          {
            agent: "scout",
            task: "scan [Write to: /tmp/scout-configured-output.md]",
            exitCode: 0,
            messages: [],
            usage: emptyUsage,
            artifactPaths: {
              inputPath: "",
              outputPath: "/tmp/scout-output.md",
              jsonlPath: "",
              transcriptPath: "",
              metadataPath: "",
            },
            truncation: {
              text: "trimmed scout output",
              artifactPath: "/tmp/scout-full-output.md",
              truncated: true,
            },
            progressSummary: { toolCount: 1, tokens: 0, durationMs: 1 },
          },
          {
            agent: "reviewer",
            task: "review [Write to: /tmp/reviewer-configured-output.md]",
            exitCode: 0,
            messages: [],
            usage: emptyUsage,
            artifactPaths: {
              inputPath: "",
              outputPath: "/tmp/reviewer-output.md",
              jsonlPath: "",
              transcriptPath: "",
              metadataPath: "",
            },
            progress: {
              index: 1,
              agent: "reviewer",
              status: "running" as const,
              task: "review",
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 0,
              durationMs: 1,
            },
          },
        ],
        progress: [
          {
            index: 1,
            agent: "reviewer",
            status: "running" as const,
            task: "review",
            recentTools: [],
            recentOutput: [],
            toolCount: 1,
            tokens: 0,
            durationMs: 1,
          },
        ],
      },
    };

    const compactText = renderSubagentResult!(result, { expanded: false }, theme)
      .render(140)
      .join("\n");
    assert.doesNotMatch(compactText, /configured-output\.md/);
    assert.doesNotMatch(compactText, /scout-output\.md/);
    assert.doesNotMatch(compactText, /reviewer-output\.md/);
    assert.doesNotMatch(compactText, /scout-full-output\.md/);

    const expandedText = renderSubagentResult!(result, { expanded: true }, theme)
      .render(140)
      .join("\n");
    assert.match(expandedText, /output: \/tmp\/scout-configured-output\.md/);
    assert.match(expandedText, /artifacts: \/tmp\/scout-output\.md/);
    assert.match(expandedText, /full output: \/tmp\/scout-full-output\.md/);
    assert.match(expandedText, /output: \/tmp\/reviewer-configured-output\.md/);
    assert.equal((expandedText.match(/artifacts: \/tmp\/reviewer-output\.md/g) ?? []).length, 1);
  });

  it("uses spinner/done wording and agent fractions for live parallel rendering", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "(running...)" }],
        details: {
          mode: "parallel",
          totalSteps: 3,
          results: [
            {
              agent: "worker",
              task: "third task",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
              progress: {
                index: 2,
                agent: "worker",
                status: "running",
                task: "third task",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
          ],
          progress: [
            {
              index: 0,
              agent: "scout",
              status: "running",
              task: "first",
              recentTools: [],
              recentOutput: [],
              toolCount: 0,
              tokens: 0,
              durationMs: 10,
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /parallel · 0\/3 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.match(text, /Agent 3\/3: worker/);
    assert.doesNotMatch(text, /Step 3: worker/);
    assert.doesNotMatch(text, /Agent 1: worker/);
  });

  it("shows mixed done/running counters for top-level parallel mode", () => {
    const widget = renderSubagentResult!(
      {
        content: [{ type: "text", text: "(running...)" }],
        details: {
          mode: "parallel",
          totalSteps: 3,
          results: [
            {
              agent: "scout",
              task: "first",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
              progress: {
                index: 0,
                agent: "scout",
                status: "completed",
                task: "first",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
            {
              agent: "reviewer",
              task: "second",
              exitCode: 0,
              messages: [],
              usage: emptyUsage,
              progress: {
                index: 1,
                agent: "reviewer",
                status: "running",
                task: "second",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 0,
                durationMs: 10,
              },
            },
          ],
          progress: [
            {
              index: 0,
              agent: "scout",
              status: "completed",
              task: "first",
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 0,
              durationMs: 10,
            },
            {
              index: 1,
              agent: "reviewer",
              status: "running",
              task: "second",
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 0,
              durationMs: 10,
            },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = widget.render(120).join("\n");
    assert.match(text, /parallel · 1\/3 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
  });
});
