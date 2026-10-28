import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlainTheme } from "../support/themes.ts";
import { finalizeSingleOutput } from "../../src/runs/shared/single-output.ts";
import { liveDetailShortcutDisplay } from "../../src/shared/subagent-shortcuts.ts";
import { truncateOutput, type Details, type SubagentToolResult } from "../../src/shared/types.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";

const theme = createPlainTheme();

const expandKey = liveDetailShortcutDisplay();
const expandHint = `Press ${expandKey} for full output`;
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

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

describe("renderSubagentResult", () => {
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
    renderSubagentResult!(
      {
        content: [{ type: "text", text: "First line\nSecond line" }],
        details: { mode: "single", results: [] },
      },
      { expanded: false },
      styledTheme,
    ).render(120);
    assert.deepEqual(hintStyles, ["dim"]);
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
    assert.match(text, /^ {4}Done \(no text output\)\s*$/m);
    assert.doesNotMatch(text, /⎿/);
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
    assert.match(text, /Error: boom/);
    assert.doesNotMatch(text, /⎿/);
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
    assert.match(compactSuccess, /Done/);
    assert.doesNotMatch(compactSuccess, /⎿/);
    assert.match(compactSuccess, /TRUNCATED: showing first 1 of 2 lines/);
    assert.doesNotMatch(compactSuccess, /configured-output\.md/);
    assert.doesNotMatch(compactSuccess, /reviewer_output\.md/);
    assert.doesNotMatch(compactSuccess, /reviewer_full_output\.md/);

    const compactFailure = renderSubagentResult!(makeResult(1), { expanded: false }, theme)
      .render(120)
      .join("\n");
    assert.match(compactFailure, /Error: \[TRUNCATED: showing first 1 of 2 lines/);
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
    assert.match(text, /^ {6}Paused\s*$/m);
    assert.doesNotMatch(text, /⎿/);
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
    assert.match(text, /^ {6}Done \(no text output\)\s*$/m);
    assert.doesNotMatch(text, /⎿/);
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
});
