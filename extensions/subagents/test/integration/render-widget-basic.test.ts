import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AsyncJobState } from "../support/render-widget-fixtures.ts";
import {
  assertWrappedSource,
  buildWidgetLines,
  createSubagentLiveDetailController,
  createUiContext,
  createWidgetTestIsolation,
  createWidgetTheme,
  escapeRegExp,
  firstGrapheme,
  firstRunningGlyph,
  outputPathPattern,
  renderWidget,
  renderWidgetLines,
  runningGlyphPattern,
  visibleWidth,
  whimsicalThinkingPhrase,
  WHIMSICAL_THINKING_PHRASES,
  withStdoutSize,
} from "../support/render-widget-fixtures.ts";

const theme = createWidgetTheme();
const widgetTestIsolation = createWidgetTestIsolation(theme);
beforeEach(widgetTestIsolation.beforeEach);
afterEach(widgetTestIsolation.afterEach);
const resetWidgetLayout = widgetTestIsolation.resetWidgetLayout;
const useDefaultKeybindings = widgetTestIsolation.useDefaultKeybindings;

describe("subagent async widget rendering", () => {
  it("orders running jobs before queued summaries and completions", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "done-1",
          asyncDir: "/tmp/done",
          status: "complete",
          agents: ["reviewer"],
          startedAt: 0,
          updatedAt: 1000,
        },
        {
          asyncId: "queued-1",
          asyncDir: "/tmp/queued",
          status: "queued",
          agents: ["planner"],
          startedAt: 0,
          updatedAt: 1000,
        },
        {
          asyncId: "run-1",
          asyncDir: "/tmp/run",
          status: "running",
          agents: ["scout"],
          currentStep: 0,
          stepsTotal: 2,
          startedAt: Date.now() - 1000,
          updatedAt: Date.now(),
          currentTool: "read",
          currentToolStartedAt: Date.now() - 500,
        },
      ],
      theme,
      120,
    );

    const text = lines.join("\n");
    assert.match(text, new RegExp(`^${runningGlyphPattern} Async agents(?:\\n|$)`));
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.ok(
      text.indexOf("scout") < text.indexOf("queued"),
      "running row should precede queued summary",
    );
    assert.ok(
      text.indexOf("queued") < text.indexOf("reviewer"),
      "queued summary should precede completions",
    );
    assert.match(text, /⎿  read/);
  });

  it("keeps simultaneous single-job summaries free of step terminology", () => {
    const now = Date.now();
    const text = buildWidgetLines(
      [
        {
          asyncId: "single-first",
          asyncDir: "/tmp/single-first",
          status: "running",
          mode: "single",
          agents: ["first"],
          currentStep: 0,
          stepsTotal: 1,
          turnCount: 5,
          toolCount: 1,
          totalTokens: { input: 8000, output: 4000, total: 12_000 },
          lastActivityAt: now,
          startedAt: now - 2000,
          updatedAt: now,
        },
        {
          asyncId: "single-second",
          asyncDir: "/tmp/single-second",
          status: "running",
          mode: "single",
          agents: ["second"],
          currentStep: 0,
          stepsTotal: 1,
          turnCount: 6,
          toolCount: 2,
          lastActivityAt: now - 2_000,
          startedAt: now - 3000,
          updatedAt: now,
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.match(text, /first/);
    assert.match(text, /second/);
    assert.match(
      text,
      new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(5))}\\n[^\\n]*active now`),
    );
    assert.match(
      text,
      new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(6))}\\n[^\\n]*active 2s ago`),
    );
    assert.doesNotMatch(
      text,
      /5 turns|6 turns|1 tool use|2 tool uses|12k token|3\.0s|\bsteps?\b|\bchain\b/i,
    );
  });

  it("shows the resolved tk ticket title before the live-detail hint", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-ticket",
          asyncDir: "/tmp/run-ticket",
          status: "running",
          mode: "single",
          agents: ["worker"],
          tkTicket: { id: "psr-raw4", title: "Show active tk title" },
          steps: [{ index: 0, agent: "worker", status: "running", currentTool: "read" }],
          stepsTotal: 1,
          startedAt: Date.now() - 1000,
          updatedAt: Date.now(),
        },
      ],
      theme,
      160,
    );

    const text = lines.join("\n");
    assert.match(text, /ticket: Show active tk title/);
    // Ticket line must appear after the step identity row and before the activity/hint.
    assert.ok(
      text.indexOf("worker") < text.indexOf("ticket: Show active tk title"),
      "ticket line should appear after the agent identity row",
    );
    assert.ok(
      text.indexOf("ticket: Show active tk title") <
        text.indexOf("Press Ctrl+Shift+D for live detail"),
      "ticket line should appear before the live-detail hint",
    );
    assert.ok(
      text.indexOf("ticket: Show active tk title") < text.indexOf("⎿  read"),
      "ticket line should appear before the activity line",
    );
    assert.equal(
      text.match(/ticket: Show active tk title/g)?.length,
      1,
      "ticket line should appear exactly once",
    );
  });

  it("shows the tk ticket title for mixed parallel layouts before live detail", () => {
    const text = buildWidgetLines(
      [
        {
          asyncId: "run-parallel-ticket",
          asyncDir: "/tmp/run-parallel-ticket",
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer", "writer"],
          runningSteps: 1,
          completedSteps: 2,
          tkTicket: { id: "psr-raw4", title: "Show active tk title" },
          currentStep: 2,
          stepsTotal: 3,
          steps: [
            { index: 0, agent: "scout", status: "complete" },
            { index: 1, agent: "reviewer", status: "complete" },
            { index: 2, agent: "writer", status: "running", currentTool: "read" },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.match(text, /ticket: Show active tk title/);
    assert.match(text, /2\/3 done/);
    assert.ok(
      text.indexOf("ticket: Show active tk title") <
        text.indexOf("Press Ctrl+Shift+D for live detail"),
    );
    assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
  });

  it("shows tk ticket titles once in active multi-job rows before live detail", () => {
    const text = buildWidgetLines(
      [
        {
          asyncId: "run-ticket",
          asyncDir: "/tmp/run-ticket",
          status: "running",
          mode: "parallel",
          agents: ["ticketed"],
          tkTicket: { id: "psr-raw4", title: "Show active tk title" },
          steps: [{ index: 0, agent: "ticketed", status: "running", currentTool: "read" }],
          stepsTotal: 1,
        },
        {
          asyncId: "run-plain",
          asyncDir: "/tmp/run-plain",
          status: "running",
          mode: "parallel",
          agents: ["plain"],
          steps: [{ index: 0, agent: "plain", status: "running", currentTool: "grep" }],
          stepsTotal: 1,
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
    assert.doesNotMatch(text, /plain[\s\S]*ticket:/);
    assert.ok(text.indexOf("ticket: Show active tk title") < text.indexOf("⎿  read"));
  });

  it("uses spinner and done wording for async parallel jobs", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/1",
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer", "worker"],
          runningSteps: 3,
          completedSteps: 0,
          stepsTotal: 3,
        },
      ],
      theme,
      120,
    );

    const text = lines.join("\n");
    assert.match(text, /0\/3 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.match(text, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(0))}`));
    assert.doesNotMatch(text, /parallel · scout, reviewer, worker/);
    assert.doesNotMatch(text, /step 1\/3/);
  });

  it("collapses repeated async parallel agent names", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/1",
          status: "running",
          mode: "parallel",
          agents: ["reviewer", "reviewer", "reviewer"],
          runningSteps: 3,
          completedSteps: 0,
          stepsTotal: 3,
        },
      ],
      theme,
      120,
    );

    const text = lines.join("\n");
    assert.match(text, /0\/3 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.doesNotMatch(text, /parallel · reviewer ×3/);
    assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
  });

  it("keeps parallel aggregate rows free of step terminology", () => {
    const text = buildWidgetLines(
      [
        {
          asyncId: "parallel-pending",
          asyncDir: "/tmp/parallel-pending",
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer"],
          currentStep: 0,
          stepsTotal: 2,
        },
      ],
      theme,
      140,
    ).join("\n");

    assert.match(text, /async subagents \(2\)/);
    assert.match(text, /0\/2 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.doesNotMatch(text, /\bsteps?\b|\bchain\b/i);
  });

  it("keeps expanded async widgets on the full-detail path", () => {
    resetWidgetLayout();
    withStdoutSize(20, 120, () => {
      const ui = createUiContext();
      const liveDetailController = createSubagentLiveDetailController(true);
      renderWidget(
        ui.ctx as never,
        [
          {
            asyncId: "run-expanded",
            asyncDir: "/tmp/run-expanded",
            status: "running",
            mode: "parallel",
            agents: ["reviewer"],
            runningSteps: 1,
            completedSteps: 0,
            stepsTotal: 1,
            steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
          },
        ],
        liveDetailController,
      );

      const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(text, /async subagents \(1\)/);
      assert.match(text, /Agent 1\/1: reviewer/);
      assert.doesNotMatch(text, /· running\b/);
      assert.doesNotMatch(text, /subagents \(1\/1 running\)/);
    });
    resetWidgetLayout();
  });

  it("shows per-agent detail for active async parallel widget rows", () => {
    const now = Date.now();
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/1",
          status: "running",
          mode: "parallel",
          agents: ["reviewer", "reviewer", "reviewer"],
          runningSteps: 2,
          completedSteps: 1,
          stepsTotal: 3,
          updatedAt: now,
          steps: [
            { agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
            {
              agent: "reviewer",
              status: "running",
              currentTool: "read",
              currentToolStartedAt: now - 2000,
            },
            {
              agent: "reviewer",
              status: "complete",
              tokens: { input: 1000, output: 500, total: 1500 },
            },
          ],
        },
      ],
      theme,
      160,
    );

    const text = lines.join("\n");
    assert.match(text, /async subagents \(3\)/);
    assert.match(text, /1\/3 done/);
    assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
    assert.match(
      text,
      new RegExp(
        `Agent 1/3: reviewer\\n\\s+⎿  ${escapeRegExp(whimsicalThinkingPhrase(0))}\\n\\s+active now`,
      ),
    );
    assert.match(text, /Agent 2\/3: reviewer[\s\S]*⎿  read \| 2\.0s/);
    assert.match(text, /Press Ctrl\+Shift\+D for live detail/);
    assert.match(text, /Agent 3\/3: reviewer · complete/);
    assert.doesNotMatch(text, /2 tool uses|1\.5k token/);
  });

  it("preserves freshness for compact parallel details in narrow multi-job rows", () => {
    const now = 20_000;
    const lines = buildWidgetLines(
      [
        {
          asyncId: "parallel-narrow",
          asyncDir: "/tmp/parallel-narrow",
          status: "running",
          mode: "parallel",
          agents: ["reviewer", "reviewer"],
          runningSteps: 1,
          completedSteps: 1,
          stepsTotal: 2,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "reviewer",
              status: "running",
              turnCount: 19,
              lastActivityAt: now - 2_000,
            },
            { index: 1, agent: "reviewer", status: "complete" },
          ],
        },
        {
          asyncId: "other-job",
          asyncDir: "/tmp/other-job",
          status: "complete",
          mode: "single",
          agents: ["other"],
          updatedAt: now,
        },
      ],
      theme,
      60,
    );

    const row = lines.find((line) => line.includes("Agent 1/2")) ?? "";
    assert.match(row, /Agent 1\/2: reviewer/);
    assertWrappedSource(lines, whimsicalThinkingPhrase(19));
    assertWrappedSource(lines, "active 2s ago");
    assert.ok(lines.every((line) => visibleWidth(line) <= 58));
  });

  it("shows model and thinking for active async widget rows", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/1",
          status: "running",
          mode: "parallel",
          agents: ["reviewer", "scout"],
          runningSteps: 2,
          completedSteps: 0,
          stepsTotal: 2,
          steps: [
            { agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
            {
              agent: "scout",
              status: "running",
              model: "anthropic/claude-haiku-4-5",
              thinking: "low",
            },
          ],
        },
      ],
      theme,
      180,
    );

    const text = lines.join("\n");
    assert.match(text, /Agent 1\/2: reviewer \(gpt-5\.5 · thinking high\)/);
    assert.match(text, /Agent 2\/2: scout \(claude-haiku-4-5 · thinking low\)/);
    assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
    assert.doesNotMatch(text, /gpt-5\.5:high/);
  });

  it("cycles compact async thinking phrases per turn while expanded rows retain telemetry", () => {
    assert.equal(WHIMSICAL_THINKING_PHRASES.length, 453);
    const now = Date.now();
    const job: AsyncJobState = {
      asyncId: "run-thinking",
      asyncDir: "/tmp/thinking",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      startedAt: now - 7_000,
      updatedAt: now,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          lastActivityAt: now,
          turnCount: 5,
          toolCount: 18,
          tokens: { input: 30_000, output: 10_000, total: 44_000 },
          durationMs: 7_000,
        },
      ],
    };

    const collapsed = buildWidgetLines([job], theme, 180).join("\n");
    assert.match(
      collapsed,
      new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(5))}\\n\\s+active now`),
    );
    assert.doesNotMatch(collapsed, /5 turns|18 tool uses|44k token|7\.0s/);

    const next = buildWidgetLines(
      [{ ...job, steps: [{ ...job.steps![0]!, turnCount: 6 }] }],
      theme,
      180,
    ).join("\n");
    assert.match(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(6))));
    assert.doesNotMatch(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(5))));

    const expanded = buildWidgetLines([job], theme, 180, true).join("\n");
    assert.match(expanded, /5 turns · 18 tool uses · 44k token · 7\.0s/);
    assert.match(expanded, /active now/);

    const activeTool = buildWidgetLines(
      [
        {
          ...job,
          steps: [{ ...job.steps![0]!, currentTool: "read", currentToolStartedAt: now - 2_000 }],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(activeTool, /read \| 2\.0s/);
    assert.doesNotMatch(activeTool, new RegExp(escapeRegExp(whimsicalThinkingPhrase(5))));
  });

  it("keeps async row status visible before long model badges on narrow widgets", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/1",
          status: "running",
          mode: "parallel",
          agents: ["reviewer"],
          runningSteps: 1,
          completedSteps: 0,
          stepsTotal: 1,
          steps: [
            {
              agent: "reviewer",
              status: "running",
              model: "anthropic/claude-opus-4-5-20260501-super-long-model-name:high",
            },
          ],
        },
      ],
      theme,
      68,
    );

    const row = lines.find((line) => line.includes("Agent 1/1")) ?? "";
    assert.match(row, /Agent 1\/1: reviewer/);
    assert.doesNotMatch(row, /Agent 1\/1: reviewer \(/);
  });

  it("shows inline live detail for expanded async parallel widget rows", () => {
    const now = Date.now();
    const job: AsyncJobState = {
      asyncId: "run-1",
      asyncDir: "/tmp/1",
      status: "running",
      mode: "parallel",
      agents: ["reviewer"],
      runningSteps: 1,
      completedSteps: 0,
      stepsTotal: 1,
      updatedAt: now,
      steps: [
        {
          index: 0,
          agent: "reviewer",
          status: "running",
          currentTool: "read",
          currentToolArgs: "src/tui/render.ts",
          currentToolStartedAt: now - 2000,
          recentTools: [{ tool: "grep", args: "async widget", endMs: now - 3000 }],
          recentOutput: ["found renderWidget", "checking expanded state"],
        },
      ],
    };

    const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
    assert.match(collapsedText, /Press Ctrl\+Shift\+D for live detail/);
    assert.doesNotMatch(collapsedText, outputPathPattern("/tmp/1/output-0.log"));
    assert.doesNotMatch(collapsedText, /found renderWidget/);

    const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
    assert.doesNotMatch(expandedText, /Press Configured\+Expand\+Key for live detail/);
    assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
    assert.match(expandedText, outputPathPattern("/tmp/1/output-0.log"));
    assert.match(expandedText, /grep: async widget/);
    assert.match(expandedText, /found renderWidget/);
    assert.match(expandedText, /checking expanded state/);
  });

  it("shows a generic title and one unnumbered agent summary for running single async jobs", () => {
    const now = Date.now();
    const job: AsyncJobState = {
      asyncId: "single-run",
      asyncDir: "/tmp/single-run",
      status: "running",
      mode: "single",
      agents: ["developer"],
      stepsTotal: 1,
      startedAt: now - 4000,
      updatedAt: now,
      steps: [
        {
          index: 0,
          agent: "developer",
          status: "running",
          model: "openai-codex/gpt-5.5:high",
          thinking: "high",
          turnCount: 2,
          toolCount: 3,
          tokens: { input: 8_000, output: 4_000, total: 12_000 },
          currentTool: "read",
          currentToolArgs: "src/tui/render.ts",
          currentToolStartedAt: now - 2000,
          recentOutput: ["reading render widget"],
        },
      ],
    };

    const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
    assert.match(collapsedText, /async subagent/);
    assert.match(
      collapsedText,
      new RegExp(`${runningGlyphPattern} developer \\(gpt-5\\.5 · thinking high\\)`),
    );
    assert.doesNotMatch(collapsedText, /2 turns|3 tool uses|12k token|4\.0s/);
    assert.match(collapsedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
    assert.match(collapsedText, /Press Ctrl\+Shift\+D for live detail/);
    assert.doesNotMatch(collapsedText, /(?:Agent|Step) 1\/1/);
    assert.doesNotMatch(collapsedText, outputPathPattern("/tmp/single-run/output-0.log"));
    assert.doesNotMatch(collapsedText, /reading render widget/);

    const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
    assert.match(expandedText, /developer \(gpt-5\.5 · thinking high\)/);
    assert.doesNotMatch(expandedText, /(?:Agent|Step) 1\/1/);
    assert.doesNotMatch(expandedText, /Press Configured\+Expand\+Key for live detail/);
    assert.match(expandedText, outputPathPattern("/tmp/single-run/output-0.log"));
    assert.match(expandedText, /reading render widget/);

    useDefaultKeybindings();
    const fallbackText = buildWidgetLines([job], theme, 180).join("\n");
    assert.match(fallbackText, /Press Ctrl\+Shift\+D for live detail/);
    assert.doesNotMatch(fallbackText, /Press Ctrl\+O for live detail/);
  });

  it("does not duplicate job elapsed time when a terminal single step has duration", () => {
    const now = Date.now();
    const text = buildWidgetLines(
      [
        {
          asyncId: "single-complete",
          asyncDir: "/tmp/single-complete",
          status: "complete",
          mode: "single",
          agents: ["developer"],
          stepsTotal: 1,
          startedAt: now - 9000,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "developer",
              status: "complete",
              toolCount: 3,
              durationMs: 4000,
            },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.doesNotMatch(text, /\b4\.0s\b|\b9\.0s\b/);
    const expanded = buildWidgetLines(
      [
        {
          asyncId: "single-complete",
          asyncDir: "/tmp/single-complete",
          status: "complete",
          mode: "single",
          agents: ["developer"],
          stepsTotal: 1,
          startedAt: now - 9000,
          updatedAt: now,
          steps: [
            { index: 0, agent: "developer", status: "complete", toolCount: 3, durationMs: 4000 },
          ],
        },
      ],
      theme,
      180,
      true,
    ).join("\n");
    assert.equal(expanded.match(/\b4\.0s\b/g)?.length, 1);
    assert.doesNotMatch(expanded, /\b9\.0s\b/);
  });

  it("uses terminal job status when a retained single step still reports running", () => {
    const now = Date.now();
    const job: AsyncJobState = {
      asyncId: "single-terminal-before-step-refresh",
      asyncDir: "/tmp/single-terminal-before-step-refresh",
      status: "complete",
      mode: "single",
      agents: ["developer"],
      stepsTotal: 1,
      startedAt: now - 9000,
      updatedAt: now,
      steps: [
        {
          index: 0,
          agent: "developer",
          status: "running",
          model: "openai-codex/gpt-5.5:high",
          thinking: "high",
          turnCount: 2,
          toolCount: 3,
          tokens: { input: 8_000, output: 4_000, total: 12_000 },
          currentTool: "read",
          currentToolArgs: "src/tui/render.ts",
          currentToolStartedAt: now - 2000,
          recentTools: [{ tool: "grep", args: "stale detail", endMs: now - 1000 }],
          recentOutput: ["stale live output"],
          children: [
            {
              id: "retained-child",
              parentRunId: "single-terminal-before-step-refresh",
              parentStepIndex: 0,
              depth: 1,
              path: [{ runId: "single-terminal-before-step-refresh", stepIndex: 0 }],
              state: "complete",
              agent: "retained-child",
              lastUpdate: now,
            },
          ],
        },
      ],
    };

    for (const [status, glyph] of [
      ["complete", "✓"],
      ["failed", "✗"],
    ] as const) {
      const collapsedText = buildWidgetLines([{ ...job, status }], theme, 180).join("\n");
      assert.match(
        collapsedText,
        new RegExp(`${glyph} developer · ${status} \\(gpt-5\\.5 · thinking high\\)`),
      );
      assert.doesNotMatch(collapsedText, /2 turns|3 tool uses|12k token|9\.0s/);
      assert.doesNotMatch(collapsedText, /developer · running/);
      assert.doesNotMatch(
        collapsedText,
        /Press (?:Configured\+Expand\+Key|Ctrl\+O) for live detail/,
      );

      const expandedText = buildWidgetLines([{ ...job, status }], theme, 180, true).join("\n");
      assert.match(expandedText, /2 turns · 3 tool uses · 12k token/);
      assert.match(expandedText, /retained-child · complete/);
      assert.doesNotMatch(expandedText, /output-0\.log|stale detail|stale live output|⎿  read/);
    }
  });

  it("keeps a generic status and activity fallback for single async jobs without steps", () => {
    const now = Date.now();
    useDefaultKeybindings();
    const text = buildWidgetLines(
      [
        {
          asyncId: "single-no-steps",
          asyncDir: "/tmp/single-no-steps",
          status: "running",
          mode: "single",
          agents: ["worker"],
          currentStep: 0,
          toolCount: 2,
          totalTokens: { input: 3000, output: 2000, total: 5000 },
          currentTool: "read",
          currentToolStartedAt: now - 1000,
          startedAt: now - 3000,
          updatedAt: now,
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.match(text, /async subagent/);
    assert.match(text, new RegExp(`${runningGlyphPattern} worker`));
    assert.doesNotMatch(text, /· running\b/);
    assert.doesNotMatch(text, /2 tool uses|5\.0k token|3\.0s/);
    assert.match(text, /⎿  read 1\.0s/);
    assert.doesNotMatch(text, /\bsteps?\b|\bchain\b/i);
    assert.doesNotMatch(text, /Press Configured\+Expand\+Key for live detail/);
  });

  it("omits zero-running labels for pending active async parallel jobs", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "parallel-pending",
          asyncDir: "/tmp/parallel-pending",
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer", "worker"],
          runningSteps: 0,
          completedSteps: 0,
          stepsTotal: 3,
        },
      ],
      theme,
      180,
    );

    const text = lines.join("\n");
    assert.match(text, /0\/3 done/);
    assert.doesNotMatch(text, /0 agents running/);
    assert.doesNotMatch(text, /chain|parallel group/i);
  });

  it("shows explicit overflow counts for hidden work", () => {
    const lines = buildWidgetLines(
      [
        { asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["a1"] },
        { asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
        { asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
        { asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
        { asyncId: "run-5", asyncDir: "/tmp/5", status: "running", agents: ["a5"] },
      ],
      theme,
      120,
    );

    assert.match(lines.join("\n"), /\+1 more/);
    assert.doesNotMatch(lines.join("\n"), /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
  });

  it("counts hidden queued work even when a visible running agent name contains queued", () => {
    const lines = buildWidgetLines(
      [
        { asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["queued-scanner"] },
        { asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
        { asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
        { asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
        { asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["planner"] },
      ],
      theme,
      120,
    );

    assert.match(lines.join("\n"), /\+1 more \(1 queued\)/);
  });

  it("advances running widget glyphs when progress seed changes", () => {
    const first = buildWidgetLines(
      [
        {
          asyncId: "run-progress",
          asyncDir: "/tmp/run",
          status: "running",
          agents: ["worker"],
          updatedAt: 11,
        },
        {
          asyncId: "run-other",
          asyncDir: "/tmp/other",
          status: "running",
          agents: ["scout"],
          updatedAt: 0,
        },
      ],
      theme,
      120,
    );
    const second = buildWidgetLines(
      [
        {
          asyncId: "run-progress",
          asyncDir: "/tmp/run",
          status: "running",
          agents: ["worker"],
          updatedAt: 12,
        },
        {
          asyncId: "run-other",
          asyncDir: "/tmp/other",
          status: "running",
          agents: ["scout"],
          updatedAt: 0,
        },
      ],
      theme,
      120,
    );

    assert.notEqual(
      firstGrapheme(first[0] ?? ""),
      firstGrapheme(second[0] ?? ""),
      "header glyph should advance from changed progress",
    );
    assert.notEqual(
      firstRunningGlyph(first[1] ?? ""),
      firstRunningGlyph(second[1] ?? ""),
      "job glyph should advance from changed progress",
    );

    const firstStep = buildWidgetLines(
      [
        {
          asyncId: "run-step-progress",
          asyncDir: "/tmp/run-step",
          status: "running",
          agents: ["worker"],
          stepsTotal: 1,
          updatedAt: 20,
          steps: [{ agent: "worker", status: "running", currentToolStartedAt: 10 }],
        },
      ],
      theme,
      120,
    );
    const secondStep = buildWidgetLines(
      [
        {
          asyncId: "run-step-progress",
          asyncDir: "/tmp/run-step",
          status: "running",
          agents: ["worker"],
          stepsTotal: 1,
          updatedAt: 20,
          steps: [{ agent: "worker", status: "running", currentToolStartedAt: 11 }],
        },
      ],
      theme,
      120,
    );
    assert.notEqual(
      firstRunningGlyph(firstStep.find((line) => line.includes("Step 1/1")) ?? ""),
      firstRunningGlyph(secondStep.find((line) => line.includes("Step 1/1")) ?? ""),
      "step glyph should advance from changed step progress",
    );
  });

  it("keeps running widget output stable when progress seed is unchanged", async () => {
    const job: AsyncJobState = {
      asyncId: "run-stable",
      asyncDir: "/tmp/run",
      status: "running",
      agents: ["worker"],
      startedAt: 1_000,
      updatedAt: 3_000,
      currentTool: "read",
      currentToolStartedAt: 2_000,
      lastActivityAt: 2_500,
    };
    const first = buildWidgetLines([job], theme, 120);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = buildWidgetLines([job], theme, 120);

    assert.deepEqual(second, first);
    assert.equal(firstGrapheme(first[1] ?? ""), firstGrapheme(second[1] ?? ""));
  });
});
