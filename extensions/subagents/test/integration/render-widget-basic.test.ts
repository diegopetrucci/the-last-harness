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
    const now = Date.now();
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
          startedAt: now - 1000,
          updatedAt: now,
          currentTool: "read",
          currentToolStartedAt: now - 500,
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
    assert.match(text, /^│ {8}read 500ms\s*$/m);
    assert.match(text, /^ {9}Done\s*$/m);
    assert.doesNotMatch(text, /⎿/);
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
    // Both jobs have elapsed < 8 s
    //
    // Time-based slot = floor(elapsedMs / PHRASE_HOLD_MS): both land on slot 0,
    // which is the same phrase index as turnCount 0.
    const slot0Phrase = whimsicalThinkingPhrase(0);
    assert.match(text, new RegExp(`^│ {8}${escapeRegExp(slot0Phrase)}$\\n^│ {8}active now$`, "m"));
    assert.match(text, new RegExp(`^ {9}${escapeRegExp(slot0Phrase)}$\\n^ {9}active 2s ago$`, "m"));
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
    const ticketRowIndex = lines.findIndex((line) =>
      /^ {4}ticket: Show active tk title\s*$/.test(line),
    );
    const activityRowIndex = lines.findIndex((line) => /^ {7}read\s*$/.test(line));
    assert.ok(ticketRowIndex >= 0, "ticket row should be present");
    assert.ok(activityRowIndex >= 0, "activity row should be present");
    assert.ok(
      ticketRowIndex < activityRowIndex,
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
    const lines = buildWidgetLines(
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
    );
    const text = lines.join("\n");

    assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
    assert.doesNotMatch(text, /plain[\s\S]*ticket:/);
    const ticketRowIndex = lines.findIndex((line) =>
      /^│ {5}ticket: Show active tk title\s*$/.test(line),
    );
    const activityRowIndex = lines.findIndex((line) => /^│ {8}read\s*$/.test(line));
    assert.ok(ticketRowIndex >= 0, "ticket row should be present");
    assert.ok(activityRowIndex >= 0, "activity row should be present");
    assert.ok(
      ticketRowIndex < activityRowIndex,
      "ticket line should appear before the activity line",
    );
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
    assert.match(text, new RegExp(`^ {5}${escapeRegExp(whimsicalThinkingPhrase(0))}$`, "m"));
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
        `Agent 1/3: reviewer\\n^ {7}${escapeRegExp(whimsicalThinkingPhrase(0))}$\\n^ {7}active now$`,
        "m",
      ),
    );
    assert.match(
      text,
      /Agent 2\/3: reviewer[\s\S]*^ {7}read \| 2\.0s\s*$/m,
      "widget step activity must keep the exact 7-space column",
    );
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

  it("cycles compact async thinking phrases on a time cadence while expanded rows retain telemetry", () => {
    const now = Date.now();
    // Single-mode jobs with steps render phrase via widgetStepActivityLines using
    // step.startedAt as the time anchor.  Set it so that the time-based slot applies.
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
          startedAt: now - 7_000,
        },
      ],
    };

    // Elapsed 7 000 ms → time-based slot 0; same lookup index as turnCount-fallback at 0.
    const slot0Phrase = whimsicalThinkingPhrase(0);
    const collapsed = buildWidgetLines([job], theme, 180).join("\n");
    assert.match(
      collapsed,
      new RegExp(`^ {7}${escapeRegExp(slot0Phrase)}$\\n^ {7}active now$`, "m"),
    );
    assert.doesNotMatch(collapsed, /5 turns|18 tool uses|44k token|7\.0s/);

    // Stability: changing turnCount alone must not change the phrase within the 8 s window.
    const sameWindow = buildWidgetLines(
      [{ ...job, steps: [{ ...job.steps![0]!, turnCount: 6 }] }],
      theme,
      180,
    ).join("\n");
    assert.match(sameWindow, new RegExp(escapeRegExp(slot0Phrase)));

    // Advance: crossing the 8 s boundary must move to slot 1.
    // updatedAt advances to now + 2 000 ms; step.startedAt stays at now − 7 000,
    // so elapsed becomes 9 000 ms → slot 1.
    const slot1Phrase = whimsicalThinkingPhrase(1);
    const advanced = buildWidgetLines([{ ...job, updatedAt: now + 2_000 }], theme, 180).join("\n");
    assert.match(advanced, new RegExp(escapeRegExp(slot1Phrase)));
    assert.doesNotMatch(advanced, new RegExp(escapeRegExp(slot0Phrase)));

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
    assert.doesNotMatch(activeTool, new RegExp(escapeRegExp(slot0Phrase)));
  });

  it("job-row phrase stays stable when running step changes in a chain/parallel job", () => {
    // Regression for the pre-fix behaviour where job-level rows anchored the
    // phrase on runningStep?.startedAt (or activityStep?.startedAt), causing a
    // reset when the chain advanced or a parallel slot changed.
    //
    // After the fix, job-level rows anchor on job.startedAt first; the step
    // startedAt is only a fallback when job.startedAt is undefined.
    const now = Date.now();
    // job.startedAt is 4 000 ms ago → slot 0 within the 8 s window.
    const jobStartedAt = now - 4_000;
    const slot0Phrase = whimsicalThinkingPhrase(0);
    const slot1Phrase = whimsicalThinkingPhrase(1);
    assert.notEqual(slot0Phrase, slot1Phrase, "sanity: slot 0 and slot 1 must differ");

    // Single-mode job: step 0 (the only step) currently running.
    // step.startedAt = now − 9 000 ms → would be slot 1 if used as the phrase
    // anchor; job.startedAt = now − 4 000 ms → slot 0 (correct after fix).
    // mode: "single" means widgetParallelAgentDetails returns [] so no per-step
    // phrase rows appear in the multi-job widget — this lets the test assert the
    // exact job-row phrase without interference from step-level anchoring (which
    // is intentionally allowed to use step.startedAt).
    // No currentTool on the step, so widgetActivityLines reaches the phrase path.
    const singleJob: AsyncJobState = {
      asyncId: "single-step-anchor",
      asyncDir: "/tmp/single-step-anchor",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      startedAt: jobStartedAt,
      updatedAt: now,
      lastActivityAt: now,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          startedAt: now - 9_000, // slot 1 if used as anchor — must NOT be used
          lastActivityAt: now,
          turnCount: 3,
        },
      ],
    };

    const fillerJob: AsyncJobState = {
      asyncId: "filler-queued",
      asyncDir: "/tmp/filler",
      status: "queued",
      agents: ["scout"],
      startedAt: now,
      updatedAt: now,
    };

    // Two-job widget so the multi-job rendering path is exercised (each running
    // job goes through widgetActivityDetailLines → widgetActivityLines).
    // For mode: "single", widgetParallelAgentDetails returns [] so only the
    // job-level phrase row appears — no step-level phrase to interfere.
    const text = buildWidgetLines([singleJob, fillerJob], theme, 180).join("\n");
    assert.match(
      text,
      new RegExp(escapeRegExp(slot0Phrase)),
      "phrase must anchor on job.startedAt (slot 0), not step startedAt (slot 1)",
    );
    // single mode with no per-step phrase rows → slot1 must not appear anywhere.
    assert.doesNotMatch(
      text,
      new RegExp(escapeRegExp(slot1Phrase)),
      "slot 1 phrase must not appear when job.startedAt gives slot 0",
    );
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
    assert.match(
      expandedText,
      /^ {7}read: src\/tui\/render\.ts \| 2\.0s$/m,
      "widget step activity must keep the exact 7-space column",
    );
    assert.doesNotMatch(expandedText, /⎿/);
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
    assert.match(collapsedText, /^ {7}read: src\/tui\/render\.ts \| 2\.0s$/m);
    assert.doesNotMatch(collapsedText, /⎿/);
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
      assert.doesNotMatch(expandedText, /output-0\.log|stale detail|stale live output/);
      assert.doesNotMatch(expandedText, /^ {7}read\b/m);
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
    assert.match(text, /^ {5}read 1\.0s\s*$/m);
    assert.doesNotMatch(text, /⎿/);
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
