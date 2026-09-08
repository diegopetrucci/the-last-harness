/**
 * Tests for child-location TUI rendering (ts-ehap / ts-3b4i).
 *
 * Primary assertion target: buildWidgetComponent — the real widget entry point.
 * This exercises all three collapsed/expanded routes:
 *   - collapsed single job  → compactSingleWidgetLines
 *   - collapsed multi-job   → widgetParallelAgentDetails
 *   - expanded              → foregroundStyleWidgetStepLines (original wired path)
 *
 * Secondary tests cover the foreground renderSubagentResult paths.
 *
 * For each context: absent case, five content cases, and narrow-terminal wrapping.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildWidgetLines, renderSubagentResult } from "../../src/tui/render.ts";
import { buildWidgetComponent, resetWidgetLayoutSession } from "../../src/tui/render-widget.ts";
import type { AsyncJobState, Details, SubagentToolResult } from "../../src/shared/types.ts";
import {
  parsePersistedChildLocationSnapshot,
  type ChildLocationSnapshot,
} from "../../src/shared/child-location.ts";

// ---------------------------------------------------------------------------
// Minimal theme (no ANSI escape sequences so assertions are on plain text)
// ---------------------------------------------------------------------------

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

// ---------------------------------------------------------------------------
// Snapshots representing the five content cases
// ---------------------------------------------------------------------------

/** Case 1: different directory inside the same repo, different branch */
const diffDirSameRepo: ChildLocationSnapshot = {
  childCwd: "/repos/myrepo/packages/api",
  displayPath: "packages/api",
  branch: "feature-x",
};

/** Case 2: linked worktree of the same repo (different toplevel, same common-dir) */
const linkedWorktree: ChildLocationSnapshot = {
  childCwd: "/repos/myrepo-worktree",
  displayPath: "~/repos/myrepo-worktree",
  linkedWorktree: true,
  branch: "feature-x",
};

/** Case 3: child is in a completely different repository */
const diffRepo: ChildLocationSnapshot = {
  childCwd: "/repos/other-service",
  displayPath: "~/repos/other-service",
  repoName: "other-service",
  branch: "main",
};

/** Case 4: child cwd is not inside any git repository */
const notGit: ChildLocationSnapshot = {
  childCwd: "/tmp/scratch",
  displayPath: "~/tmp/scratch",
  notAGitRepo: true,
};

