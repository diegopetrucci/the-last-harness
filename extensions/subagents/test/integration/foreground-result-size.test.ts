import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

interface ResultContent {
  text?: string;
}

interface SingleResultLike {
  agent?: string;
  exitCode?: number;
  finalOutput?: string;
  messages?: unknown[];
  toolCalls?: Array<{ text?: string; expandedText?: string }>;
  progress?: unknown;
}

interface ExecutorResult {
  isError?: boolean;
  content: ResultContent[];
  details?: {
    mode?: string;
    results?: SingleResultLike[];
    progress?: unknown;
  };
}

interface ExecutorModule {
  createSubagentExecutor?: (...args: unknown[]) => {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: ((result: unknown) => void) | undefined,
      ctx: unknown,
    ) => Promise<ExecutorResult>;
  };
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeState(cwd: string) {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

function makeExecutor(cwd: string) {
  return createSubagentExecutor!({
    pi: {
      events: { emit: () => {} },
      getSessionName: () => undefined,
      setSessionName: () => {},
    },
    state: makeState(cwd),
    config: {},
    tempArtifactsDir: cwd,
    getSubagentSessionRoot: () => cwd,
    expandTilde: (value: string) => value,
    discoverAgents: () => ({
      agents: [{ name: "tester", description: "Tool-heavy test agent" }],
    }),
  });
}

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {},
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => null,
    },
    modelRegistry: { getAvailable: () => [] },
  };
}

describe(
  "foreground result payload compaction",
  {
    skip: !available ? "subagent executor not importable" : undefined,
  },
  () => {
    let tempDir: string;
    let mockPi: MockPi;

    before(() => {
      mockPi = createMockPi();
      mockPi.install();
    });

    after(() => {
      mockPi.uninstall();
    });

    beforeEach(() => {
      tempDir = createTempDir("pi-subagent-payload-test-");
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it("async dispatch returns a compact background receipt for tool-heavy runs", async () => {
      // After async-only dispatch: foreground result payload compaction (inline
      // toolCalls, exitCode, message filtering) is a foreground-engine concern
      // removed from the executor receipt. The executor now returns a compact
      // background receipt whose size is independent of the child's tool usage.
      // Removed foreground-only assertions (no async equivalent):
      //   - result.details.results[0].exitCode
      //   - result.details.results[0].messages / toolCalls / progress (inline)
      //   - result.details.progress (aggregate)
      //   - payload JSON size < 80_000 (foreground-specific compaction invariant)
      // Covering test: async-execution-runner-launch-config-validation.test.ts
      //   "async launch messages use the background receipt format"
      mockPi.onCall({ output: "done" });

      const executor = makeExecutor(tempDir);
      const result = await executor.execute(
        "compact-receipt-id",
        { agent: "tester", task: "Run the full noisy test sweep" },
        new AbortController().signal,
        undefined,
        makeCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.details?.mode, "single");
      // The receipt text is compact regardless of child tool usage.
      const receiptText = result.content[0]?.text ?? "";
      assert.ok(
        receiptText.length < 500,
        `expected compact receipt, got ${receiptText.length} bytes`,
      );
      assert.match(receiptText, /Background run started/);
    });
  },
);
