import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AsyncJobState, AsyncJobStep } from "../support/render-widget-fixtures.ts";
import {
  assertWrappedSource,
  buildWidgetLines,
  clearLegacyResultAnimationTimer,
  createUiContext,
  createWidgetTestIsolation,
  createWidgetTheme,
  escapeRegExp,
  renderWidget,
  renderWidgetHarnessLines,
  renderWidgetLines,
  renderWithRealPiTui,
  visibleWidth,
  whimsicalThinkingPhrase,
  withStdoutSize,
} from "../support/render-widget-fixtures.ts";

const theme = createWidgetTheme();
const widgetTestIsolation = createWidgetTestIsolation(theme);
beforeEach(widgetTestIsolation.beforeEach);
afterEach(widgetTestIsolation.afterEach);
const resetWidgetLayout = widgetTestIsolation.resetWidgetLayout;

describe("subagent async widget rendering", () => {
  it("hides protected paused lifecycle paths from widget activity", () => {
    const lines = buildWidgetLines(
      [
        {
          asyncId: "paused-1",
          asyncDir: "/tmp/paused-1",
          status: "paused",
          agents: ["worker"],
          currentPath: "/private/root/project/file.ts",
          steps: [
            {
              index: 0,
              agent: "worker",
              status: "paused",
              currentPath: "/private/root/project/file.ts",
              children: [
                {
                  id: "nested-private",
                  parentRunId: "paused-1",
                  depth: 1,
                  path: [],
                  state: "paused",
                  error: "cleanup failed at /private/root/nested.log for pid 54321",
                },
              ],
            },
          ],
        },
      ],
      theme,
      160,
      true,
    );

    const text = lines.join("\n");
    assert.match(text, /paused/);
    assert.match(text, /lifecycle status requires attention/);
    assert.doesNotMatch(text, /\/private\/|54321|cleanup failed/);
  });

  it("projects continued lifecycles as healthy across single, parallel, and compact layouts", () => {
    const staleStep = {
      index: 0,
      agent: "worker",
      status: "running" as const,
      interruptRequestedAt: 20_000,
      currentTool: "stale-tool",
      currentToolStartedAt: 19_000,
      currentPath: "/stale/path.ts",
      activityState: "needs_attention" as const,
      lastActivityAt: 19_000,
    };
    const singleText = buildWidgetLines(
      [
        {
          asyncId: "continued-single",
          asyncDir: "/tmp/continued-single",
          status: "continued",
          mode: "single",
          agents: ["worker"],
          interruptRequestedAt: 20_000,
          currentTool: "stale-job-tool",
          stepsTotal: 1,
          steps: [staleStep],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(singleText, /✓ worker · continued/);
    assert.doesNotMatch(singleText, /✗|pausing|stale-(?:job-)?tool|stale\/path/);

    const parallelText = buildWidgetLines(
      [
        {
          asyncId: "continued-parallel",
          asyncDir: "/tmp/continued-parallel",
          status: "continued",
          mode: "parallel",
          agents: ["worker", "reviewer"],
          stepsTotal: 2,
          steps: [
            staleStep,
            { ...staleStep, index: 1, agent: "reviewer", status: "paused" as const },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(parallelText, /✓ 2\/2 done/);
    assert.match(parallelText, /Agent 1\/2: worker · continued/);
    assert.match(parallelText, /Agent 2\/2: reviewer · continued/);
    assert.doesNotMatch(parallelText, /✗|pausing|stale-tool|stale\/path/);

    const pendingParallelText = buildWidgetLines(
      [
        {
          asyncId: "continued-parallel-pending-tail",
          asyncDir: "/tmp/continued-parallel-pending-tail",
          status: "continued",
          mode: "parallel",
          agents: ["worker", "reviewer", "tail"],
          stepsTotal: 3,
          steps: [
            { ...staleStep, agent: "worker", status: "complete" as const },
            { ...staleStep, index: 1, agent: "reviewer", status: "paused" as const },
            { ...staleStep, index: 2, agent: "tail", status: "pending" as const },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(pendingParallelText, /✓ 2\/3 done/);
    assert.match(pendingParallelText, /Agent 3\/3: tail · pending/);
    assert.doesNotMatch(pendingParallelText, /Agent 3\/3: tail · continued/);

    const buildCompactParallelJob = (status: "continued" | "running"): AsyncJobState => ({
      asyncId: `compact-${status}-parallel`,
      asyncDir: `/tmp/compact-${status}-parallel`,
      status,
      mode: "parallel",
      agents: Array.from({ length: 9 }, (_, index) => `worker-${index + 1}`),
      stepsTotal: 9,
      interruptRequestedAt: 20_000,
      currentTool: "stale-job-tool",
      steps: Array.from({ length: 9 }, (_, index) => ({
        index,
        agent: `worker-${index + 1}`,
        status: "running" as const,
        interruptRequestedAt: 20_000,
        currentTool: "stale-tool",
        currentToolStartedAt: 19_000,
        currentPath: "/stale/path.ts",
        activityState: "needs_attention" as const,
        lastActivityAt: 19_000,
      })),
    });
    resetWidgetLayout();
    withStdoutSize(40, 160, () => {
      const continuedUi = createUiContext();
      renderWidget(continuedUi.ctx as never, [buildCompactParallelJob("continued")]);
      const continuedText = renderWidgetLines(continuedUi.widgets.at(-1), 160).join("\n");
      assert.match(continuedText, /✓/);
      assert.match(continuedText, /continued/);
      assert.doesNotMatch(continuedText, /✗|pausing|stale-(?:job-)?tool|stale\/path|live detail/);

      const runningUi = createUiContext();
      renderWidget(runningUi.ctx as never, [buildCompactParallelJob("running")]);
      const runningText = renderWidgetLines(runningUi.widgets.at(-1), 160).join("\n");
      assert.match(runningText, /Agent 1\/9: worker-1 · pausing · pausing…/);
      assert.match(runningText, /live detail/);
    });
    resetWidgetLayout();
  });

  it("suppresses whimsical phrases while surfacing async and parallel health warnings", () => {
    const now = 20_000;
    const jobs: AsyncJobState[] = [
      {
        asyncId: "health-attention",
        asyncDir: "/tmp/health-attention",
        status: "running",
        mode: "single",
        agents: ["attention"],
        activityState: "needs_attention",
        turnCount: 11,
        lastActivityAt: now - 5_000,
        updatedAt: now,
      },
      {
        asyncId: "health-parallel",
        asyncDir: "/tmp/health-parallel",
        status: "running",
        mode: "parallel",
        agents: ["parallel-worker"],
        runningSteps: 1,
        completedSteps: 0,
        stepsTotal: 1,
        updatedAt: now,
        steps: [
          {
            index: 0,
            agent: "parallel-worker",
            status: "running",
            activityState: "needs_attention",
            turnCount: 13,
            toolCount: 7,
            tokens: { input: 8_000, output: 5_000, total: 13_000 },
            durationMs: 9_000,
            lastActivityAt: now - 5_000,
          },
        ],
      },
    ];
    const text = buildWidgetLines(jobs, theme, 180).join("\n");

    assert.match(text, /no activity for 5s/);
    for (const turnCount of [11, 13])
      assert.doesNotMatch(text, new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));

    const expanded = buildWidgetLines(jobs, theme, 180, true).join("\n");
    assert.match(
      expanded,
      /Agent 1\/1: parallel-worker · no activity for 5s · 13 turns · 7 tools · 13k token · 9\.0s/,
    );
    assert.doesNotMatch(expanded, new RegExp(escapeRegExp(whimsicalThinkingPhrase(13))));
  });

  it("clears recovered health in widget rows without smearing sibling or legacy warnings", () => {
    const now = 20_000;
    const parallelText = buildWidgetLines(
      [
        {
          asyncId: "health-sibling",
          asyncDir: "/tmp/health-sibling",
          status: "running",
          mode: "parallel",
          agents: ["recovered", "idle"],
          activityState: "needs_attention",
          lastActivityAt: now - 5_000,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "recovered",
              status: "running",
              lastActivityAt: now - 1_000,
            },
            {
              index: 1,
              agent: "idle",
              status: "running",
              activityState: "needs_attention",
              lastActivityAt: now - 5_000,
            },
          ],
        },
      ],
      theme,
      180,
      true,
    ).join("\n");
    const recoveredStart = parallelText.indexOf("recovered");
    const idleStart = parallelText.indexOf("idle");
    const recoveredSection = parallelText.slice(
      recoveredStart,
      idleStart >= 0 ? idleStart : undefined,
    );
    assert.match(recoveredSection, /active 1s ago/);
    assert.doesNotMatch(recoveredSection, /no activity|long-running/);
    assert.match(parallelText, /no activity for 5s/);

    const legacyText = buildWidgetLines(
      [
        {
          asyncId: "legacy-health",
          asyncDir: "/tmp/legacy-health",
          status: "running",
          mode: "single",
          agents: ["legacy"],
          lastActivityAt: now - 90_000,
          updatedAt: now,
          steps: [{ index: 0, agent: "legacy", status: "running", lastActivityAt: now - 90_000 }],
        },
      ],
      theme,
      180,
      true,
    ).join("\n");
    assert.match(legacyText, /legacy[\s\S]*active 1m ago/);
    assert.doesNotMatch(legacyText, /no activity for|needs attention/);
  });

  it("keeps aggregate parallel health in progressive summaries without smearing child details", () => {
    const now = 20_000;
    const healthCases = [{ state: "needs_attention", warning: "no activity for 5s" }] as const;

    const makeJobs = (state: (typeof healthCases)[number]["state"]): AsyncJobState[] => [
      {
        asyncId: `progressive-parallel-${state}`,
        asyncDir: `/tmp/progressive-parallel-${state}`,
        status: "running",
        mode: "parallel",
        agents: ["recovered", "attention"],
        activityState: state,
        lastActivityAt: now - 5_000,
        updatedAt: now,
        runningSteps: 2,
        completedSteps: 0,
        stepsTotal: 2,
        steps: [
          {
            index: 0,
            agent: "recovered",
            status: "running",
            turnCount: 31,
            lastActivityAt: now - 1_000,
          },
          {
            index: 1,
            agent: "attention",
            status: "running",
            activityState: state,
            turnCount: 32,
            lastActivityAt: now - 5_000,
          },
        ],
      },
      {
        asyncId: `progressive-read-${state}`,
        asyncDir: `/tmp/progressive-read-${state}`,
        status: "running",
        mode: "single",
        agents: ["reader"],
        currentTool: "read",
      },
      {
        asyncId: `progressive-edit-${state}`,
        asyncDir: `/tmp/progressive-edit-${state}`,
        status: "running",
        mode: "single",
        agents: ["editor"],
        currentTool: "edit",
      },
    ];

    for (const { state, warning } of healthCases) {
      resetWidgetLayout();
      withStdoutSize(22, 120, () => {
        const ui = createUiContext();
        renderWidget(ui.ctx as never, makeJobs(state));
        const lines = renderWidgetHarnessLines(ui.widgets.at(-1));
        const text = lines.join("\n");
        const parallelRow = lines.find((line) => line.includes("parallel")) ?? "";
        assert.match(parallelRow, new RegExp(escapeRegExp(warning)));
        assert.doesNotMatch(parallelRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(31))));
        assert.match(text, /\+2 more/);
      });

      const expandedText = buildWidgetLines([makeJobs(state)[0]!], theme, 180, true).join("\n");
      const recoveredStart = expandedText.indexOf("Agent 1/2: recovered");
      const attentionStart = expandedText.indexOf("Agent 2/2: attention");
      assert.ok(recoveredStart >= 0, "expanded layout must include the recovered child");
      assert.ok(attentionStart > recoveredStart, "expanded layout must keep child order");
      const recoveredSection = expandedText.slice(recoveredStart, attentionStart);
      assert.match(recoveredSection, /active 1s ago/);
      assert.doesNotMatch(recoveredSection, /no activity for|needs attention/);
      assert.match(expandedText.slice(attentionStart), new RegExp(escapeRegExp(warning)));
    }
    resetWidgetLayout();
  });

  it("suppresses health phrases in the constrained progressive row", () => {
    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const now = 20_000;
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "progressive-health",
          asyncDir: "/tmp/progressive-health",
          status: "running",
          mode: "single",
          agents: ["attention"],
          activityState: "needs_attention",
          turnCount: 21,
          lastActivityAt: now - 5_000,
          updatedAt: now,
        },
        {
          asyncId: "progressive-read",
          asyncDir: "/tmp/progressive-read",
          status: "running",
          mode: "single",
          agents: ["reader"],
          currentTool: "read",
        },
        {
          asyncId: "progressive-edit",
          asyncDir: "/tmp/progressive-edit",
          status: "running",
          mode: "single",
          agents: ["editor"],
          currentTool: "edit",
        },
      ]);
      const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      assert.match(text, /attention · no activity for 5s/);
      assert.doesNotMatch(text, new RegExp(escapeRegExp(whimsicalThinkingPhrase(21))));
    });
    resetWidgetLayout();
  });

  it("keeps pausing visible when compact health warnings are present", () => {
    const now = 20_000;
    const parallelText = buildWidgetLines(
      [
        {
          asyncId: "pausing-health-parallel",
          asyncDir: "/tmp/pausing-health-parallel",
          status: "running",
          mode: "parallel",
          agents: ["worker"],
          runningSteps: 1,
          completedSteps: 0,
          stepsTotal: 1,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "worker",
              status: "running",
              interruptRequestedAt: now - 100,
              activityState: "needs_attention",
              turnCount: 23,
              lastActivityAt: now - 5_000,
            },
          ],
        },
        {
          asyncId: "pausing-health-finished",
          asyncDir: "/tmp/pausing-health-finished",
          status: "complete",
          mode: "single",
          agents: ["done"],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(parallelText, /Agent 1\/1: worker · pausing · pausing…/);
    const parallelStep = parallelText.split("\n").find((line) => line.includes("Agent 1/1")) ?? "";
    assert.doesNotMatch(parallelStep, /no activity for|needs attention/);
    assert.doesNotMatch(parallelText, new RegExp(escapeRegExp(whimsicalThinkingPhrase(23))));

    resetWidgetLayout();
    withStdoutSize(22, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "pausing-health-progressive",
          asyncDir: "/tmp/pausing-health-progressive",
          status: "running",
          mode: "single",
          agents: ["pausing-worker"],
          interruptRequestedAt: now - 100,
          activityState: "needs_attention",
          turnCount: 24,
          lastActivityAt: now - 5_000,
          updatedAt: now,
        },
        {
          asyncId: "pausing-health-read",
          asyncDir: "/tmp/pausing-health-read",
          status: "running",
          mode: "single",
          agents: ["reader"],
          currentTool: "read",
        },
        {
          asyncId: "pausing-health-edit",
          asyncDir: "/tmp/pausing-health-edit",
          status: "running",
          mode: "single",
          agents: ["editor"],
          currentTool: "edit",
        },
      ]);
      const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
      const progressiveRow = text.split("\n").find((line) => line.includes("pausing-worker")) ?? "";
      assert.match(progressiveRow, /pausing-worker · pausing…/);
      assert.doesNotMatch(progressiveRow, /no activity for|needs attention/);
      assert.doesNotMatch(progressiveRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(24))));
    });
    resetWidgetLayout();
  });

  it("keeps step-level pausing over each health warning in real progressive rows", () => {
    const now = 20_000;
    const healthCases = [
      { state: "needs_attention", turnCount: 25, warning: /no activity for 5s/ },
    ] as const;

    for (const { state, turnCount, warning } of healthCases) {
      resetWidgetLayout();
      withStdoutSize(22, 120, () => {
        const ui = createUiContext();
        renderWidget(ui.ctx as never, [
          {
            asyncId: `step-pausing-${state}`,
            asyncDir: `/tmp/step-pausing-${state}`,
            status: "running",
            mode: "single",
            agents: ["step-pausing-worker"],
            updatedAt: now,
            steps: [
              {
                index: 0,
                agent: "step-pausing-worker",
                status: "running",
                interruptRequestedAt: now - 100,
                activityState: state,
                turnCount,
                lastActivityAt: now - 5_000,
              },
            ],
          },
          {
            asyncId: `step-pausing-read-${state}`,
            asyncDir: "/tmp/step-pausing-read",
            status: "running",
            mode: "single",
            agents: ["reader"],
            currentTool: "read",
          },
          {
            asyncId: `step-pausing-edit-${state}`,
            asyncDir: "/tmp/step-pausing-edit",
            status: "running",
            mode: "single",
            agents: ["editor"],
            currentTool: "edit",
          },
        ]);

        const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
        const harnessRow = harnessLines.find((line) => line.includes("step-pausing-worker")) ?? "";
        assert.match(harnessRow, /step-pausing-worker · pausing…/);
        assert.doesNotMatch(harnessRow, warning);
        assert.doesNotMatch(harnessRow, /needs attention/);
        assert.doesNotMatch(
          harnessRow,
          new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))),
        );

        const realLines = renderWithRealPiTui(harnessLines, 120);
        const realRow = realLines.find((line) => line.includes("step-pausing-worker")) ?? "";
        assert.match(realRow, /step-pausing-worker · pausing…/);
        assert.doesNotMatch(realRow, warning);
        assert.doesNotMatch(realRow, /needs attention/);
        assert.doesNotMatch(realRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));
      });
    }
    resetWidgetLayout();
  });

  it("shows aggregate N agents pausing cue while suppressing running labels", () => {
    const now = 20_000;
    const text = buildWidgetLines(
      [
        {
          asyncId: "parallel-pausing-aggregate",
          asyncDir: "/tmp/parallel-pausing-aggregate",
          status: "running" as const,
          mode: "parallel" as const,
          agents: ["worker-1", "worker-2", "worker-3"],
          runningSteps: 2,
          completedSteps: 1,
          stepsTotal: 3,
          interruptRequestedAt: now - 100,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "worker-1",
              status: "running" as const,
              interruptRequestedAt: now - 100,
            },
            {
              index: 1,
              agent: "worker-2",
              status: "running" as const,
              interruptRequestedAt: now - 100,
            },
            { index: 2, agent: "worker-3", status: "complete" as const },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");
    // Aggregate pausing cue must be visible
    assert.match(text, /2 agents pausing/);
    // Running labels must be suppressed even when running steps exist
    assert.doesNotMatch(text, /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
  });

  it("shows step-level pausing label while suppressing running label for non-pausing steps", () => {
    const now = 20_000;
    const text = buildWidgetLines(
      [
        {
          asyncId: "step-pausing-mixed",
          asyncDir: "/tmp/step-pausing-mixed",
          status: "running" as const,
          mode: "parallel" as const,
          agents: ["pausing-worker", "active-worker"],
          runningSteps: 2,
          completedSteps: 0,
          stepsTotal: 2,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "pausing-worker",
              status: "running" as const,
              interruptRequestedAt: now - 100,
            },
            { index: 1, agent: "active-worker", status: "running" as const },
          ],
        },
      ],
      theme,
      180,
    ).join("\n");
    // Step-level pausing label must be visible for the interrupt-requested step
    assert.match(text, /Agent 1\/2: pausing-worker · pausing/);
    // The non-pausing running step must not show a running label
    assert.doesNotMatch(text, /active-worker · running/);
    // No running labels anywhere in output
    assert.doesNotMatch(text, /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
  });

  it("does not leak pausing child activity into a multi-job aggregate", () => {
    const now = 20_000;
    const text = buildWidgetLines(
      [
        {
          asyncId: "pausing-child-aggregate",
          asyncDir: "/tmp/pausing-child-aggregate",
          status: "running",
          mode: "parallel",
          agents: ["worker"],
          runningSteps: 1,
          completedSteps: 0,
          stepsTotal: 1,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "worker",
              status: "running",
              interruptRequestedAt: now - 100,
              currentTool: "child-secret-tool",
              currentToolArgs: "--secret-child-args",
              currentToolStartedAt: now - 4_000,
              currentPath: "/private/child/project/secret.ts",
            },
          ],
        },
        {
          asyncId: "pausing-child-finished",
          asyncDir: "/tmp/pausing-child-finished",
          status: "complete",
          mode: "single",
          agents: ["done"],
        },
      ],
      theme,
      180,
    ).join("\n");

    assert.match(text, /⎿  pausing…/);
    assert.match(text, /Agent 1\/1: worker · pausing · pausing…/);
    assert.doesNotMatch(text, /child-secret-tool|secret-child-args|private\/child|4\.0s/);
  });

  it("uses only job-level tool data while showing a pausing activity", () => {
    const now = 20_000;
    const childOnly = buildWidgetLines(
      [
        {
          asyncId: "pausing-child-only",
          asyncDir: "/tmp/pausing-child-only",
          status: "running",
          mode: "single",
          agents: ["worker"],
          interruptRequestedAt: now - 100,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "worker",
              status: "running",
              currentTool: "child-secret",
              currentToolStartedAt: now - 4_000,
            },
          ],
        },
        {
          asyncId: "pausing-finished",
          asyncDir: "/tmp/pausing-finished",
          status: "complete",
          mode: "single",
          agents: ["done"],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(childOnly, /pausing…/);
    assert.doesNotMatch(childOnly, /child-secret/);

    const jobTool = buildWidgetLines(
      [
        {
          asyncId: "pausing-job-tool",
          asyncDir: "/tmp/pausing-job-tool",
          status: "running",
          mode: "single",
          agents: ["worker"],
          interruptRequestedAt: now - 100,
          currentTool: "job-tool",
          currentToolStartedAt: now - 2_000,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "worker",
              status: "running",
              currentTool: "child-secret",
              currentToolStartedAt: now - 4_000,
            },
          ],
        },
        {
          asyncId: "pausing-finished-2",
          asyncDir: "/tmp/pausing-finished-2",
          status: "complete",
          mode: "single",
          agents: ["done"],
        },
      ],
      theme,
      180,
    ).join("\n");
    assert.match(jobTool, /pausing… · job-tool 2\.0s/);
    assert.doesNotMatch(jobTool, /child-secret/);
  });

  it("keeps compactSingleWidgetLines health identity in 40/50-column parallel rows", () => {
    const now = 20_000;
    const healthCases = [
      { state: "needs_attention", turnCount: 27, warning: "no activity for 5s" },
    ] as const;

    for (const width of [40, 50]) {
      for (const { state, turnCount, warning } of healthCases) {
        resetWidgetLayout();
        withStdoutSize(60, width, () => {
          const ui = createUiContext();
          renderWidget(ui.ctx as never, [
            {
              asyncId: `narrow-health-${state}`,
              asyncDir: `/tmp/narrow-health-${state}`,
              status: "running",
              mode: "parallel",
              agents: ["worker", "worker", "worker", "worker"],
              runningSteps: 4,
              completedSteps: 0,
              stepsTotal: 4,
              updatedAt: now,
              steps: Array.from({ length: 4 }, (_, index) => ({
                index,
                agent: "worker",
                status: "running",
                activityState: state,
                turnCount,
                lastActivityAt: now - 5_000,
              })),
            },
          ]);

          const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
          const harnessRow = harnessLines.find((line) => line.includes("Agent 1/4")) ?? "";
          assert.match(harnessRow, /Agent 1\/4/);
          assertWrappedSource(harnessLines, warning);
          assert.doesNotMatch(
            harnessLines.join(""),
            new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))),
          );
          for (const line of harnessLines)
            assert.ok(
              visibleWidth(line) <= width - 2,
              `harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
            );

          const realLines = renderWithRealPiTui(harnessLines, width);
          assert.equal(
            realLines.length,
            harnessLines.length,
            `real pi-tui Text must not add continuation rows at ${width} columns for ${state}`,
          );
          const realRow = realLines.find((line) => line.includes("Agent 1/4")) ?? "";
          assert.match(realRow, /Agent 1\/4/);
          assertWrappedSource(realLines, warning, true);
          assert.doesNotMatch(
            realLines.join(""),
            new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))),
          );
          for (const line of realLines)
            assert.equal(
              visibleWidth(line),
              width,
              `real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
            );
        });
      }
    }
    resetWidgetLayout();
  });

  it("wraps complete progressive health warnings at 40/50 columns", () => {
    const now = 20_000;
    for (const width of [40, 50]) {
      resetWidgetLayout();
      withStdoutSize(24, width, () => {
        const ui = createUiContext();
        renderWidget(ui.ctx as never, [
          {
            asyncId: "progressive-health",
            asyncDir: "/tmp/progressive-health",
            status: "running",
            mode: "single",
            agents: ["health-job"],
            activityState: "needs_attention",
            lastActivityAt: now - 5_000,
            updatedAt: now,
          },
          {
            asyncId: "progressive-read",
            asyncDir: "/tmp/progressive-read",
            status: "running",
            mode: "single",
            agents: ["reader"],
            currentTool: "read",
          },
          {
            asyncId: "progressive-edit",
            asyncDir: "/tmp/progressive-edit",
            status: "running",
            mode: "single",
            agents: ["editor"],
            currentTool: "edit",
          },
          {
            asyncId: "progressive-write",
            asyncDir: "/tmp/progressive-write",
            status: "running",
            mode: "single",
            agents: ["writer"],
            currentTool: "write",
          },
          {
            asyncId: "progressive-extra",
            asyncDir: "/tmp/progressive-extra",
            status: "running",
            mode: "single",
            agents: ["extra"],
            currentTool: "test",
          },
        ]);

        const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
        const harnessRow = harnessLines.find((line) => line.includes("health-job")) ?? "";
        assert.match(harnessRow, /health-job/);
        assertWrappedSource(harnessLines, "no activity for 5s");
        assert.match(harnessLines.join(""), /\+\d+ more/);
        for (const line of harnessLines)
          assert.ok(
            visibleWidth(line) <= width - 2,
            `harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
          );

        const realLines = renderWithRealPiTui(harnessLines, width);
        assert.equal(
          realLines.length,
          harnessLines.length,
          `real pi-tui Text must not add continuation rows at ${width} columns`,
        );
        const realRow = realLines.find((line) => line.includes("health-job")) ?? "";
        assert.match(realRow, /health-job/);
        assertWrappedSource(realLines, "no activity for 5s", true);
        for (const line of realLines)
          assert.equal(
            visibleWidth(line),
            width,
            `real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
          );
      });
    }
    resetWidgetLayout();
  });

  it("keeps widgetParallelAgentDetails identity with compact health warnings at 40/50 columns", () => {
    const now = 20_000;
    const healthCases = [{ state: "needs_attention", warning: "no activity for 5s" }] as const;
    for (const width of [40, 50]) {
      for (const { state, warning } of healthCases) {
        const lines = buildWidgetLines(
          [
            {
              asyncId: `parallel-detail-health-${state}`,
              asyncDir: `/tmp/parallel-detail-health-${state}`,
              status: "running",
              mode: "parallel",
              agents: ["worker", "worker", "worker", "worker"],
              runningSteps: 4,
              completedSteps: 0,
              stepsTotal: 4,
              updatedAt: now,
              steps: Array.from({ length: 4 }, (_, index) => ({
                index,
                agent: "worker",
                status: "running",
                activityState: state,
                lastActivityAt: now - 5_000,
              })),
            },
            {
              asyncId: `parallel-detail-done-${state}`,
              asyncDir: "/tmp/parallel-detail-done",
              status: "complete",
              mode: "single",
              agents: ["done"],
            },
          ],
          theme,
          width,
        );
        const harnessRow = lines.find((line) => line.includes("Agent 1/4")) ?? "";
        assert.match(harnessRow, /Agent 1\/4/);
        assertWrappedSource(lines, warning);
        for (const line of lines)
          assert.ok(
            visibleWidth(line) <= width - 2,
            `harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
          );

        const realLines = renderWithRealPiTui(lines, width);
        assert.equal(
          realLines.length,
          lines.length,
          `real pi-tui Text must not add continuation rows at ${width} columns for ${state}`,
        );
        const realRow = realLines.find((line) => line.includes("Agent 1/4")) ?? "";
        assert.match(realRow, /Agent 1\/4/);
        assertWrappedSource(realLines, warning, true);
        for (const line of realLines)
          assert.equal(
            visibleWidth(line),
            width,
            `real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
          );
      }
    }
  });

  it("surfaces job-level health state in compact single-job renders with and without steps", () => {
    // tlhmf-auxo: job-level activityState is a staleness signal ("a run may be stuck"),
    // not flavour text like whimsicalThinkingPhrase. It must survive the compact
    // single-job render in BOTH branches of the single-job detail builders:
    //   - with steps    -> singleWidgetAgentDetails `if (step)` /
    //                      foregroundStyleWidgetDetails steps loop (needs jobHealthWarningLines)
    //   - without steps -> those builders' no-steps branch (already calls
    //                      widgetActivityDetailLines(job, ...))
    const now = 200_000;
    const lastActivityAt = now - 180_000; // 3m gap: avoids the "now ago" strings owned by tlhmf-6y0z
    for (const [activityState, expected] of [["needs_attention", /no activity for 3m/] as const]) {
      for (const [label, mode, steps, expectedHeight] of [
        ["single mode with steps", "single", 1, 5],
        ["single mode without steps", "single", 0, 3],
        ["parallel mode with steps", "parallel", 3, 7],
        ["parallel mode without steps", "parallel", 0, 3],
      ] as const) {
        resetWidgetLayout();
        withStdoutSize(30, 120, () => {
          const ui = createUiContext();
          const job: AsyncJobState = {
            asyncId: `health-${mode}-${steps}`,
            asyncDir: "/tmp/health",
            status: "running",
            mode,
            agents:
              steps > 0 ? Array.from({ length: steps }, (_, i) => `agent-${i}`) : ["developer"],
            activityState,
            lastActivityAt,
            updatedAt: now,
            ...(mode === "parallel"
              ? {
                  runningSteps: steps,
                  completedSteps: 0,
                  stepsTotal: Math.max(1, steps),
                }
              : {}),
            ...(steps > 0
              ? {
                  // Deliberately no step-level activityState: this is the shape that lost
                  // the signal before jobHealthWarningLines existed.
                  steps: Array.from({ length: steps }, (_, i) => ({
                    index: i,
                    agent: `agent-${i}`,
                    status: "running" as const,
                  })),
                }
              : {}),
          };

          renderWidget(ui.ctx as never, [job]);
          const lines = renderWidgetLines(ui.widgets.at(-1));
          const text = lines.join("\n");

          assert.match(text, expected, `${activityState} health signal must survive: ${label}`);
          assert.equal(
            lines.filter((line) => expected.test(line)).length,
            1,
            `${activityState} health signal must appear exactly once: ${label}`,
          );
          assert.equal(lines.length, expectedHeight, `${activityState} render height: ${label}`);
          assert.ok(!lines.join("").includes("\u200c"), `must not emit filler rows: ${label}`);
        });
      }
    }
    resetWidgetLayout();
  });

  it("single-agent health warning deduplicates when step already surfaces same text", () => {
    // In single mode the health warning is placed under the agent row (not
    // the header) and is deduplicated against widgetStepActivityLines. When the step
    // and job both carry the same activityState, the step already renders the health
    // text, so the job-level line is suppressed – the signal appears exactly once.
    const now = 200_000;
    const lastActivityAt = now - 180_000;
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "health-always-emit",
          asyncDir: "/tmp/health-always-emit",
          status: "running",
          mode: "single",
          agents: ["developer"],
          activityState: "needs_attention",
          lastActivityAt,
          updatedAt: now,
          steps: [
            {
              index: 0,
              agent: "developer",
              status: "running",
              activityState: "needs_attention",
              lastActivityAt,
            },
          ],
        },
      ]);
      const lines = renderWidgetLines(ui.widgets.at(-1));
      // Step already shows the health text; job-level line is deduped, so appears
      // exactly once (under the agent row, not the header).
      assert.equal(
        lines.filter((line) => /no activity for 3m/.test(line)).length,
        1,
        "health text must appear exactly once when step already surfaces the same state",
      );
      assert.equal(
        lines.length,
        4,
        "deduped single-agent health render has 4 lines: header + agent + health + hint",
      );
      // The health line must be at 4-space indent (under the agent row), not the
      // 2-space indent that would place it under the header.
      const healthLine = lines.find((l) => /no activity for 3m/.test(l));
      assert.ok(
        healthLine?.startsWith("    "),
        "health line must be at 4-space indent (nested under agent row)",
      );
      // Must NOT appear at the 2-space (header-region) indent.
      assert.ok(
        !healthLine?.match(/^  [^ ]/),
        "health line must not be at 2-space (header-level) indent",
      );
      // Ordering: agent row is at index 1 (header is 0); health text (from step
      // activity in details.slice(1)) must follow the agent row.
      const agentRowIndex = 1;
      const healthIndex = lines.findIndex((l) => /no activity for 3m/.test(l));
      assert.ok(healthIndex > agentRowIndex, "health text must appear after the agent row");
      // The live-detail hint must be the last line of the agent block.
      assert.match(
        lines.at(-1) ?? "",
        /for live detail/,
        "live-detail hint must be the last line of the block",
      );
    });
    resetWidgetLayout();
  });

  it("single-agent health warning nests under agent row when step has no matching health text", () => {
    // When the step does not carry the same health state (no step-level
    // activityState), the job-level health warning must appear nested under the agent
    // row at 4-space indent, not under the header at 2-space indent.
    const now = 200_000;
    const lastActivityAt = now - 180_000;
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "health-nesting",
          asyncDir: "/tmp/health-nesting",
          status: "running",
          mode: "single",
          agents: ["developer"],
          activityState: "needs_attention",
          lastActivityAt,
          updatedAt: now,
          steps: [
            {
              // Step carries NO activityState: step row shows a thinking phrase, not
              // the health text. The job-level warning must appear (not deduped) and
              // land under the agent row.
              index: 0,
              agent: "developer",
              status: "running" as const,
            },
          ],
        },
      ]);
      const lines = renderWidgetLines(ui.widgets.at(-1));
      const healthLine = lines.find((l) => /no activity for 3m/.test(l));
      assert.ok(healthLine !== undefined, "health warning must appear");
      // Must be at 4-space indent (under the agent row).
      assert.ok(
        healthLine?.startsWith("    "),
        "health line must be at 4-space indent (nested under agent row)",
      );
      // Must not be at 2-space indent (header region).
      assert.ok(
        !healthLine?.match(/^  [^ ]/),
        "health line must not be at 2-space (header-level) indent",
      );
      // Header line must NOT contain the health text (it stays as 'async subagent').
      assert.doesNotMatch(lines[0]!, /no activity for 3m/, "header must not carry health text");
      // Ordering: health line must be immediately after the agent row (index 1).
      const agentRowIndex = 1;
      const healthIdx = lines.findIndex((l) => /no activity for 3m/.test(l));
      assert.equal(
        healthIdx,
        agentRowIndex + 1,
        "health line must be immediately after the agent row (row 3)",
      );
      // The live-detail hint must be the last line of the agent block.
      assert.match(
        lines.at(-1) ?? "",
        /for live detail/,
        "live-detail hint must be the last line of the block",
      );
    });
    resetWidgetLayout();
  });

  it("multi-agent health warning placement is unchanged: stays under the header", () => {
    // Scope guardrail: multi-agent and parallel jobs must keep the current
    // header-level placement. The health warning must appear before the agent rows,
    // not nested under any individual agent.
    const now = 200_000;
    const lastActivityAt = now - 180_000;
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const ui = createUiContext();
      renderWidget(ui.ctx as never, [
        {
          asyncId: "health-multi",
          asyncDir: "/tmp/health-multi",
          status: "running",
          mode: "parallel",
          agents: ["agent-0", "agent-1"],
          activityState: "needs_attention",
          lastActivityAt,
          updatedAt: now,
          stepsTotal: 2,
          runningSteps: 2,
          completedSteps: 0,
          steps: [
            { index: 0, agent: "agent-0", status: "running" as const },
            { index: 1, agent: "agent-1", status: "running" as const },
          ],
        },
      ]);
      const lines = renderWidgetLines(ui.widgets.at(-1));
      const healthIndex = lines.findIndex((l) => /no activity for 3m/.test(l));
      assert.ok(healthIndex !== -1, "health warning must appear");
      // For parallel mode the health line is at 2-space indent (header region).
      assert.ok(
        lines[healthIndex]!.startsWith("  ") && !lines[healthIndex]!.startsWith("    "),
        "parallel health line must be at 2-space (header-level) indent",
      );
      // The agent rows come after the health warning.
      const firstAgentIndex = lines.findIndex((l) => /agent-0/.test(l));
      assert.ok(
        firstAgentIndex > healthIndex,
        "health warning must appear before the agent rows in parallel mode",
      );
    });
    resetWidgetLayout();
  });

  it("job-level health warning survives fitWidgetLineBudget truncation when step rows are cut", () => {
    // tlhmf-ve09 (truncation safety): reviewer probe – a 15-step job rendered ten rows
    // ending in the expand hint with NO health warning. The old unsound dedupe suppressed
    // the job-level warning when a running step already carried a health activityState,
    // but step rows are cut AFTER jobHealthWarningLines runs. The fix: always emit the
    // job-level warning under the header (the only truncation-safe region).
    //
    // Shape: parallel job, 15 steps. The FIRST 13 steps carry currentTool (so their rows
    // render without an inline health signal). Steps 13-14 carry needs_attention without
    // currentTool (the steps that would trigger the old dedupe). At 30 rows,
    // collapsedWidgetLineBudget(30)=10; with 2-line header + 15 step rows + hint = 18+
    // lines the budget forces truncation, cutting steps 7-14 (the health-carrying ones).
    // Without the job-level warning, no health signal survives. With the fix, the job-level
    // warning at position 2 (header-region) is guaranteed to survive.
    const now = 200_000;
    const lastActivityAt = now - 180_000;
    resetWidgetLayout();
    withStdoutSize(30, 120, () => {
      const ui = createUiContext();
      // First 13 steps: running with a currentTool (no inline health warning in step row)
      const earlySteps: AsyncJobStep[] = Array.from({ length: 13 }, (_, i) => ({
        index: i,
        agent: `agent-${i}`,
        status: "running" as const,
        currentTool: "read",
      }));
      // Last 2 steps: running with needs_attention, no currentTool
      // These are the steps that trigger the old dedupe AND would appear beyond the budget.
      const lateSteps: AsyncJobStep[] = Array.from({ length: 2 }, (_, i) => ({
        index: 13 + i,
        agent: `agent-${13 + i}`,
        status: "running" as const,
        activityState: "needs_attention" as const,
        lastActivityAt,
      }));
      const steps = [...earlySteps, ...lateSteps];
      renderWidget(ui.ctx as never, [
        {
          asyncId: "health-truncation",
          asyncDir: "/tmp/health-truncation",
          status: "running",
          mode: "parallel",
          agents: steps.map((s) => s.agent),
          activityState: "needs_attention",
          lastActivityAt,
          updatedAt: now,
          stepsTotal: 15,
          runningSteps: 15,
          completedSteps: 0,
          steps,
        },
      ]);
      const lines = renderWidgetLines(ui.widgets.at(-1));
      // Verify truncation happened so this test is meaningful.
      assert.ok(
        lines.some((l) => /lines hidden/.test(l)),
        "render must be truncated (expand hint must appear) for this test to be meaningful",
      );
      // The health-carrying late steps are beyond the budget, so no step-level signal
      // survives. Only the job-level warning (truncation-safe header region) remains.
      assert.ok(
        lines.some((l) => /no activity for 3m/.test(l)),
        "job-level health warning must survive fitWidgetLineBudget truncation even when health-carrying step rows are cut",
      );
    });
    resetWidgetLayout();
  });

  it("does not animate queued-only widgets", async () => {
    const ui = createUiContext();
    renderWidget(ui.ctx as never, [
      { asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] },
    ]);
    const initialWidgetCount = ui.widgets.length;
    await new Promise((resolve) => setTimeout(resolve, 190));
    assert.equal(
      ui.widgets.length,
      initialWidgetCount,
      "static queued widget should not refresh at animation cadence",
    );
    assert.equal(ui.renderRequests, 0);
  });

  it("clears legacy result row animation timers", async () => {
    let ticks = 0;
    const context = {
      state: {
        subagentResultAnimationTimer: setInterval(() => {
          ticks += 1;
        }, 10),
      },
    };
    try {
      clearLegacyResultAnimationTimer(context);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(context.state.subagentResultAnimationTimer, undefined);
      assert.equal(ticks, 0, "legacy timer should be cleared before it can tick");
    } finally {
      if (context.state.subagentResultAnimationTimer)
        clearInterval(context.state.subagentResultAnimationTimer);
    }
  });

  it("does not refresh running widgets at animation cadence", async () => {
    const ui = createUiContext();
    renderWidget(ui.ctx as never, [
      { asyncId: "run-static", asyncDir: "/tmp/run", status: "running", agents: ["scout"] },
    ]);
    const initialWidgetCount = ui.widgets.length;
    await new Promise((resolve) => setTimeout(resolve, 190));
    assert.equal(
      ui.widgets.length,
      initialWidgetCount,
      "running widget should wait for status updates instead of animation ticks",
    );
    assert.equal(ui.renderRequests, 0);

    renderWidget(ui.ctx as never, []);
    const afterClearCount = ui.widgets.length;
    await new Promise((resolve) => setTimeout(resolve, 190));
    assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stay quiet");
    assert.equal(ui.widgets.at(-1), undefined);
  });
});
