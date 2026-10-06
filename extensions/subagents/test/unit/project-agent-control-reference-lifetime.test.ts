import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createProjectAgentRunCapture,
  getProjectAgentRunReferenceMetadata,
  getProjectAgentSnapshotProvenance,
  lookupProjectAgentRunReference,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
  releaseProjectAgentSnapshotReference,
  retainProjectAgentRunReference,
  retainProjectAgentRunReferenceFrom,
  retainProjectAgentSnapshotReference,
  resolveProjectAgentSnapshot,
} from "../../src/agents/project-agent-snapshot.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import {
  buildSkippedAcceptanceLedger,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import { trimRememberedForegroundRuns } from "../../src/runs/foreground/subagent-executor.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  cleanupRun,
  createProjectAgentControlEnvironment,
  createProjectGeneration,
  createState,
  makeAgent,
  makeContext,
  makeExecutor,
  revokeIfRegistered,
  runAsyncDir,
  text,
  writeStatus,
} from "../support/project-agent-control-fixtures.ts";
import type { ForegroundResumeRun } from "../../src/shared/types.ts";

const testEnvironment = createProjectAgentControlEnvironment();

describe("project-agent control reference lifetime and continuation", () => {
  beforeEach(testEnvironment.setup);
  afterEach(testEnvironment.teardown);

  it(
    "persists a foreground pause capture and resumes it after a generation reload" +
      " — legacy-fixture: state written directly; foreground dispatch is no longer available",
    async () => {
      // This test was originally driven through the old runSync foreground-dispatch
      // path.  After async-only, new dispatch can no longer create a foreground pause,
      // so we write the historical paused-foreground state directly (legacy fixture)
      // in the same format that the old path produced, then verify that the
      // project-agent authorization / reference-lifetime safeguards survive a
      // generation reload and produce a correct background continuation.
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-foreground-pause-")),
      );
      execFileSync("git", ["init", "--quiet", root]);
      const first = createProjectGeneration(
        root,
        "session-project",
        "generation-foreground-one",
        "embedded.worker",
        "Foreground original",
        "foreground-digest-one",
      );
      const second = createProjectGeneration(
        root,
        "session-project",
        "generation-foreground-two",
        "embedded.worker",
        "Foreground reloaded",
        "foreground-digest-two",
      );
      let active = first;
      let resumedRunId = "";
      const state = createState();
      const executor = makeExecutor(
        root,
        state,
        {
          get capability() {
            return active.capability;
          },
        } as any,
        {
          executeAsyncSingle: (runId: string, params: any) => {
            resumedRunId = runId;
            return {
              content: [{ type: "text", text: "resumed" }],
              details: { asyncId: runId, results: [] },
              params,
            };
          },
        },
      );

      // ── Build historical paused-foreground state directly ────────────────
      // Write the persisted ASYNC_DIR status and the in-memory foreground-run
      // index that the old foreground-dispatch path would have produced, then
      // retain the project-agent run reference.
      const pausedRunId = `paused-fg-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, pausedRunId);
      const sessionFile = path.join(asyncDir, "worker.jsonl");
      const acceptance = buildSkippedAcceptanceLedger({
        acceptance: resolveEffectiveAcceptance({
          agentName: "embedded.worker",
          task: "foreground pause",
          mode: "single",
        }),
        ledgerStatus: "skipped",
        runtimeCheckStatus: "not-applicable",
        id: "paused",
        message: "Acceptance will run after resume.",
      });

      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf8");
      const persistedPath = path.join(asyncDir, "status.json");
      writeJson(persistedPath, {
        runId: pausedRunId,
        mode: "single",
        state: "paused",
        sessionId: "session-project",
        cwd: root,
        startedAt: Date.now() - 10_000,
        lastUpdate: Date.now(),
        steps: [
          {
            agent: "embedded.worker",
            status: "paused",
            sessionFile,
            projectAgent: first.capture,
            acceptance,
            pause: { kind: "awaiting_supervisor", summary: "Need supervisor input." },
          },
        ],
        pause: { kind: "awaiting_supervisor", summary: "Need supervisor input." },
      });

      // Populate the in-memory foreground-run index (mirrors what rememberForegroundRun
      // wrote after the old onSupervisorPauseTransition callback fired).
      state.foregroundRuns ??= new Map();
      const foregroundEntry: ForegroundResumeRun = {
        runId: pausedRunId,
        mode: "single",
        cwd: root,
        updatedAt: Date.now(),
        children: [
          {
            agent: "embedded.worker",
            index: 0,
            status: "paused",
            sessionFile,
            projectAgent: first.capture,
            acceptance,
            pause: { kind: "awaiting_supervisor", summary: "Need supervisor input." },
          },
        ],
      };
      state.foregroundRuns.set(pausedRunId, foregroundEntry);
      retainProjectAgentRunReference(first.capability, pausedRunId, [first.capture]);

      try {
        // Verify the fixture looks correct — same assertions as the old live path.
        const persisted = JSON.parse(fs.readFileSync(persistedPath, "utf8"));
        assert.deepEqual(persisted.steps?.[0]?.projectAgent, first.capture);
        assert.equal(
          persisted.steps?.[0]?.projectAgent?.config.systemPrompt,
          "Foreground original",
        );

        // Simulate a generation reload: the first generation's source file is
        // gone and the active capability has advanced to the second generation.
        fs.rmSync(first.capture.config.filePath, { force: true });
        active = second;

        // ── Guard: resume without a projectAgent marker must fail closed ───
        // A status where the project-agent marker was removed or corrupted
        // must be rejected before any background launch occurs.
        delete persisted.steps[0].projectAgent;
        writeJson(persistedPath, persisted);
        const removedMarker = await executor.execute(
          "foreground-resume-removed-marker",
          { action: "resume", id: pausedRunId, message: "Do not bypass." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(removedMarker.isError, true);
        assert.match(text(removedMarker), /missing|corrupt|project-agent/i);

        // ── Happy path: restore the marker and resume to a background run ──
        // After a project generation reload the private run reference still
        // exists (retained for the original runId), so authorization succeeds
        // using the retained capture.  The executor delegates to the background
        // seam and retains a reference for the new continuation run id.
        persisted.steps[0].projectAgent = first.capture;
        writeJson(persistedPath, persisted);
        const resumed = await executor.execute(
          "foreground-resume",
          { action: "resume", id: pausedRunId, message: "Continue after reload." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        // Resume produces a background continuation (not an error).
        assert.equal(resumed.isError, undefined);
        // The background seam was called and returned a new run id.
        assert.ok(resumedRunId, "expected a continuation runId from the background seam");
        // The project-agent reference-lifetime safeguard retains a reference
        // for the continuation run so it is accessible after resume.
        assert.equal(
          lookupProjectAgentRunReference(resumedRunId).status,
          "found",
          "continuation must have a retained project-agent run reference",
        );
      } finally {
        releaseProjectAgentRunReference(pausedRunId);
        if (resumedRunId) releaseProjectAgentRunReference(resumedRunId);
        revokeIfRegistered(first.capability);
        revokeIfRegistered(second.capability);
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("retains complete and failed project generations beyond the UI cleanup window", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-retention-")),
    );
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-terminal-retention",
    );
    retainProjectAgentSnapshotReference(generation.capability, "terminal-retention-test-owner");
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(runAsyncDir("placeholder")),
      {
        completionRetentionMs: 5,
        projectAgentTerminalRetentionMs: 40,
        resultsDir: path.join(root, "results"),
      },
    );
    const runIds: string[] = [];
    try {
      for (const [index, success] of [true, false].entries()) {
        const runId = `project-terminal-${success ? "complete" : "failed"}-${Date.now().toString(36)}-${index}`;
        runIds.push(runId);
        const asyncDir = writeStatus(runId, root, generation.capture, {
          state: success ? "complete" : "failed",
        });
        retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
        state.asyncJobs.set(runId, {
          asyncId: runId,
          asyncDir,
          status: "running",
          updatedAt: Date.now(),
        });
        tracker.handleComplete({
          id: runId,
          asyncDir,
          success,
          sessionId: "session-project",
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(lookupProjectAgentRunReference(runId).status, "found");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    } finally {
      tracker.resetJobs();
      for (const runId of runIds) {
        releaseProjectAgentRunReference(runId);
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentSnapshotReference("terminal-retention-test-owner");
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("preserves pending terminal cleanup across a same-session tracker reset", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-reset-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-tracker-reset");
    const runId = `project-tracker-reset-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture, { state: "complete" });
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 60 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        success: true,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      tracker.resetJobs();
      assert.equal(state.asyncJobs.size, 0, "reset still clears UI job state");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "same-session reset must not release before the terminal window",
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "missing",
        "preserved timer must release at the configured bounded window",
      );
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not let reset cleanup release a reference reused in another session", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-reuse-")),
    );
    const previousGeneration = createProjectGeneration(
      root,
      "session-project-old",
      "generation-tracker-reuse-old",
    );
    const nextGeneration = createProjectGeneration(
      root,
      "session-project-new",
      "generation-tracker-reuse-new",
    );
    const runId = `project-tracker-reuse-${Date.now().toString(36)}`;
    retainProjectAgentSnapshotReference(nextGeneration.capability, "tracker-reuse-next-owner");
    const asyncDir = writeStatus(runId, root, previousGeneration.capture, {
      state: "complete",
    });
    retainProjectAgentRunReference(previousGeneration.capability, runId, [
      previousGeneration.capture,
    ]);
    const state = createState();
    state.currentSessionId = "session-project-old";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 45 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        success: true,
        sessionId: "session-project-old",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      state.currentSessionId = "session-project-new";
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      retainProjectAgentRunReference(nextGeneration.capability, runId, [nextGeneration.capture]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "a session reset must not prematurely release the reused id",
      );
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "the stale timer must not release the new session reference",
      );
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      releaseProjectAgentSnapshotReference("tracker-reuse-next-owner");
      revokeIfRegistered(previousGeneration.capability);
      revokeIfRegistered(nextGeneration.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("releases a continued project cohort once every sibling is terminal", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-cohort-")),
    );
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-terminal-cohort",
    );
    const runId = `project-terminal-cohort-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    fs.mkdirSync(asyncDir, { recursive: true });
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "continued",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "continued",
          projectAgent: generation.capture,
        },
        { agent: "ordinary", status: "complete" },
      ],
    });
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 40 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains continued/cancelled cohorts for terminal project siblings with usable sessions", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-sibling-")),
    );
    const firstAgent = makeAgent(root, "embedded.worker", "Selected project prompt");
    const siblingAgent = makeAgent(root, "embedded.reviewer", "Terminal sibling prompt");
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "session-project",
      generationId: "generation-terminal-sibling",
      entries: [
        { agent: firstAgent as never, digest: "digest-worker", frontmatterFields: ["tools"] },
        { agent: siblingAgent as never, digest: "digest-reviewer", frontmatterFields: ["tools"] },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const captures = [
      createProjectAgentRunCapture(manifest, firstAgent as never),
      createProjectAgentRunCapture(manifest, siblingAgent as never),
    ];
    retainProjectAgentSnapshotReference(capability, "terminal-sibling-test-owner");
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(runAsyncDir("placeholder")),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 40 },
    );
    const runIds: string[] = [];
    try {
      for (const terminalState of ["continued", "cancelled"] as const) {
        for (const siblingState of ["complete", "failed"] as const) {
          const runId = `project-terminal-sibling-${terminalState}-${siblingState}-${Date.now().toString(36)}`;
          runIds.push(runId);
          const asyncDir = runAsyncDir(runId);
          const selectedSession = path.join(asyncDir, "worker.jsonl");
          const siblingSession = path.join(asyncDir, "reviewer.jsonl");
          fs.mkdirSync(asyncDir, { recursive: true });
          fs.writeFileSync(selectedSession, "", "utf8");
          fs.writeFileSync(siblingSession, "", "utf8");
          writeJson(path.join(asyncDir, "status.json"), {
            runId,
            mode: "parallel",
            state: terminalState,
            sessionId: "session-project",
            cwd: root,
            startedAt: Date.now(),
            lastUpdate: Date.now(),
            steps: [
              {
                agent: captures[0]!.provenance.agent,
                status: terminalState,
                sessionFile: selectedSession,
                projectAgent: captures[0],
              },
              {
                agent: captures[1]!.provenance.agent,
                status: siblingState,
                sessionFile: siblingSession,
                projectAgent: captures[1],
              },
            ],
          });
          retainProjectAgentRunReference(capability, runId, captures);
          state.asyncJobs.set(runId, {
            asyncId: runId,
            asyncDir,
            status: "running",
            updatedAt: Date.now(),
          });
          tracker.handleComplete({
            id: runId,
            asyncDir,
            state: terminalState,
            success: false,
            sessionId: "session-project",
          });
          await new Promise((resolve) => setTimeout(resolve, 15));
          assert.equal(lookupProjectAgentRunReference(runId).status, "found");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
          releaseProjectAgentRunReference(runId);
          state.asyncJobs.clear();
          fs.rmSync(asyncDir, { recursive: true, force: true });
        }
      }
    } finally {
      tracker.resetJobs();
      for (const runId of runIds) {
        releaseProjectAgentRunReference(runId);
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentSnapshotReference("terminal-sibling-test-owner");
      revokeIfRegistered(capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not release a continued async reference while a sibling remains resumable", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-tracker");
    const runId = `project-tracker-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    const siblingSession = path.join(asyncDir, "sibling.jsonl");
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(siblingSession, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "continued",
          projectAgent: generation.capture,
        },
        { agent: "ordinary", status: "paused", sessionFile: siblingSession },
      ],
    });
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, resultsDir: path.join(root, "results") },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "parallel",
        state: "continued",
        sessionId: "session-project",
        cwd: root,
        startedAt: 100,
        lastUpdate: Date.now(),
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "continued",
            projectAgent: generation.capture,
          },
          { agent: "ordinary", status: "continued", sessionFile: siblingSession },
        ],
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not release a paused foreground reference when its in-memory projection is evicted", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-lru-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-lru");
    const runId = `project-lru-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    const asyncDir = runAsyncDir(runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "paused",
          sessionFile,
          projectAgent: generation.capture,
        },
      ],
    });
    const state = createState();
    state.foregroundRuns = new Map(
      Array.from({ length: 51 }, (_, index) => {
        const id = index === 0 ? runId : `foreground-complete-${index}-${Date.now().toString(36)}`;
        return [
          id,
          {
            runId: id,
            mode: "parallel",
            cwd: root,
            updatedAt: index,
            children:
              index === 0
                ? [{ agent: generation.capture.provenance.agent, status: "paused", sessionFile }]
                : [{ agent: "worker", status: "completed" }],
          },
        ];
      }),
    ) as any;
    try {
      trimRememberedForegroundRuns(state);
      assert.equal(state.foregroundRuns?.has(runId), false);
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");
    } finally {
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("transfers the private reference to a continuation before source release", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-transfer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-transfer");
    const sourceId = `project-transfer-source-${Date.now().toString(36)}`;
    writeStatus(sourceId, root, generation.capture);
    retainProjectAgentRunReference(generation.capability, sourceId, [generation.capture]);
    let continuationId = "";
    try {
      retainProjectAgentRunReferenceFrom(sourceId, "project-transfer-direct");
      assert.equal(
        getProjectAgentRunReferenceMetadata("project-transfer-direct")?.[0]?.generationId,
        "generation-transfer",
      );
      releaseProjectAgentRunReference("project-transfer-direct");
      const executor = makeExecutor(
        root,
        createState(),
        { capability: generation.capability },
        {
          executeAsyncSingle: (runId: string) => {
            continuationId = runId;
            return {
              content: [{ type: "text", text: "continued" }],
              details: { asyncId: runId, results: [] },
            };
          },
        },
      );
      const result = await executor.execute(
        "resume",
        { action: "resume", id: sourceId, message: "Continue." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.ok(continuationId);
      assert.equal(lookupProjectAgentRunReference(continuationId).status, "found");
      // The complete source is retained for its normal terminal window; it was
      // not released merely because a continuation was launched.
      assert.equal(lookupProjectAgentRunReference(sourceId).status, "found");
    } finally {
      releaseProjectAgentRunReference(sourceId);
      if (continuationId) releaseProjectAgentRunReference(continuationId);
      cleanupRun(sourceId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
