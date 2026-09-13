import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AsyncJobState } from "../support/render-widget-fixtures.ts";
import {
  assertWrappedSource,
  buildWidgetLines,
  containsTerminalControl,
  createSubagentLiveDetailController,
  createUiContext,
  createWidgetTestIsolation,
  createWidgetTheme,
  escapeRegExp,
  renderWidget,
  renderWidgetHarnessLines,
  renderWidgetLines,
  renderWithRealPiTui,
  stripTerminalSequences,
  visibleWidth,
  whimsicalThinkingPhrase,
  withStdoutSize,
  wrappedText,
} from "../support/render-widget-fixtures.ts";

const theme = createWidgetTheme();
const widgetTestIsolation = createWidgetTestIsolation(theme);
beforeEach(widgetTestIsolation.beforeEach);
afterEach(widgetTestIsolation.afterEach);
const resetWidgetLayout = widgetTestIsolation.resetWidgetLayout;

describe("subagent async widget rendering", () => {
  it("renders a compact component widget for three active parallel agents without core truncation", () => {
    const now = Date.now();
    const ui = createUiContext();
    renderWidget(ui.ctx as never, [
      {
        asyncId: "run-1",
        asyncDir: "/tmp/1",
        status: "running",
        mode: "parallel",
        agents: ["reviewer", "reviewer", "reviewer"],
        runningSteps: 3,
        completedSteps: 0,
        stepsTotal: 3,
        updatedAt: now,
        steps: [
          {
            index: 0,
            agent: "reviewer",
            status: "running",
            lastActivityAt: now,
            turnCount: 5,
            toolCount: 18,
            tokens: { input: 30_000, output: 10_000, total: 44_000 },
          },
          {
            index: 1,
            agent: "reviewer",
            status: "running",
            lastActivityAt: now - 2000,
            turnCount: 4,
            toolCount: 13,
            tokens: { input: 16_000, output: 4_000, total: 22_000 },
          },
          {
            index: 2,
            agent: "reviewer",
            status: "running",
            currentTool: "grep",
            currentToolStartedAt: now - 1000,
            turnCount: 3,
            toolCount: 11,
            tokens: { input: 14_000, output: 3_000, total: 19_000 },
          },
        ],
      },
    ]);
    const widget = ui.widgets.at(-1);
    assert.equal(
      typeof widget,
      "function",
      "renderWidget should install a component widget, not a capped string-array widget",
    );
    const lines = (
      widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] }
    )(undefined, theme)
      .render(180)
      .map((line) => line.trimEnd());
    const text = lines.join("\n");
    assert.match(text, /async subagents \(3\)/);
    assert.match(
      text,
      new RegExp(`Agent 1/3: reviewer · ${escapeRegExp(whimsicalThinkingPhrase(5))} · active now`),
    );
    assert.match(
      text,
      new RegExp(
        `Agent 2/3: reviewer · ${escapeRegExp(whimsicalThinkingPhrase(4))} · active 2s ago`,
      ),
    );
    assert.match(text, /Agent 3\/3: reviewer · grep \| 1\.0s/);
    assert.doesNotMatch(
      text,
      /5 turns|18 tool uses|44k token|4 turns|13 tool uses|22k token|3 turns|11 tool uses|19k token/,
    );
    assert.match(text, /Press Ctrl\+Shift\+D for live detail/);
    assert.doesNotMatch(text, /widget truncated/);
    assert.ok(
      lines.length <= 10,
      "collapsed component should stay under Pi's string-widget cap even though it bypasses it",
    );
  });

  it("preserves freshness while fitting long phrases into 60-column parallel rows", () => {
    resetWidgetLayout();
    withStdoutSize(60, 60, () => {
      const now = 20_000;
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "run-narrow-parallel",
          asyncDir: "/tmp/run-narrow-parallel",
          status: "running",
          mode: "parallel",
          agents: ["reviewer", "reviewer", "reviewer"],
          runningSteps: 3,
          completedSteps: 0,
          stepsTotal: 3,
          updatedAt: now,
          steps: Array.from({ length: 3 }, (_, index) => ({
            index,
            agent: "reviewer",
            status: "running",
            turnCount: 19,
            lastActivityAt: now,
          })),
        },
      ]);

      const lines = renderWidgetLines(ui.widgets.at(-1), 60);
      const row = lines.find((line) => line.includes("Agent 1/3")) ?? "";
      assert.match(row, /Agent 1\/3: reviewer/);
      assertWrappedSource(lines, whimsicalThinkingPhrase(19));
      assertWrappedSource(lines, "active now");
      for (const line of lines)
        assert.ok(
          visibleWidth(line) <= 58,
          `parallel row should fit 58 columns: ${JSON.stringify(line)}`,
        );
    });
    resetWidgetLayout();
  });

  it("budgets multi-job branch and detail rows for real Text padding at 40/50 columns", () => {
    const now = 20_000;
    const jobs: AsyncJobState[] = [
      {
        asyncId: "multi-job-width",
        asyncDir: "/tmp/multi-job-width",
        status: "running",
        mode: "single",
        agents: ["header-agent-name-that-is-deliberately-long"],
        turnCount: 41,
        lastActivityAt: now - 2_000,
        updatedAt: now,
      },
      {
        asyncId: "multi-job-width-done",
        asyncDir: "/tmp/multi-job-width-done",
        status: "complete",
        mode: "single",
        agents: ["done"],
      },
    ];

    for (const width of [40, 50]) {
      const lines = buildWidgetLines(jobs, theme, width);
      const contentWidth = Math.max(1, width - 2);
      assert.ok(
        lines.some((line) => line.includes(whimsicalThinkingPhrase(41).slice(0, 20))),
        "long thinking phrase should remain in the harness output",
      );
      assert.ok(
        lines.some((line) => line.includes("header-agent-name")),
        "long job header should remain in the harness output",
      );
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= contentWidth,
          `multi-job line should fit ${contentWidth} columns at ${width}: ${JSON.stringify(line)}`,
        );
      }

      const realLines = renderWithRealPiTui(lines, width);
      assert.equal(
        realLines.length,
        lines.length,
        `real pi-tui Text must not add continuation rows at ${width} columns`,
      );
      for (const line of realLines)
        assert.equal(
          visibleWidth(line),
          width,
          `real pi-tui should pad each row to ${width} columns`,
        );
    }
  });

  it("locks crowded widget rows at the reviewer narrow-width probes", () => {
    const now = 20_000;
    const jobs: AsyncJobState[] = Array.from({ length: 8 }, (_, index): AsyncJobState => ({
      asyncId: `crowded-width-${index}`,
      asyncDir: `/tmp/crowded-width-${index}`,
      status: "running",
      mode: "single",
      agents: [`crowded-agent-with-a-long-name-${index}`],
      lastActivityAt: now - index * 1_000,
      updatedAt: now,
    }));

    for (const { rows, columns, expectedRows, description, jobs: probeJobs } of [
      { rows: 22, columns: 20, expectedRows: 2, description: "progressive", jobs },
      { rows: 6, columns: 20, expectedRows: 1, description: "single-line", jobs: jobs.slice(0, 6) },
    ] as const) {
      resetWidgetLayout();
      withStdoutSize(rows, columns, () => {
        const ui = createUiContext();
        renderWidget(ui.ctx as never, probeJobs);
        const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
        assert.equal(harnessLines.length, expectedRows, `${description} harness row count`);
        for (const line of harnessLines)
          assert.ok(
            visibleWidth(line) <= columns - 2,
            `${description} harness line should fit ${columns - 2} columns: ${JSON.stringify(line)}`,
          );
        if (description === "progressive") assert.match(harnessLines.join("\n"), /\+\d+ more/);
        if (description === "single-line") {
          assert.match(harnessLines[0] ?? "", /subagents/);
          assert.doesNotMatch(harnessLines[0] ?? "", /\d+ running|\brunning\b/);
        }

        const realLines = renderWithRealPiTui(harnessLines, columns);
        assert.equal(
          realLines.length,
          harnessLines.length,
          `${description} real pi-tui row count must match the harness`,
        );
        for (const line of realLines)
          assert.equal(
            visibleWidth(line),
            columns,
            `${description} real pi-tui row should be padded to ${columns} columns`,
          );
      });
    }

    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, jobs);
      const normalWidthText = renderWidgetHarnessLines(ui.widgets.at(-1)).join("\n");
      assert.match(normalWidthText, /Async agents/);
      assert.doesNotMatch(normalWidthText, /\b(?:agents?|jobs?) running\b/);
      assert.match(normalWidthText, /crowded-agent-with-a-long-name-0/);
    });
    resetWidgetLayout();
  });

  it("keeps expanded one-job telemetry rows unwrapped at real 40/50-column widths", () => {
    const now = 20_000;
    for (const width of [40, 50]) {
      resetWidgetLayout();
      withStdoutSize(40, width, () => {
        const ui = createUiContext();
        const liveDetailController = createSubagentLiveDetailController(true);
        renderWidget(
          ui.ctx as never,
          [
            {
              asyncId: `expanded-width-${width}`,
              asyncDir: `/tmp/expanded-width-${width}`,
              status: "running",
              mode: "single",
              agents: ["w"],
              stepsTotal: 1,
              startedAt: now - 9_000,
              updatedAt: now,
              steps: [
                {
                  index: 0,
                  agent: "w",
                  status: "running",
                  turnCount: 5,
                  toolCount: 7,
                  tokens: { input: 8_000, output: 5_000, total: 13_000 },
                  durationMs: 9_000,
                  currentTool: "read-long-tool-name",
                  currentToolArgs: "src/tui/render.ts --very-long-argument-here",
                  currentToolStartedAt: now - 2_000,
                  recentTools: [{ tool: "grep", args: "long args", endMs: 1 }],
                  recentOutput: ["expanded telemetry output"],
                },
              ],
            },
          ],
          liveDetailController,
        );

        const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
        const harnessText = harnessLines.join("\n");
        assert.match(harnessText, /5 turns/);
        assert.match(harnessText, /7 tool/);
        assert.match(harnessText, /output:/);
        for (const line of harnessLines)
          assert.ok(
            visibleWidth(line) <= width - 2,
            `expanded harness line should fit ${width - 2} columns: ${JSON.stringify(line)}`,
          );

        const realLines = renderWithRealPiTui(harnessLines, width);
        assert.equal(
          realLines.length,
          harnessLines.length,
          `expanded real pi-tui row count must match at ${width} columns`,
        );
        assert.match(realLines.join("\n"), /5 turns/);
        assert.match(realLines.join("\n"), /7 tool/);
        for (const line of realLines)
          assert.equal(
            visibleWidth(line),
            width,
            `expanded real pi-tui row should be padded to ${width} columns`,
          );
      });
    }
    resetWidgetLayout();
  });

  it("reserves every physical row of a wrapped hidden-line label", () => {
    resetWidgetLayout();
    withStdoutSize(22, 20, () => {
      const ui = createUiContext();
      const liveDetailController = createSubagentLiveDetailController(true);
      renderWidget(
        ui.ctx as never,
        [
          {
            asyncId: "expanded-hidden-label",
            asyncDir: "/tmp/expanded-hidden-label",
            status: "running",
            mode: "single",
            agents: ["worker"],
            stepsTotal: 1,
            steps: [
              {
                index: 0,
                agent: "worker",
                status: "running",
                recentTools: [],
                recentOutput: Array.from(
                  { length: 5 },
                  (_, index) => `output-${index}-${"long-value-".repeat(8)}`,
                ),
              },
            ],
          },
        ],
        liveDetailController,
      );

      const lines = renderWidgetHarnessLines(ui.widgets.at(-1));
      assert.equal(lines.length, 12);
      assert.match(wrappedText(lines), /…\d+live-detaillineshidden/);
      assert.ok(lines.every((line) => visibleWidth(line) <= 18));
    });
    resetWidgetLayout();
  });

  it("locks crowded collapsed widget height for the current terminal session", () => {
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const now = 20_000;
      const crowdedJobs: AsyncJobState[] = Array.from(
        { length: 3 },
        (_, jobIndex): AsyncJobState => ({
          asyncId: `run-${jobIndex + 1}`,
          asyncDir: `/tmp/run-${jobIndex + 1}`,
          status: "running",
          mode: "parallel",
          agents: ["scout", "reviewer"],
          runningSteps: 2,
          completedSteps: 0,
          stepsTotal: 2,
          updatedAt: now + jobIndex,
          steps: [
            {
              index: 0,
              agent: "scout",
              status: "running",
              currentTool: "read",
              currentToolStartedAt: now - 1000,
            },
            {
              index: 1,
              agent: "reviewer",
              status: "running",
              currentTool: "grep",
              currentToolStartedAt: now - 2000,
            },
          ],
        }),
      );
      const ui = createUiContext();

      renderWidget(ui.ctx as never, crowdedJobs);
      const crowdedLines = renderWidgetLines(ui.widgets.at(-1));
      // Natural progressive height: 1 header row + 1 row per visible job (3 jobs).
      // Under the lockedRows=10 cap, so no truncation and no filler padding.
      assert.equal(
        crowdedLines.length,
        4,
        "crowded collapsed widget renders at natural height under the compact cap",
      );
      assert.match(crowdedLines.join("\n"), /Async agents/);
      assert.doesNotMatch(crowdedLines.join("\n"), /\b(?:agents?|jobs?) running\b/);

      renderWidget(ui.ctx as never, [
        {
          ...crowdedJobs[0]!,
          status: "complete",
          runningSteps: 0,
          completedSteps: 2,
          steps: [
            { index: 0, agent: "scout", status: "complete" },
            { index: 1, agent: "reviewer", status: "complete" },
          ],
        },
      ]);
      const settledLines = renderWidgetLines(ui.widgets.at(-1));
      // Single-job drain: the progressive lock is bypassed and the completed parallel
      // job renders through the full tier as a compact single-job form.
      // 2 header rows + 2 step rows (both complete) = 4 lines, within budget=10.
      assert.equal(
        settledLines.length,
        4,
        "collapsed widget renders single-job compact form after drain",
      );
      assert.ok(
        !settledLines.join("").includes("\u200c"),
        "drained collapsed widget must not emit zero-width non-joiner filler rows",
      );
      assert.match(settledLines.join("\n"), /2\/2 done/);

      renderWidget(ui.ctx as never, []);
      renderWidget(ui.ctx as never, [
        {
          asyncId: "small",
          asyncDir: "/tmp/small",
          status: "running",
          agents: ["worker"],
          currentTool: "read",
        },
      ]);
      const resetLines = renderWidgetLines(ui.widgets.at(-1));
      assert.ok(resetLines.length < 10, "clearing the widget starts a fresh layout session");
    });
    resetWidgetLayout();
  });

  it("keeps medium terminal progressive fallback within the compact cap", () => {
    resetWidgetLayout();
    withStdoutSize(50, 120, () => {
      const ui = createUiContext();
      const jobs: AsyncJobState[] = [
        {
          asyncId: "run-wide",
          asyncDir: "/tmp/run-wide",
          status: "running",
          mode: "parallel",
          agents: Array.from({ length: 40 }, (_, index) => `agent-${index}`),
          runningSteps: 40,
          completedSteps: 0,
          stepsTotal: 40,
          steps: Array.from({ length: 40 }, (_, index) => ({
            index,
            agent: `agent-${index}`,
            status: "running",
            currentTool: "read",
          })),
        },
      ];

      renderWidget(ui.ctx as never, jobs);
      const lines = renderWidgetLines(ui.widgets.at(-1));
      // Single-job: routes through the full tier. compactSingleWidgetLines produces
      // header(2) + 40 step rows + 1 hint = 43 lines, truncated by fitWidgetLineBudget
      // to budget=14 (collapsedWidgetLineBudget(50)) with the expand hint.
      assert.equal(
        lines.length,
        14,
        "medium terminal truncates single-job compact form to the budget with hint",
      );
      assert.ok(
        !lines.join("").includes("\u200c"),
        "medium terminal fallback must not emit filler rows",
      );
      assert.match(lines.join("\n"), /0\/40 done/);
      assert.match(lines.join("\n"), /lines hidden.*expands/);
      assert.doesNotMatch(lines.join("\n"), /· running\b/);
    });
    resetWidgetLayout();
  });

  it("single quiet job after progressive lock does not render trailing blank rows", () => {
    // tlhmf-ve09 regression: a progressive lock taken while multiple jobs were live
    // must not persist after the set drains to one quiet job. The single job must
    // route through the full tier (fitWidgetLineBudget) rather than the stale
    // progressive session, so the expand hint is shown and no filler rows appear.
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      // rows=22: availableRows=22-19=3, collapsedWidgetLineBudget(22)=10, lockedRows=min(3,10)=3.
      const now = 20_000;
      const ui = createUiContext();

      // Three single-mode jobs: buildWidgetLines = 1 header + 3×(1 main + 1 activity) =
      // 7 lines > availableRows=3 → fitAdaptiveWidgetLines enters progressive tier,
      // lockedRows = min(3, 10) = 3.
      const makeMultiJob = (id: string): AsyncJobState => ({
        asyncId: id,
        asyncDir: `/tmp/${id}`,
        status: "running",
        mode: "single",
        agents: [id],
        currentTool: "read",
        updatedAt: now,
      });
      const multiJobs = ["alpha", "bravo", "charlie"].map(makeMultiJob);

      renderWidget(ui.ctx as never, multiJobs);
      const multiLines = renderWidgetLines(ui.widgets.at(-1));
      // Progressive output with lockedRows=3: 1 header + 1 visible job + "+2 more" = 3 lines.
      // No fitWidgetLineBudget hint in the progressive tier.
      assert.equal(
        multiLines.length,
        3,
        "three jobs must lock the progressive tier at lockedRows=3",
      );
      assert.match(multiLines.join("\n"), /\+2 more/, "progressive tier shows hidden-count line");
      assert.doesNotMatch(
        multiLines.join("\n"),
        /lines hidden.*expands/,
        "progressive tier must not show the full-tier expand hint",
      );
      assert.ok(
        !multiLines.join("").includes("\u200c"),
        "progressive tier must not emit filler rows",
      );

      // Drain to one quiet job (all steps complete). The !singleJob bypass in
      // fitAdaptiveWidgetLines must prevent reuse of the progressive session.
      const quietJob: AsyncJobState = {
        asyncId: "developer-run-quiet",
        asyncDir: "/tmp/developer-run-quiet",
        status: "running",
        mode: "parallel",
        agents: Array.from({ length: 15 }, (_, i) => `subagent-${i}`),
        runningSteps: 0,
        completedSteps: 15,
        stepsTotal: 15,
        updatedAt: now + 10_000,
        steps: Array.from({ length: 15 }, (_, i) => ({
          index: i,
          agent: `subagent-${i}`,
          status: "complete" as const,
        })),
      };

      renderWidget(ui.ctx as never, [quietJob]);
      const quietLines = renderWidgetLines(ui.widgets.at(-1));

      // Single-job full tier: compact form with 15 complete steps = ~17 lines,
      // truncated to budget=collapsedWidgetLineBudget(22)=10 with the expand hint.
      assert.ok(
        !quietLines.join("").includes("\u200c"),
        "quiet single job must not emit zero-width non-joiner filler rows",
      );
      assert.equal(
        quietLines.length,
        10,
        "quiet single job routes through full tier, not the stale progressive lock",
      );
      assert.match(
        quietLines.join("\n"),
        /lines hidden.*expands/,
        "quiet single job must show the expand shortcut hint (full tier)",
      );
    });
    resetWidgetLayout();
  });

  it("single parallel job with nested children stays in full tier (no progressive involvement)", () => {
    // Full-tier regression: a single parallel job with nested children must route
    // through fitWidgetLineBudget rather than the progressive tier. This is the
    // full-tier half of the progressive-drain scenario preserved from tlhmf-ve09.
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const now = 20_000;
      const ui = createUiContext();

      const tallJob: AsyncJobState = {
        asyncId: "developer-idle-tall",
        asyncDir: "/tmp/developer-idle-tall",
        status: "running",
        mode: "parallel",
        agents: ["developer", "code-reviewer"],
        runningSteps: 12,
        completedSteps: 0,
        stepsTotal: 12,
        updatedAt: now,
        steps: Array.from({ length: 12 }, (_, i) => ({
          index: i,
          agent: i % 2 === 0 ? "developer" : "code-reviewer",
          status: "running" as const,
          currentTool: "read",
          currentToolStartedAt: now - 1_000,
          children: [
            {
              id: `nested-run-${i}`,
              parentRunId: "developer-idle-tall",
              depth: 1,
              path: [{ runId: "developer-idle-tall", stepIndex: i }],
              state: "running" as const,
              agent: `nested-${i}`,
              currentTool: "grep",
            },
          ],
        })),
      };

      renderWidget(ui.ctx as never, [tallJob]);
      const tallLines = renderWidgetLines(ui.widgets.at(-1));
      // Height 10 (budget=10 for 30-row terminal): single-job bypasses the progressive
      // tier; steps+children push the compact render past the budget, so
      // fitWidgetLineBudget truncates with the expand hint.
      assert.equal(
        tallLines.length,
        10,
        "tall parallel job with children routes through full tier with truncation hint",
      );
      assert.ok(
        !tallLines.join("").includes("\u200c"),
        "tall parallel job with children must not emit filler rows",
      );
      assert.match(
        tallLines.join("\n"),
        /lines hidden.*expands/,
        "tall parallel job with children must show the expand shortcut hint",
      );
    });
    resetWidgetLayout();
  });

  it("single still-running idle job after progressive lock does not render trailing blank rows", () => {
    // tlhmf-ve09 regression: a progressive lock taken while multiple jobs were live
    // must not persist after the set drains to one idle (health-state) job. The single
    // job must route through the full tier (fitWidgetLineBudget) rather than the stale
    // progressive session, preserving the health signal and the expand hint.
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      // rows=22: availableRows=22-19=3, collapsedWidgetLineBudget(22)=10, lockedRows=min(3,10)=3.
      const now = 20_000;
      const ui = createUiContext();

      // Three single-mode jobs: buildWidgetLines = 1 header + 3×(1 main + 1 activity) =
      // 7 lines > availableRows=3 → fitAdaptiveWidgetLines enters progressive tier,
      // lockedRows = min(3, 10) = 3.
      const makeMultiJob = (id: string): AsyncJobState => ({
        asyncId: id,
        asyncDir: `/tmp/${id}`,
        status: "running",
        mode: "single",
        agents: [id],
        currentTool: "read",
        updatedAt: now,
      });
      const multiJobs = ["alpha", "bravo", "charlie"].map(makeMultiJob);

      renderWidget(ui.ctx as never, multiJobs);
      const multiLines = renderWidgetLines(ui.widgets.at(-1));
      // Progressive output with lockedRows=3: 1 header + 1 visible job + "+2 more" = 3 lines.
      assert.equal(
        multiLines.length,
        3,
        "three jobs must lock the progressive tier at lockedRows=3",
      );
      assert.match(multiLines.join("\n"), /\+2 more/, "progressive tier shows hidden-count line");
      assert.doesNotMatch(
        multiLines.join("\n"),
        /lines hidden.*expands/,
        "progressive tier must not show the full-tier expand hint",
      );
      assert.ok(
        !multiLines.join("").includes("\u200c"),
        "progressive tier must not emit filler rows",
      );

      // Drain to one idle job with a job-level health activityState.
      // The !singleJob bypass in fitAdaptiveWidgetLines must prevent reuse of the
      // progressive session, so the health warning and expand hint both appear.
      const idleJob: AsyncJobState = {
        asyncId: "developer-idle-1",
        asyncDir: "/tmp/developer-idle-1",
        status: "running",
        mode: "parallel",
        agents: ["developer", "code-reviewer"],
        runningSteps: 12,
        completedSteps: 0,
        stepsTotal: 12,
        activityState: "needs_attention",
        lastActivityAt: now,
        updatedAt: now + 5_000,
        steps: Array.from({ length: 12 }, (_, i) => ({
          index: i,
          agent: i % 2 === 0 ? "developer" : "code-reviewer",
          status: "running" as const,
        })),
      };

      renderWidget(ui.ctx as never, [idleJob]);
      const idleLines = renderWidgetLines(ui.widgets.at(-1));

      // The job-level health state is a staleness signal and must survive the compact
      // step-detail render: jobHealthWarningLines surfaces it under the header because
      // no step carries a step-level health state here.
      assert.match(
        idleLines.join("\n"),
        /no activity for/,
        "job-level health signal must survive the compact single-job render",
      );
      // Single-job full tier: compact form with 12 idle step rows (no currentTool) =
      // header(2) + 1 job health row + 12 rows + 1 hint = 16 lines, truncated to
      // budget=collapsedWidgetLineBudget(22)=10.
      assert.equal(
        idleLines.length,
        10,
        "still-running idle job routes through full tier, not the stale progressive lock",
      );
      assert.match(
        idleLines.join("\n"),
        /lines hidden.*expands/,
        "still-running idle job must show the expand shortcut hint (full tier)",
      );
      assert.ok(
        !idleLines.join("").includes("\u200c"),
        "still-running idle job must not emit zero-width non-joiner filler rows",
      );
    });
    resetWidgetLayout();
  });

  it("single job exceeding available rows routes through full tier with expand hint", () => {
    // tlhmf-auxo regression: a fresh single-job render that cannot fit in availableRows
    // must route through the full tier (fitWidgetLineBudget) rather than the progressive
    // tier, so step detail is visible and the expand shortcut is discoverable.
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      // availableRows = 30 - 19 = 11; budget = collapsedWidgetLineBudget(30) = 10.
      const now = 20_000;
      const ui = createUiContext();
      const tallSingleJob: AsyncJobState = {
        asyncId: "auxo-tall-1",
        asyncDir: "/tmp/auxo-tall-1",
        status: "running",
        mode: "parallel",
        agents: Array.from({ length: 10 }, (_, i) => `agent-${i}`),
        runningSteps: 10,
        completedSteps: 0,
        stepsTotal: 10,
        updatedAt: now,
        steps: Array.from({ length: 10 }, (_, i) => ({
          index: i,
          agent: `agent-${i}`,
          status: "running" as const,
          currentTool: "read",
        })),
      };

      renderWidget(ui.ctx as never, [tallSingleJob]);
      const lines = renderWidgetLines(ui.widgets.at(-1));

      // compactSingleWidgetLines: header(2) + 10 step rows + 1 hint = 13 lines > budget=10.
      // fitWidgetLineBudget truncates to exactly 10 (9 visible + 1 expand hint).
      assert.equal(
        lines.length,
        10,
        "single job exceeding available rows truncates to budget via full tier",
      );
      assert.match(
        lines.join("\n"),
        /lines hidden.*expands/,
        "single job must carry the expand shortcut hint when truncated",
      );
      assert.ok(
        !lines.join("").includes("\u200c"),
        "must not emit zero-width non-joiner filler rows",
      );
      // Step detail must be present (not the bare progressive summary row).
      assert.match(lines.join("\n"), /Agent 1\/10/);
    });
    resetWidgetLayout();
  });

  it("multi-job progressive lock does not persist when set drains to a single tall job", () => {
    // tlhmf-ve09 regression: a progressive lock genuinely taken while multiple jobs were
    // live must not survive a drain to one job. After the drain, the single job must
    // render through the full tier with step detail and the expand hint.
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      // rows=22: availableRows=22-19=3, budget=collapsedWidgetLineBudget(22)=10, lockedRows=min(3,10)=3.
      const now = 20_000;
      const ui = createUiContext();

      // Three single-mode jobs: buildWidgetLines = 1 header + 3×(1 main + 1 activity) =
      // 7 lines > availableRows=3 → fitAdaptiveWidgetLines enters progressive tier,
      // lockedRows = min(3, 10) = 3.
      const makeJob = (id: string): AsyncJobState => ({
        asyncId: id,
        asyncDir: `/tmp/${id}`,
        status: "running",
        mode: "single",
        agents: [id],
        currentTool: "read",
        updatedAt: now,
      });
      const multiJobs = [makeJob("developer"), makeJob("code-reviewer"), makeJob("scout")];

      renderWidget(ui.ctx as never, multiJobs);
      const multiLines = renderWidgetLines(ui.widgets.at(-1));
      // Progressive output with lockedRows=3: 1 header + 1 visible job + "+2 more" = 3 lines.
      assert.equal(multiLines.length, 3, "three jobs lock the progressive tier at lockedRows=3");
      assert.match(multiLines.join("\n"), /\+2 more/, "progressive tier shows hidden-count line");
      assert.doesNotMatch(
        multiLines.join("\n"),
        /lines hidden.*expands/,
        "progressive tier must not show the full-tier expand hint",
      );
      assert.ok(
        !multiLines.join("").includes("\u200c"),
        "progressive tier must not emit filler rows",
      );

      // Drain to one tall job. The !singleJob bypass in fitAdaptiveWidgetLines must
      // prevent reuse of the progressive session so the single job routes full-tier.
      const drainJob: AsyncJobState = {
        asyncId: "developer",
        asyncDir: "/tmp/developer",
        status: "running",
        mode: "parallel",
        agents: Array.from({ length: 10 }, (_, i) => `agent-${i}`),
        runningSteps: 10,
        completedSteps: 0,
        stepsTotal: 10,
        updatedAt: now + 1_000,
        steps: Array.from({ length: 10 }, (_, i) => ({
          index: i,
          agent: `agent-${i}`,
          status: "running" as const,
          currentTool: "grep",
        })),
      };

      renderWidget(ui.ctx as never, [drainJob]);
      const drainLines = renderWidgetLines(ui.widgets.at(-1));

      // The progressive lock must NOT persist: single job routes through full tier.
      // compactSingleWidgetLines: header(2) + 10 step rows + 1 hint = 13 > budget=10.
      assert.equal(
        drainLines.length,
        10,
        "drained single job routes through full tier, not the stale progressive lock",
      );
      assert.match(
        drainLines.join("\n"),
        /lines hidden.*expands/,
        "drained single job must carry the expand shortcut hint",
      );
      assert.ok(
        !drainLines.join("").includes("\u200c"),
        "drained single job must not emit filler rows",
      );
      assert.match(drainLines.join("\n"), /Agent 1\/10/);
    });
    resetWidgetLayout();
  });

  it("keeps constrained progressive single-job rows focused and step-free", () => {
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const now = Date.now();
      const ui = createUiContext();
      const jobs: AsyncJobState[] = [
        {
          asyncId: "run-1",
          asyncDir: "/tmp/run-1",
          status: "running",
          mode: "single",
          agents: ["first"],
          currentStep: 0,
          stepsTotal: 1,
          toolCount: 1,
          currentTool: "read",
          startedAt: now - 2000,
          updatedAt: now,
        },
        {
          asyncId: "run-2",
          asyncDir: "/tmp/run-2",
          status: "running",
          mode: "single",
          agents: ["second"],
          currentStep: 0,
          stepsTotal: 1,
          currentTool: "grep",
        },
        {
          asyncId: "run-3",
          asyncDir: "/tmp/run-3",
          status: "running",
          mode: "single",
          agents: ["third"],
          currentStep: 0,
          stepsTotal: 1,
          currentTool: "edit",
        },
      ];
      renderWidget(ui.ctx as never, jobs);
      const firstText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(firstText, /first · read/);
      assert.doesNotMatch(firstText, new RegExp(escapeRegExp(whimsicalThinkingPhrase(0))));
      assert.doesNotMatch(firstText, /1 tool use|2\.0s|token|turn/);
      assert.match(firstText, /\+2 more/);
      assert.doesNotMatch(firstText, /\bsteps?\b|\bchain\b/i);

      renderWidget(ui.ctx as never, [
        { ...jobs[0]!, status: "complete", currentTool: undefined },
        jobs[1]!,
        jobs[2]!,
      ]);
      const updatedText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(updatedText, /second/);
      assert.doesNotMatch(updatedText, /first · done/);
      assert.match(updatedText, /\+2 more/);
      assert.doesNotMatch(updatedText, /\bsteps?\b|\bchain\b/i);
    });
    resetWidgetLayout();
  });

  it("keeps thinking freshness and hides telemetry in constrained progressive rows", () => {
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const now = Date.now();
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "run-thinking",
          asyncDir: "/tmp/run-thinking",
          status: "running",
          mode: "single",
          agents: ["thinker"],
          turnCount: 5,
          toolCount: 18,
          totalTokens: { input: 30_000, output: 10_000, total: 44_000 },
          lastActivityAt: now,
          startedAt: now - 7_000,
          updatedAt: now,
        },
        {
          asyncId: "run-read",
          asyncDir: "/tmp/run-read",
          status: "running",
          mode: "single",
          agents: ["reader"],
          currentTool: "read",
        },
        {
          asyncId: "run-edit",
          asyncDir: "/tmp/run-edit",
          status: "running",
          mode: "single",
          agents: ["editor"],
          currentTool: "edit",
        },
      ]);

      const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(
        text,
        new RegExp(`thinker · ${escapeRegExp(whimsicalThinkingPhrase(5))} · active now`),
      );
      assert.doesNotMatch(text, /5 turns|18 tool uses|44k token|7\.0s/);
      assert.match(text, /\+2 more/);
    });
    resetWidgetLayout();
  });

  it("wraps complete thinking and freshness text in 40/50/60-column progressive rows", () => {
    for (const width of [40, 50, 60]) {
      resetWidgetLayout();
      withStdoutSize(24, width, () => {
        const now = 20_000;
        const ui = createUiContext();
        renderWidget(ui.ctx as never, [
          {
            asyncId: "run-thinking",
            asyncDir: "/tmp/run-thinking",
            status: "running",
            mode: "single",
            agents: ["thinker"],
            turnCount: 19,
            lastActivityAt: now - 2_000,
            updatedAt: now,
          },
          {
            asyncId: "run-read",
            asyncDir: "/tmp/run-read",
            status: "running",
            mode: "single",
            agents: ["reader"],
            currentTool: "read",
          },
          {
            asyncId: "run-edit",
            asyncDir: "/tmp/run-edit",
            status: "running",
            mode: "single",
            agents: ["editor"],
            currentTool: "edit",
          },
          {
            asyncId: "run-write",
            asyncDir: "/tmp/run-write",
            status: "running",
            mode: "single",
            agents: ["writer"],
            currentTool: "write",
          },
        ]);

        const lines = renderWidgetLines(ui.widgets.at(-1), width);
        const row = lines.find((line) => line.includes("thinker")) ?? "";
        assert.match(row, /thinker ·/);
        assertWrappedSource(lines, whimsicalThinkingPhrase(19));
        assertWrappedSource(lines, "active 2s ago");
        assert.match(lines.join(""), /\+\d+ more/);
        for (const line of lines)
          assert.ok(
            visibleWidth(line) <= width - 2,
            `progressive row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
          );
        assert.equal(
          wrappedText(lines).match(/active2sago/g)?.length,
          1,
          `freshness must appear once at ${width} columns`,
        );
      });
    }
    resetWidgetLayout();
  });

  it("shows tk ticket titles in progressive widget rows without changing non-ticket jobs", () => {
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "run-ticket",
          asyncDir: "/tmp/run-ticket",
          status: "running",
          mode: "single",
          agents: ["ticketed"],
          tkTicket: { id: "psr-raw4", title: "Show active tk title" },
          currentTool: "read",
        },
        {
          asyncId: "run-plain",
          asyncDir: "/tmp/run-plain",
          status: "running",
          mode: "single",
          agents: ["plain"],
          currentTool: "grep",
        },
        {
          asyncId: "run-hidden",
          asyncDir: "/tmp/run-hidden",
          status: "running",
          mode: "single",
          agents: ["hidden"],
          currentTool: "edit",
        },
      ]);

      const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(text, /ticketed · ticket: Show active tk title/);
      assert.doesNotMatch(text, /plain · ticket:/);
      assert.equal(text.match(/ticket: Show active tk title/g)?.length, 1);
    });
    resetWidgetLayout();
  });

  it("sanitizes and wraps complete direct tk ticket widget state", () => {
    const safeTitle = `Unsafe title now ${"x".repeat(120)}`;
    const lines = buildWidgetLines(
      [
        {
          asyncId: "run-unsafe-ticket",
          asyncDir: "/tmp/run-unsafe-ticket",
          status: "running",
          agents: ["worker"],
          tkTicket: {
            id: "psr-raw4",
            title: `Unsafe\u009b title\u001b[31m now\u001b[0m ${"x".repeat(120)}`,
          },
          currentTool: "read",
        },
      ],
      theme,
      90,
    );

    assertWrappedSource(lines, safeTitle);
    assert.ok(lines.every((line) => visibleWidth(line) <= 88));
    const rendered = lines.join("");
    assert.ok(!rendered.includes("…"), "ellipsis should be sanitized");
    assert.ok(!rendered.includes("\u009b"), "C1 CSI should be sanitized");
    assert.ok(!rendered.includes("\u001b[31m"), "red ESC sequence should be sanitized");
  });

  it("uses a single collapsed widget line when the terminal has almost no spare rows", () => {
    resetWidgetLayout();
    withStdoutSize(20, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "run-tiny",
          asyncDir: "/tmp/run-tiny",
          status: "running",
          agents: ["worker"],
          currentTool: "read",
        },
      ]);

      const lines = renderWidgetLines(ui.widgets.at(-1));
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /subagents/);
      assert.doesNotMatch(lines[0] ?? "", /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
    });
    resetWidgetLayout();
  });

  it("reflows and caps collapsed multiline command previews while expanded detail preserves them", () => {
    const command = [
      "printf 'alpha beta gamma delta",
      "epsilon zeta eta theta iota",
      "kappa lambda mu nu xi omicron",
      "pi rho sigma tau upsilon'",
    ].join("\n");
    const job: AsyncJobState = {
      asyncId: "multiline-command",
      asyncDir: "/tmp/multiline-command",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: 20_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "bash",
          currentToolArgs: command,
          currentToolStartedAt: 19_000,
        },
      ],
    };

    const wide = buildWidgetLines([job], theme, 120);
    const wideHintIndex = wide.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    const wideCommandStart = wide.findIndex((line) => line.includes("bash:"));
    assert.ok(wideCommandStart >= 0);
    assert.ok(wideHintIndex > wideCommandStart);
    const widePreview = wide.slice(wideCommandStart, wideHintIndex);
    assert.ok(widePreview.length >= 1);
    assert.ok(widePreview.length <= 3);
    assert.ok(widePreview.every((line) => visibleWidth(line) <= 118));
    assertWrappedSource(widePreview, command);

    const narrow = buildWidgetLines([job], theme, 42);
    const narrowHintIndex = narrow.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    const narrowCommandStart = narrow.findIndex((line) => line.includes("bash:"));
    assert.ok(narrowCommandStart >= 0);
    assert.ok(narrowHintIndex > narrowCommandStart);
    const narrowPreview = narrow.slice(narrowCommandStart, narrowHintIndex);
    assert.equal(
      narrowPreview.length,
      3,
      "collapsed command preview should use three rows at most",
    );
    assert.match(narrowPreview.at(-1) ?? "", /…/);
    assert.ok(narrowPreview.every((line) => visibleWidth(line) <= 40));
    assert.match(narrow.join("\n"), /alpha beta gamma/);
    assert.doesNotMatch(narrow.join("\n"), /upsilon/);

    const expanded = buildWidgetLines([job], theme, 42, true);
    assertWrappedSource(expanded, command);
    assert.match(expanded.join("\n"), /alpha beta gamma/);
    assert.match(expanded.join("\n"), /upsilon/);
  });

  it("preserves unbroken command tokens across unequal preview row widths", () => {
    const longToken = `https://example.com/${"a".repeat(30)}`;
    const command = `curl ${longToken}`;
    const longAgent = "worker-with-a-very-long-model-prefix";
    const job: AsyncJobState = {
      asyncId: "unbroken-command-token",
      asyncDir: "/tmp/unbroken-command-token",
      status: "running",
      mode: "parallel",
      agents: Array.from({ length: 12 }, () => longAgent),
      runningSteps: 1,
      completedSteps: 11,
      stepsTotal: 12,
      updatedAt: 20_000,
      steps: Array.from({ length: 12 }, (_, index) => ({
        index,
        agent: longAgent,
        status: index === 0 ? ("running" as const) : ("complete" as const),
        ...(index === 0
          ? {
              currentTool: "bash",
              currentToolArgs: command,
              currentToolStartedAt: 19_000,
            }
          : {}),
      })),
    };

    const width = 80;
    withStdoutSize(80, width, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [job]);
      const lines = renderWidgetHarnessLines(ui.widgets.at(-1));
      const commandStart = lines.findIndex((line) => line.includes("bash:"));
      const nextStepStart = lines.findIndex(
        (line, lineIndex) => lineIndex > commandStart && line.includes("Agent 2/12"),
      );
      assert.ok(commandStart > 0);
      assert.ok(nextStepStart > commandStart);

      const preview = lines.slice(commandStart, nextStepStart);
      assert.ok(preview.length <= 3);
      assert.ok(preview.slice(1).every((line) => line.startsWith("       ")));
      const previewText = preview
        .map((line, index) => (index === 0 ? line.slice(line.indexOf("bash: ")) : line.trimStart()))
        .join("");
      assert.match(
        previewText,
        new RegExp(escapeRegExp(longToken)),
        "collapsed preview should preserve an unbroken URL across row reflow",
      );
    });
  });

  it("fits compact live status on command rows and spills only when needed", () => {
    const makeJob = (): AsyncJobState => ({
      asyncId: "compact-command-status-density",
      asyncDir: "/tmp/compact-command-status-density",
      status: "running",
      mode: "parallel",
      agents: Array.from({ length: 12 }, () => "worker"),
      runningSteps: 1,
      completedSteps: 11,
      stepsTotal: 12,
      updatedAt: 20_000,
      steps: Array.from({ length: 12 }, (_, index) => ({
        index,
        agent: "worker",
        status: index === 0 ? ("running" as const) : ("complete" as const),
        ...(index === 0
          ? {
              currentTool: "bash",
              currentToolArgs: "echo hi",
              currentToolStartedAt: 19_000,
              lastActivityAt: 18_000,
            }
          : {}),
      })),
    });

    const renderCompact = (width: number): string[] => {
      resetWidgetLayout();
      return withStdoutSize(80, width, () => {
        const ui = createUiContext();
        renderWidget(ui.ctx as never, [makeJob()]);
        return renderWidgetHarnessLines(ui.widgets.at(-1));
      });
    };

    const fits = renderCompact(80);
    const fitsCommand = fits.find((line) => line.includes("bash: echo hi")) ?? "";
    assert.match(fitsCommand, /bash: echo hi \| 1\.0s · active 2s ago/);

    const spills = renderCompact(30);
    const spillCommandIndex = spills.findIndex((line) => line.includes("bash: echo hi"));
    const nextStepIndex = spills.findIndex(
      (line, lineIndex) => lineIndex > spillCommandIndex && line.includes("Agent 2/12"),
    );
    assert.ok(spillCommandIndex >= 0);
    assert.ok(nextStepIndex > spillCommandIndex);
    const spillPreview = spills.slice(spillCommandIndex, nextStepIndex);
    assert.ok(
      spillPreview.some((line) => line.includes("active 2s ago")),
      "live status should remain visible when it cannot share the command row",
    );
    assert.ok(
      spillPreview.every((line) => !line.includes("bash: echo hi · active 2s ago")),
      "live status should spill instead of overflowing the command row",
    );
  });

  it("strips ANSI and OSC sequences before collapsed command reflow", () => {
    const escape = "\u001b";
    const oscOpen = `${escape}]8;;https://example.com${escape}\\`;
    const oscClose = `${escape}]8;;${escape}\\`;
    const ansiOpen = `${escape}[31m`;
    const ansiClose = `${escape}[0m`;
    const command = [
      `${oscOpen}foo ${"x".repeat(30)}${oscClose} ${ansiOpen}${"y".repeat(10)}${ansiClose}`,
      "echo multiline",
    ].join("\n");
    const job: AsyncJobState = {
      asyncId: "ansi-osc-command-preview",
      asyncDir: "/tmp/ansi-osc-command-preview",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: 20_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "bash",
          currentToolArgs: command,
          currentToolStartedAt: 19_000,
        },
      ],
    };

    const collapsed = buildWidgetLines([job], theme, 42);
    const hintIndex = collapsed.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    const commandStart = collapsed.findIndex((line) => line.includes("bash:"));
    assert.ok(commandStart >= 0);
    assert.ok(hintIndex > commandStart);
    const preview = collapsed.slice(commandStart, hintIndex);
    assert.equal(preview.length, 3);
    assert.ok(preview.every((line) => visibleWidth(line) <= 40));
    assert.ok(
      !preview.join("").includes(escape),
      "collapsed preview should not contain control sequences",
    );
    const collapsedText = stripTerminalSequences(preview.join(""));
    const collapsedSource = `bash: ${stripTerminalSequences(command).replace(/\r\n|\r|\n/g, " ")}`;
    assert.ok(
      collapsedText.replace(/\s/g, "").includes(collapsedSource.replace(/\s/g, "")),
      "collapsed preview should preserve all visible characters from ANSI/OSC-bearing commands",
    );

    const expanded = buildWidgetLines([job], theme, 180, true);
    const expandedText = expanded.join("\n");
    assert.doesNotMatch(expandedText, new RegExp(escapeRegExp(oscOpen)));
    assert.doesNotMatch(expandedText, new RegExp(escapeRegExp(oscClose)));
    assert.doesNotMatch(expandedText, new RegExp(escapeRegExp(ansiOpen)));
    assert.doesNotMatch(expandedText, new RegExp(escapeRegExp(ansiClose)));
    assertWrappedSource(expanded, stripTerminalSequences(command));
    const expandedCommandStart = expanded.findIndex((line) => line.includes("bash:"));
    const expandedSecondLine = expanded.findIndex(
      (line, lineIndex) => lineIndex > expandedCommandStart && line.includes("echo multiline"),
    );
    assert.ok(expandedCommandStart >= 0);
    assert.ok(
      expandedSecondLine > expandedCommandStart,
      "expanded detail should retain the command's original multiline structure",
    );
  });

  it("removes bare C0/C1 controls from collapsed and expanded previews", () => {
    const c0 = "\u0001";
    const c1 = "\u0090";
    const tab = "\t";
    const command = `printf 'before${c0}middle${c1}after\u007f\u009f'\necho${tab}multiline`;
    const job: AsyncJobState = {
      asyncId: "bare-control-command-preview",
      asyncDir: "/tmp/bare-control-command-preview",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: 20_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "bash",
          currentToolArgs: command,
          currentToolStartedAt: 19_000,
        },
      ],
    };

    const collapsed = buildWidgetLines([job], theme, 80);
    const hintIndex = collapsed.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    const commandStart = collapsed.findIndex((line) => line.includes("bash:"));
    assert.ok(commandStart >= 0);
    assert.ok(hintIndex > commandStart);
    const preview = collapsed.slice(commandStart, hintIndex).join("");
    assert.equal(containsTerminalControl(preview), false);
    assert.match(preview, /before middle after/);
    assert.match(preview, /echo multiline/);

    const expanded = buildWidgetLines([job], theme, 120, true);
    const expandedText = expanded.join("\n");
    assert.equal(expandedText.includes(c0), false, "expanded detail should strip C0 source");
    assert.equal(expandedText.includes(c1), false, "expanded detail should strip C1 source");
    assert.equal(expandedText.includes("\u007f"), false);
    assert.equal(expandedText.includes("\u009f"), false);
    assert.ok(expandedText.includes(tab), "expanded detail should preserve tab source");
    const expandedCommandStart = expanded.findIndex((line) => line.includes("bash:"));
    const expandedSecondLine = expanded.findIndex(
      (line, lineIndex) =>
        lineIndex > expandedCommandStart && line.includes("echo") && line.includes("multiline"),
    );
    assert.ok(expandedCommandStart >= 0);
    assert.ok(
      expandedSecondLine > expandedCommandStart,
      "expanded detail should retain the command's original multiline structure",
    );
  });

  it("caps collapsed long single-line command previews at narrow widths", () => {
    const command = `printf '${"alpha beta gamma delta ".repeat(16)}omega'`;
    const job: AsyncJobState = {
      asyncId: "long-single-line-command",
      asyncDir: "/tmp/long-single-line-command",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: 20_000,
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "bash",
          currentToolArgs: command,
          currentToolStartedAt: 19_000,
        },
      ],
    };

    const narrow = buildWidgetLines([job], theme, 42);
    const narrowHintIndex = narrow.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    assert.ok(narrowHintIndex > 0);
    const commandStart = narrow.findIndex((line) => line.includes("bash: printf"));
    assert.ok(commandStart > 0);
    const preview = narrow.slice(commandStart, narrowHintIndex);
    assert.equal(preview.length, 3);
    assert.match(preview.at(-1) ?? "", /…/);
    assert.ok(preview.every((line) => visibleWidth(line) <= 40));
    assert.match(preview.join("\n"), /bash: printf/);
    assert.doesNotMatch(preview.join("\n"), /omega/);

    const expanded = buildWidgetLines([job], theme, 42, true);
    assertWrappedSource(expanded, command);
    assert.match(expanded.join("\n"), /omega/);
  });

  it("keeps compact widget command continuations aligned with long row prefixes", () => {
    const width = 60;
    const command = `printf '${"alpha beta gamma delta ".repeat(18)}omega'`;
    const longAgent = "worker-with-a-very-long-model-prefix";
    const job: AsyncJobState = {
      asyncId: "compact-command-prefix",
      asyncDir: "/tmp/compact-command-prefix",
      status: "running",
      mode: "parallel",
      agents: Array.from({ length: 12 }, () => longAgent),
      runningSteps: 1,
      completedSteps: 11,
      stepsTotal: 12,
      updatedAt: 20_000,
      steps: Array.from({ length: 12 }, (_, index) => ({
        index,
        agent: longAgent,
        status: index === 0 ? ("running" as const) : ("complete" as const),
        model: "provider/super-long-model-name",
        ...(index === 0
          ? {
              currentTool: "bash",
              currentToolArgs: command,
              currentToolStartedAt: 19_000,
            }
          : {}),
      })),
    };

    resetWidgetLayout();
    withStdoutSize(80, width, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [job]);
      const lines = renderWidgetHarnessLines(ui.widgets.at(-1));
      const commandStart = lines.findIndex((line) => line.includes("bash:"));
      const nextStepStart = lines.findIndex(
        (line, lineIndex) => lineIndex > commandStart && line.includes("Agent 2/12"),
      );
      assert.ok(commandStart > 0);
      assert.ok(nextStepStart > commandStart);
      const commandPreview = lines.slice(commandStart, nextStepStart);
      assert.equal(commandPreview.length, 3);
      assert.match(commandPreview[0] ?? "", /^    ⎿  bash:/);
      assert.match(commandPreview.at(-1) ?? "", /…/);
      assert.ok(commandPreview.every((line) => visibleWidth(line) <= width - 2));
      const continuationPrefix = commandPreview[1]?.match(/^\s*/)?.[0] ?? "";
      assert.ok(continuationPrefix.length > 0);
      assert.ok(
        commandPreview.slice(1).every((line) => line.startsWith(continuationPrefix)),
        "command continuation rows should share an explicit alignment prefix",
      );
      assert.ok(
        commandPreview.slice(1).every((line) => line.trim().length > 8),
        "command continuation rows should not degrade to one-character fragments",
      );
      assert.match(commandPreview.join("\n"), /alpha beta gamma/);
      assert.doesNotMatch(commandPreview.join("\n"), /omega/);
      const realLines = renderWithRealPiTui(lines, width);
      assert.equal(realLines.length, lines.length);
      assert.ok(realLines.every((line) => visibleWidth(line) === width));
    });
    resetWidgetLayout();
  });

  it("wraps complete long arguments and output in narrow compact and expanded widgets", () => {
    const width = 42;
    const longArgs = `--path=${"src/deep/".repeat(14)}report.json --query=${"needle-".repeat(18)}`;
    const longOutput = `recent-output-${"value-".repeat(18)}`;
    const longTicket = `Wrap ${"complete-ticket-title-".repeat(10)}`;
    const job: AsyncJobState = {
      asyncId: "narrow-wrap",
      asyncDir: "/tmp/narrow-wrap",
      status: "running",
      mode: "single",
      agents: ["worker"],
      stepsTotal: 1,
      updatedAt: 20_000,
      tkTicket: { id: "tlh-narrow", title: longTicket },
      steps: [
        {
          index: 0,
          agent: "worker",
          status: "running",
          currentTool: "grep",
          currentToolArgs: longArgs,
          recentTools: [{ tool: "grep", args: longArgs, endMs: 1 }],
          recentOutput: [longOutput],
        },
      ],
    };

    const compact = buildWidgetLines([job], theme, width, false);
    assert.ok(compact.length > 3);
    assert.ok(compact.every((line) => visibleWidth(line) <= width - 2));
    const compactHintIndex = compact.findIndex((line) => line.includes("Press Ctrl+Shift+D"));
    assert.ok(compactHintIndex > 0);
    const compactCommandStart = compact.findIndex((line) => line.includes("grep:"));
    assert.ok(compactCommandStart > 0);
    const compactPreview = compact.slice(compactCommandStart, compactHintIndex);
    assert.equal(compactPreview.length, 3);
    assert.match(compactPreview.at(-1) ?? "", /…/);
    assert.match(compactPreview.join(""), /grep:\s+--path=/);
    assert.doesNotMatch(compactPreview.join(""), /needle/);
    assertWrappedSource(compact, longTicket);

    const expanded = buildWidgetLines([job], theme, width, true);
    assert.ok(expanded.length > compact.length);
    assert.ok(expanded.every((line) => visibleWidth(line) <= width - 2));
    assertWrappedSource(expanded, longArgs);
    assertWrappedSource(expanded, longOutput);
    assertWrappedSource(expanded, longTicket);
    assert.doesNotMatch(expanded.join(""), /…|\.\.\./);
  });
});