/** Case 5: detached HEAD */
const detachedHead: ChildLocationSnapshot = {
  childCwd: "/repos/myrepo/packages/api",
  displayPath: "packages/api",
  detachedHead: "abc1234",
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

function makeJob(
  childLocation: ChildLocationSnapshot | undefined,
  mode: "single" | "parallel" = "single",
): AsyncJobState {
  if (mode === "single") {
    return {
      asyncId: "test-run",
      asyncDir: "/tmp/test-run",
      status: "running",
      mode: "single",
      agents: ["test-agent"],
      startedAt: 0,
      updatedAt: 1000,
      steps: [{ index: 0, agent: "test-agent", status: "running", childLocation }],
      stepsTotal: 1,
    };
  }
  // parallel: two steps with independent childLocations
  return {
    asyncId: "test-run",
    asyncDir: "/tmp/test-run",
    status: "running",
    mode: "parallel",
    agents: ["agent-a", "agent-b"],
    startedAt: 0,
    updatedAt: 1000,
    steps: [
      { index: 0, agent: "agent-a", status: "running", childLocation },
      { index: 1, agent: "agent-b", status: "running", childLocation },
    ],
    stepsTotal: 2,
  };
}

function makeToolResult(
  childLocation: ChildLocationSnapshot | undefined,
  mode: "single" | "parallel" = "single",
): SubagentToolResult<Details> {
  const singleResult = (loc: ChildLocationSnapshot | undefined) => ({
    agent: "test-agent",
    task: "do something",
    exitCode: 0,
    usage: ZERO_USAGE,
    childLocation: loc,
  });

  const details: Details =
    mode === "single"
      ? { mode: "single", results: [singleResult(childLocation)] }
      : {
          mode: "parallel",
          results: [singleResult(childLocation), singleResult(childLocation)],
        };

  return {
    content: [{ type: "text" as const, text: "done" }],
    details,
  };
}

// ---------------------------------------------------------------------------
// Widget: single-step job
// ---------------------------------------------------------------------------

describe("child-location widget single", () => {
  it("renders nothing when childLocation is absent", () => {
    const lines = buildWidgetLines([makeJob(undefined)], theme as any, 120, false).join("\n");
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch", () => {
    const lines = buildWidgetLines([makeJob(diffDirSameRepo)], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
    assert.doesNotMatch(lines, /repo:/);
    assert.doesNotMatch(lines, /linked worktree/);
    assert.doesNotMatch(lines, /no git repo/);
  });

  it("case 2: linked worktree — shows cwd, linked worktree marker, and branch", () => {
    const lines = buildWidgetLines([makeJob(linkedWorktree)], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: ~\/repos\/myrepo-worktree/);
    assert.match(lines, /linked worktree/);
    assert.match(lines, /branch: feature-x/);
    assert.doesNotMatch(lines, /repo:/);
  });

  it("case 3: different repo — shows cwd, repo, and branch", () => {
    const lines = buildWidgetLines([makeJob(diffRepo)], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: ~\/repos\/other-service/);
    assert.match(lines, /repo: other-service/);
    assert.match(lines, /branch: main/);
    assert.doesNotMatch(lines, /linked worktree/);
  });

  it("case 4: non-git child — shows cwd and no git repo marker", () => {
    const lines = buildWidgetLines([makeJob(notGit)], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: ~\/tmp\/scratch/);
    assert.match(lines, /no git repo/);
    assert.doesNotMatch(lines, /branch:/);
  });

  it("case 5: detached HEAD — shows cwd and branch: detached@sha", () => {
    const lines = buildWidgetLines([makeJob(detachedHead)], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: detached@abc1234/);
    assert.doesNotMatch(lines, /repo:/);
  });

  it("renders in terminal (complete) lifecycle state too", () => {
    const job: AsyncJobState = {
      ...makeJob(diffDirSameRepo),
      status: "complete",
      steps: [
        { index: 0, agent: "test-agent", status: "complete", childLocation: diffDirSameRepo },
      ],
    };
    const lines = buildWidgetLines([job], theme as any, 120, false).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });
});

// ---------------------------------------------------------------------------
// Widget: parallel job (two steps)
// ---------------------------------------------------------------------------

describe("child-location widget parallel", () => {
  it("renders nothing when childLocation is absent", () => {
    const lines = buildWidgetLines([makeJob(undefined, "parallel")], theme as any, 120, false).join(
      "\n",
    );
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch for each step", () => {
    const lines = buildWidgetLines(
      [makeJob(diffDirSameRepo, "parallel")],
      theme as any,
      120,
      false,
    ).join("\n");
    // Both steps should carry the child-location line
    const matchCount = (lines.match(/cwd: packages\/api/g) ?? []).length;
    assert.equal(matchCount, 2, "expected one cwd line per parallel step");
    assert.match(lines, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree marker", () => {
    const lines = buildWidgetLines(
      [makeJob(linkedWorktree, "parallel")],
      theme as any,
      120,
      false,
    ).join("\n");
    assert.match(lines, /linked worktree/);
  });

  it("case 3: different repo — shows repo name", () => {
    const lines = buildWidgetLines([makeJob(diffRepo, "parallel")], theme as any, 120, false).join(
      "\n",
    );
    assert.match(lines, /repo: other-service/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    const lines = buildWidgetLines([makeJob(notGit, "parallel")], theme as any, 120, false).join(
      "\n",
    );
    assert.match(lines, /no git repo/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    const lines = buildWidgetLines(
      [makeJob(detachedHead, "parallel")],
      theme as any,
      120,
      false,
    ).join("\n");
    assert.match(lines, /branch: detached@abc1234/);
  });
});

// ---------------------------------------------------------------------------
// Foreground compact: single result
// ---------------------------------------------------------------------------

describe("child-location foreground compact single", () => {
  function render(loc: ChildLocationSnapshot | undefined, width = 120): string {
    const component = renderSubagentResult(makeToolResult(loc), { expanded: false }, theme as any);
    return component.render(width).join("\n");
  }

  it("renders nothing when childLocation is absent", () => {
    assert.doesNotMatch(render(undefined), /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch", () => {
    const out = render(diffDirSameRepo);
    assert.match(out, /cwd: packages\/api/);
    assert.match(out, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree and branch", () => {
    const out = render(linkedWorktree);
    assert.match(out, /cwd: ~\/repos\/myrepo-worktree/);
    assert.match(out, /linked worktree/);
    assert.match(out, /branch: feature-x/);
  });

  it("case 3: different repo — shows repo and branch", () => {
    const out = render(diffRepo);
    assert.match(out, /repo: other-service/);
    assert.match(out, /branch: main/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    const out = render(notGit);
    assert.match(out, /no git repo/);
    assert.doesNotMatch(out, /branch:/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    const out = render(detachedHead);
    assert.match(out, /branch: detached@abc1234/);
  });

  it("narrow terminal: long path wraps rather than being lost", () => {
    // At a very narrow width the line should wrap — the cwd: label must still appear
    const out = render(diffRepo, 20);
    assert.match(out, /cwd:/);
  });

  it("renders in terminal (exitCode=0, not running) lifecycle state", () => {
    // The absent ticket line confirms we do NOT gate on active/running
    const out = render(diffDirSameRepo);
    assert.match(out, /cwd: packages\/api/);
  });
});

// ---------------------------------------------------------------------------
// Foreground compact: parallel results
// ---------------------------------------------------------------------------

describe("child-location foreground compact multi", () => {
  function render(loc: ChildLocationSnapshot | undefined, width = 120): string {
    const component = renderSubagentResult(
      makeToolResult(loc, "parallel"),
      { expanded: false },
      theme as any,
    );
    return component.render(width).join("\n");
  }

  it("renders nothing when childLocation is absent", () => {
    assert.doesNotMatch(render(undefined), /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd for each result", () => {
    const out = render(diffDirSameRepo);
    const matchCount = (out.match(/cwd: packages\/api/g) ?? []).length;
    assert.equal(matchCount, 2, "expected one cwd line per result");
    assert.match(out, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree", () => {
    assert.match(render(linkedWorktree), /linked worktree/);
  });

  it("case 3: different repo — shows repo name", () => {
    assert.match(render(diffRepo), /repo: other-service/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    assert.match(render(notGit), /no git repo/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    assert.match(render(detachedHead), /branch: detached@abc1234/);
  });

  it("narrow terminal: wraps without crashing", () => {
    const out = render(diffRepo, 20);
    assert.match(out, /cwd:/);
  });
});

// ---------------------------------------------------------------------------
// Foreground expanded: single result
// ---------------------------------------------------------------------------

describe("child-location foreground expanded single", () => {
  function render(loc: ChildLocationSnapshot | undefined, width = 120): string {
    const component = renderSubagentResult(makeToolResult(loc), { expanded: true }, theme as any);
    return component.render(width).join("\n");
  }

  it("renders nothing when childLocation is absent", () => {
    assert.doesNotMatch(render(undefined), /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch", () => {
    const out = render(diffDirSameRepo);
    assert.match(out, /cwd: packages\/api/);
    assert.match(out, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree and branch", () => {
    const out = render(linkedWorktree);
    assert.match(out, /linked worktree/);
    assert.match(out, /branch: feature-x/);
  });

  it("case 3: different repo — shows repo and branch", () => {
    const out = render(diffRepo);
    assert.match(out, /repo: other-service/);
    assert.match(out, /branch: main/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    assert.match(render(notGit), /no git repo/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    assert.match(render(detachedHead), /branch: detached@abc1234/);
  });
});

// ---------------------------------------------------------------------------
// Foreground expanded: parallel results
// ---------------------------------------------------------------------------

describe("child-location foreground expanded multi", () => {
  function render(loc: ChildLocationSnapshot | undefined, width = 120): string {
    const component = renderSubagentResult(
      makeToolResult(loc, "parallel"),
      { expanded: true },
      theme as any,
    );
    return component.render(width).join("\n");
  }

  it("renders nothing when childLocation is absent", () => {
    assert.doesNotMatch(render(undefined), /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd for each result", () => {
    const out = render(diffDirSameRepo);
    const matchCount = (out.match(/cwd: packages\/api/g) ?? []).length;
    assert.equal(matchCount, 2, "expected one cwd line per result");
    assert.match(out, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree", () => {
    assert.match(render(linkedWorktree), /linked worktree/);
  });

  it("case 3: different repo — shows repo name", () => {
    assert.match(render(diffRepo), /repo: other-service/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    assert.match(render(notGit), /no git repo/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    assert.match(render(detachedHead), /branch: detached@abc1234/);
  });
});

// ---------------------------------------------------------------------------
// Widget step ordering: location line must precede activity line
// ---------------------------------------------------------------------------

describe("child-location widget step line ordering", () => {
  /**
   * Build a job where the running step has both a childLocation and a
   * currentTool, so the widget emits both a location line and an activity
   * line. The location line must appear first (before activity) in the
   * returned array so that fitWidgetLineBudget — which drops from the END —
   * drops activity before location under budget pressure.
   */
  function makeActiveJob(
    childLocation: ChildLocationSnapshot,
    mode: "single" | "parallel" = "single",
  ): AsyncJobState {
    const step = {
      index: 0,
      agent: "test-agent",
      status: "running" as const,
      childLocation,
      currentTool: "Read",
    };
    if (mode === "single") {
      return {
        asyncId: "test-run",
        asyncDir: "/tmp/test-run",
        status: "running",
        mode: "single",
        agents: ["test-agent"],
        startedAt: 0,
        updatedAt: 1000,
        steps: [step],
        stepsTotal: 1,
      };
    }
    return {
      asyncId: "test-run",
      asyncDir: "/tmp/test-run",
      status: "running",
      mode: "parallel",
      agents: ["agent-a", "agent-b"],
      startedAt: 0,
      updatedAt: 1000,
      steps: [
        { ...step, index: 0, agent: "agent-a" },
        { ...step, index: 1, agent: "agent-b" },
      ],
      stepsTotal: 2,
    };
  }

  it("location line appears before activity line in single-step widget", () => {
    const lines = buildWidgetLines([makeActiveJob(diffDirSameRepo)], theme as any, 120, false);
    const locIdx = lines.findIndex((l) => l.includes("cwd:"));
    const actIdx = lines.findIndex((l) => l.includes("Read"));
    assert.ok(locIdx !== -1, "location line must be present");
    assert.ok(actIdx !== -1, "activity line (Read) must be present");
    assert.ok(
      locIdx < actIdx,
      `location line (index ${locIdx}) must precede activity line (index ${actIdx})`,
    );
  });

  it("location line appears before activity line in parallel-step widget", () => {
    const lines = buildWidgetLines(
      [makeActiveJob(diffDirSameRepo, "parallel")],
      theme as any,
      120,
      false,
    );
    // For the first step: find the first location line, then the first activity line after it
    const locIdx = lines.findIndex((l) => l.includes("cwd:"));
    const actIdx = lines.findIndex((l) => l.includes("Read"));
    assert.ok(locIdx !== -1, "location line must be present");
    assert.ok(actIdx !== -1, "activity line (Read) must be present");
    assert.ok(
      locIdx < actIdx,
      `location line (index ${locIdx}) must precede activity line (index ${actIdx})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Parallel children with different cwds: all location lines visible
// ---------------------------------------------------------------------------

describe("child-location widget parallel different cwds", () => {
  /**
   * Four parallel steps, each in a different worktree / repo. At a typical
   * 120-column terminal all four cwd lines should be visible in the output.
   *
   * Observation: buildWidgetLines returns the full untruncated line array;
   * fitWidgetLineBudget is applied separately by the widget renderer when it
   * knows the actual terminal height. The unit-level assertion here confirms
   * that the step-line builder emits all location lines and that they appear
   * in the returned array regardless of terminal width.
   */
  it("all four location lines are present in the output at width 120", () => {
    const snapshots: ChildLocationSnapshot[] = [
      { childCwd: "/repos/a", displayPath: "~/repos/a", branch: "feat-a" },
      { childCwd: "/repos/b", displayPath: "~/repos/b", branch: "feat-b" },
      { childCwd: "/repos/c", displayPath: "~/repos/c", branch: "feat-c" },
      { childCwd: "/repos/d", displayPath: "~/repos/d", branch: "feat-d" },
    ];
    const job: AsyncJobState = {
      asyncId: "test-run",
      asyncDir: "/tmp/test-run",
      status: "running",
      mode: "parallel",
      agents: ["agent-a", "agent-b", "agent-c", "agent-d"],
      startedAt: 0,
      updatedAt: 1000,
      steps: snapshots.map((loc, i) => ({
        index: i,
        agent: `agent-${String.fromCharCode(97 + i)}`,
        status: "running" as const,
        childLocation: loc,
      })),
      stepsTotal: 4,
    };
    const lines = buildWidgetLines([job], theme as any, 120, false);
    for (const snap of snapshots) {
      const found = lines.some((l) => l.includes(snap.displayPath));
      assert.ok(found, `expected location line for ${snap.displayPath} to appear in widget output`);
    }
    // All four location lines survive because they precede the (empty) activity
    // lines and are not at the tail where truncation would remove them.
  });
});

// ---------------------------------------------------------------------------
// Ordering: broad-to-narrow (cwd → repo → linked worktree → branch → no git)
// ---------------------------------------------------------------------------

describe("child-location ordering", () => {
  /**
   * Extract just the child-location line from rendered output.
   * The line always starts with `  cwd:` (with indentation).
   */
  function findCwdLine(output: string): string | undefined {
    return output.split("\n").find((l) => l.includes("cwd:"));
  }

  it("repo appears before branch in the different-repo case", () => {
    const component = renderSubagentResult(
      makeToolResult(diffRepo),
      { expanded: false },
      theme as any,
    );
    const line = findCwdLine(component.render(120).join("\n"));
    assert.ok(line, "cwd line must be present");
    const repoIdx = line!.indexOf("repo:");
    const branchIdx = line!.indexOf("branch:");
    assert.ok(repoIdx < branchIdx, `repo (${repoIdx}) should precede branch (${branchIdx})`);
  });

  it("linked worktree appears before branch", () => {
    const component = renderSubagentResult(
      makeToolResult(linkedWorktree),
      { expanded: false },
      theme as any,
    );
    const line = findCwdLine(component.render(120).join("\n"));
    assert.ok(line, "cwd line must be present");
    const worktreeIdx = line!.indexOf("linked worktree");
    const branchIdx = line!.indexOf("branch:");
    assert.ok(
      worktreeIdx < branchIdx,
      `linked worktree (${worktreeIdx}) should precede branch (${branchIdx})`,
    );
  });
});

// ---------------------------------------------------------------------------
// ITEM 1 — buildWidgetComponent real entry-point tests
//
// These test the three routing paths inside buildWidgetComponent:
//   1. collapsed single job  → compactSingleWidgetLines compact loop
//   2. collapsed multi-job   → widgetParallelAgentDetails
//   3. expanded              → foregroundStyleWidgetStepLines
//
// The compact loop in compactSingleWidgetLines only triggers when
// buildSingleWidgetLines produces > 10 lines for a parallel-mode single job.
// We need 6+ running steps with no activity to exceed that threshold:
//   1 header + 6 steps × 2 lines (step row + hint) = 13 > 10.
// ---------------------------------------------------------------------------

/**
 * Build a many-step parallel-mode job that forces the compactSingleWidgetLines
 * compact path (fullLines > 10) while still fitting within the adaptive widget
 * budget (11 available rows in a test terminal of 30 rows).
 */
function makeManyStepJob(
  childLocation: ChildLocationSnapshot | undefined,
  stepCount = 6,
): AsyncJobState {
  return {
    asyncId: "test-compact",
    asyncDir: "/tmp/test-compact",
    status: "running",
    mode: "parallel",
    agents: Array.from({ length: stepCount }, (_, i) => `agent-${i}`),
    startedAt: 0,
    updatedAt: 1000,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      index: i,
      agent: `agent-${i}`,
      status: "running" as const,
      childLocation,
    })),
    stepsTotal: stepCount,
  };
}

// ---------------------------------------------------------------------------
// Terminal-dimension pinning helpers
//
// Mirrors the pattern in tests/integration/render-widget.test.ts (lines 120-144).
// process.stdout.rows may be a getter on a TTY, so we must restore the original
// property descriptor rather than writing back a plain value.
// ---------------------------------------------------------------------------

function restoreDescriptor(
  target: NodeJS.WriteStream,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

function withStdoutSize<T>(rows: number, columns: number, fn: () => T): T {
  const stdout = process.stdout as NodeJS.WriteStream & { rows?: number; columns?: number };
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
  Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
  Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
  try {
    return fn();
  } finally {
    restoreDescriptor(stdout, "rows", rowsDescriptor);
    restoreDescriptor(stdout, "columns", columnsDescriptor);
  }
}

/**
 * Render a job through buildWidgetComponent and return the text lines.
 * `expanded` controls whether a live-detail controller reports expanded.
 * Terminal dimensions are pinned to 30 rows × 120 columns so that the
 * adaptive widget tier selection is deterministic regardless of the
 * caller's terminal height.
 */
function renderThroughWidgetComponent(
  jobs: AsyncJobState[],
  expanded = false,
  width = 120,
): string[] {
  return withStdoutSize(30, width, () => {
    const controller = expanded
      ? { isExpanded: () => true, toggle: () => {}, handleKeyPress: () => false }
      : undefined;
    const factory = buildWidgetComponent(jobs, controller as any);
    const component = factory(null, theme as any);
    // Use the provided width so wrap/truncation is deterministic in tests.
    return component.render(width);
  });
}

describe("buildWidgetComponent — collapsed single job (compactSingleWidgetLines)", () => {
  beforeEach(() => {
    // Reset module-level widget layout session so test isolation is guaranteed.
    resetWidgetLayoutSession();
  });

  it("renders nothing when childLocation is absent", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(undefined)]).join("\n");
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(diffDirSameRepo)]).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree marker", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(linkedWorktree)]).join("\n");
    assert.match(lines, /linked worktree/);
  });

  it("case 3: different repo — shows cwd, repo, and branch", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(diffRepo)]).join("\n");
    assert.match(lines, /cwd: ~\/repos\/other-service/);
    assert.match(lines, /repo: other-service/);
    assert.match(lines, /branch: main/);
  });

  it("case 4: non-git child — shows cwd and no git repo marker", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(notGit)]).join("\n");
    assert.match(lines, /cwd:/);
    assert.match(lines, /no git repo/);
  });

  it("case 5: detached HEAD — shows cwd and branch: detached@sha", () => {
    const lines = renderThroughWidgetComponent([makeManyStepJob(detachedHead)]).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: detached@abc1234/);
  });
});

describe("buildWidgetComponent — collapsed multi-job (widgetParallelAgentDetails)", () => {
  beforeEach(() => {
    resetWidgetLayoutSession();
  });

  /**
   * Build two jobs for the multi-job array path. Each job has parallel mode
   * (mode === "parallel") so widgetParallelAgentDetails is invoked for it.
   *
   * To stay within the adaptive widget line budget (budget=10 collapsed at 30
   * terminal rows), each job has only 1 step. With 2 jobs × (1 status + 1 step
   * + 1 location) + 1 header = 7 total lines, which fits comfortably.
   */
  function makeTwoParallelJobs(childLocation: ChildLocationSnapshot | undefined): AsyncJobState[] {
    const makeParallelJob = (id: string): AsyncJobState => ({
      asyncId: id,
      asyncDir: `/tmp/${id}`,
      status: "running",
      mode: "parallel",
      agents: ["agent-a"],
      startedAt: 0,
      updatedAt: 1000,
      steps: [{ index: 0, agent: "agent-a", status: "running", childLocation }],
      stepsTotal: 1,
    });
    return [makeParallelJob("job-1"), makeParallelJob("job-2")];
  }

  it("renders nothing when childLocation is absent", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(undefined)).join("\n");
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch for each step", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(diffDirSameRepo)).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });

  it("case 2: linked worktree — shows linked worktree marker", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(linkedWorktree)).join("\n");
    assert.match(lines, /linked worktree/);
  });

  it("case 3: different repo — shows repo name", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(diffRepo)).join("\n");
    assert.match(lines, /repo: other-service/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(notGit)).join("\n");
    assert.match(lines, /no git repo/);
  });

  it("case 5: detached HEAD — shows branch: detached@sha", () => {
    const lines = renderThroughWidgetComponent(makeTwoParallelJobs(detachedHead)).join("\n");
    assert.match(lines, /branch: detached@abc1234/);
  });
});

describe("buildWidgetComponent — expanded (foregroundStyleWidgetStepLines)", () => {
  beforeEach(() => {
    resetWidgetLayoutSession();
  });

  it("renders nothing when childLocation is absent", () => {
    const lines = renderThroughWidgetComponent([makeJob(undefined, "parallel")], true).join("\n");
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("case 1: different dir, same repo — shows cwd and branch", () => {
    const lines = renderThroughWidgetComponent([makeJob(diffDirSameRepo, "parallel")], true).join(
      "\n",
    );
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });

  it("case 3: different repo — shows repo and branch", () => {
    const lines = renderThroughWidgetComponent([makeJob(diffRepo, "parallel")], true).join("\n");
    assert.match(lines, /repo: other-service/);
    assert.match(lines, /branch: main/);
  });

  it("case 4: non-git child — shows no git repo", () => {
    const lines = renderThroughWidgetComponent([makeJob(notGit, "parallel")], true).join("\n");
    assert.match(lines, /no git repo/);
  });
});

// ---------------------------------------------------------------------------
// ITEM 1 (ts-4zoj) — multi-job buildWidgetLines: single-mode job alongside
// another job shows its location line; parallel job does not duplicate it.
// ---------------------------------------------------------------------------

/** A minimal second job to push the widget into the multi-job path. */
function makeCompanionJob(id: string): AsyncJobState {
  return {
    asyncId: id,
    asyncDir: `/tmp/${id}`,
    status: "running",
    mode: "single",
    agents: ["agent-z"],
    startedAt: 0,
    updatedAt: 1000,
    steps: [{ index: 0, agent: "agent-z", status: "running" }],
    stepsTotal: 1,
  };
}

/** A single-mode job (mode: "single") — the case widgetParallelAgentDetails skips. */
function makeSingleModeJobForMulti(
  childLocation: ChildLocationSnapshot | undefined,
  id = "single-job",
): AsyncJobState {
  return {
    asyncId: id,
    asyncDir: `/tmp/${id}`,
    status: "running",
    mode: "single",
    agents: ["agent-a"],
    startedAt: 0,
    updatedAt: 1000,
    steps: [{ index: 0, agent: "agent-a", status: "running", childLocation }],
    stepsTotal: 1,
  };
}

describe("buildWidgetComponent — multi-job: single-mode job shows location line at job level", () => {
  beforeEach(() => {
    resetWidgetLayoutSession();
  });

  it("collapsed: single-mode job alongside another job shows location line", () => {
    const jobs = [makeSingleModeJobForMulti(diffDirSameRepo), makeCompanionJob("companion")];
    const lines = renderThroughWidgetComponent(jobs, false).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });

  it("expanded: single-mode job alongside another job shows location line", () => {
    const jobs = [makeSingleModeJobForMulti(diffDirSameRepo), makeCompanionJob("companion")];
    const lines = renderThroughWidgetComponent(jobs, true).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });

  it("collapsed: no location line when childLocation absent", () => {
    const jobs = [makeSingleModeJobForMulti(undefined), makeCompanionJob("companion")];
    const lines = renderThroughWidgetComponent(jobs, false).join("\n");
    assert.doesNotMatch(lines, /cwd:/);
  });

  it("finished single-mode job alongside running job shows location line (terminal state)", () => {
    const finishedJob: AsyncJobState = {
      ...makeSingleModeJobForMulti(diffDirSameRepo),
      status: "complete",
      steps: [{ index: 0, agent: "agent-a", status: "complete", childLocation: diffDirSameRepo }],
    };
    const jobs = [makeCompanionJob("companion"), finishedJob];
    const lines = renderThroughWidgetComponent(jobs, false).join("\n");
    assert.match(lines, /cwd: packages\/api/);
    assert.match(lines, /branch: feature-x/);
  });
});

describe("buildWidgetComponent — multi-job: parallel job does not duplicate location line", () => {
  beforeEach(() => {
    resetWidgetLayoutSession();
  });

  /**
   * A parallel job with 2 steps both sharing the same childLocation, alongside
   * a companion job. widgetParallelAgentDetails emits one location line per
   * step (2 total). The job-level fallback must NOT add a third occurrence.
   */
  it("parallel job with 2 steps: location line appears exactly twice (one per step)", () => {
    const parallelJob: AsyncJobState = {
      asyncId: "parallel-job",
      asyncDir: "/tmp/parallel-job",
      status: "running",
      mode: "parallel",
      agents: ["agent-a", "agent-b"],
      startedAt: 0,
      updatedAt: 1000,
      steps: [
        { index: 0, agent: "agent-a", status: "running", childLocation: diffDirSameRepo },
        { index: 1, agent: "agent-b", status: "running", childLocation: diffDirSameRepo },
      ],
      stepsTotal: 2,
    };
    const jobs = [parallelJob, makeCompanionJob("companion")];
    const lines = renderThroughWidgetComponent(jobs, false);
    const count = lines.filter((l) => l.includes("cwd: packages/api")).length;
    assert.equal(
      count,
      2,
      `expected exactly 2 cwd lines (one per parallel step, no job-level duplicate), got ${count}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Newline safety: location line must never emit more than one physical row
// (ts-o2mn / PR 623 item 2)
// ---------------------------------------------------------------------------

describe("childLocationLine — newline in displayPath", () => {
  it("location line produces exactly one physical row when displayPath contains a newline", () => {
    // A directory name containing \n is legal on Unix.  Without the fix the
    // location text "cwd: bad\ndir" would split into two lines and corrupt
    // widget height accounting.
    const newlinePath: ChildLocationSnapshot = {
      childCwd: "/tmp/bad\ndir",
      displayPath: "bad\ndir",
    };
    const lines = buildWidgetLines([makeJob(newlinePath)], theme as any, 120, false);
    const locationLines = lines.filter((l) => l.includes("cwd:"));
    assert.equal(
      locationLines.length,
      1,
      `expected exactly one location line but got ${locationLines.length}: ${JSON.stringify(locationLines)}`,
    );
    // The newline must be rendered as the visible escaped form, not passed through.
    const locationLine = locationLines[0];
    assert.ok(locationLine !== undefined);
    assert.match(locationLine, /\\n/, "newline must appear as the visible escape \\n");
    assert.ok(
      !locationLine.includes("\n"),
      "location line must not contain a literal newline character",
    );
  });

  it("location line with CR in displayPath also produces exactly one physical row", () => {
    const crPath: ChildLocationSnapshot = {
      childCwd: "/tmp/bad\rdir",
      displayPath: "bad\rdir",
    };
    const lines = buildWidgetLines([makeJob(crPath)], theme as any, 120, false);
    const locationLines = lines.filter((l) => l.includes("cwd:"));
    assert.equal(locationLines.length, 1, "CR in displayPath must not emit extra rows");
    const locationLine = locationLines[0];
    assert.ok(locationLine !== undefined);
    // safeTerminalText normalises \r to \n before our CR/LF replacement runs,
    // so the final escaped form in the output is \\n rather than \\r.
    // Either way, the line must not contain a raw CR or LF.
    assert.ok(
      !locationLine.includes("\r") && !locationLine.includes("\n"),
      "location line must not contain a literal CR or LF character",
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary validation: malformed persisted childLocation must not reach the
// renderer (ts-o2mn / PR 623 item 1)
// ---------------------------------------------------------------------------

describe("childLocation boundary validation — render safety", () => {
  it("passing a non-string displayPath directly to the renderer throws (demonstrating the threat)", () => {
    // This confirms the vulnerability: if a malformed object bypasses the
    // boundary validator and reaches the renderer, safeTerminalText will call
    // string methods on a non-string and throw.
    // Use JSON.parse for a single any-typed assertion, avoiding a chained
    // `as unknown as T` which the linter rejects.
    const malformedLoc = JSON.parse(
      JSON.stringify({ childCwd: "/repo", displayPath: {} }),
    ) as ChildLocationSnapshot;
    assert.throws(
      () => buildWidgetLines([makeJob(malformedLoc)], theme as any, 120, false),
      "renderer must throw when displayPath is not a string",
    );
  });

  it("boundary validator rejects malformed displayPath and renderer receives undefined", () => {
    // Simulate the boundary: parsePersistedChildLocationSnapshot drops the
    // object, so the renderer never sees a non-string displayPath.
    const validated = parsePersistedChildLocationSnapshot({ childCwd: "/repo", displayPath: {} });
    assert.equal(validated, undefined, "boundary must reject non-string displayPath");
    // With undefined propagated, the renderer skips the location line entirely.
    assert.doesNotThrow(
      () => buildWidgetLines([makeJob(undefined)], theme as any, 120, false),
      "renderer must not throw when childLocation is undefined",
    );
  });
});
