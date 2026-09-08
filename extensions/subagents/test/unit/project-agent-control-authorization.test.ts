import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getProjectAgentRunReferenceMetadata,
  getProjectAgentSnapshotProvenance,
  releaseProjectAgentRunReference,
  retainProjectAgentRunReference,
  type ProjectAgentRunCapture,
  type ProjectAgentSnapshotCapability,
} from "../../src/agents/project-agent-snapshot.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  cleanupRun,
  createProjectAgentControlEnvironment,
  createProjectGeneration,
  createState,
  makeContext,
  makeExecutor,
  revokeIfRegistered,
  runAsyncDir,
  text,
  writeStatus,
  type ProjectAgentRebind,
} from "../support/project-agent-control-fixtures.ts";

const testEnvironment = createProjectAgentControlEnvironment();

describe("project-agent control authorization and rebind", () => {
  beforeEach(testEnvironment.setup);
  afterEach(testEnvironment.teardown);

  it("resumes from the retained original generation after reload and source deletion", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-reload-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const first = createProjectGeneration(
      root,
      "session-project",
      "generation-one",
      "embedded.worker",
      "Original prompt",
      "digest-one",
    );
    const second = createProjectGeneration(
      root,
      "session-project",
      "generation-two",
      "embedded.worker",
      "Reloaded prompt",
      "digest-two",
    );
    const runId = `project-reload-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(first.capability, runId, [first.capture]);
    const asyncDir = writeStatus(runId, root, first.capture);
    const sourcePath = first.capture.config.filePath;
    fs.rmSync(sourcePath, { force: true });
    let active = second;
    let rebindCalls = 0;
    let dispatched: any;
    const executor = makeExecutor(
      root,
      createState(),
      {
        get capability() {
          return active.capability;
        },
        rebind: async () => {
          rebindCalls++;
          return second;
        },
      } as any,
      {
        executeAsyncSingle: (continuedId: string, params: any) => {
          const details = { asyncId: continuedId, results: [] };
          dispatched = { continuedId, params, details };
          return {
            content: [{ type: "text", text: "continued" }],
            details,
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Continue using the original context." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.equal(result.details, dispatched.details);
      assert.equal(
        text(result),
        [
          `Revived async subagent from ${runId}.`,
          `Revived run: ${dispatched.continuedId}`,
          "Agent: embedded.worker",
          `Session: ${path.join(asyncDir, "worker.jsonl")}`,
          `Status if needed: subagent({ action: "status", id: "${dispatched.continuedId}" })`,
        ].join("\n"),
      );
      assert.match(dispatched.params.agentConfig.systemPrompt, /^Original prompt/);
      assert.equal(dispatched.params.projectAgent.provenance.generationId, "generation-one");
      assert.equal(dispatched.params.projectAgent.provenance.digest, "digest-one");
      assert.equal(dispatched.params.projectAgent.config.systemPrompt, "Original prompt");
      assert.equal(rebindCalls, 0, "same-process continuation must not perform a fresh rebind");
      assert.equal(fs.existsSync(sourcePath), false);
      assert.equal(fs.existsSync(asyncDir), true);
    } finally {
      cleanupRun(runId);
      if (dispatched?.continuedId) releaseProjectAgentRunReference(dispatched.continuedId);
      revokeIfRegistered(first.capability);
      revokeIfRegistered(second.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rebinds a project definition in a new process and reports an old-to-new digest change", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-rebind-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const workspaceLink = path.join(root, "workspace-link");
    let persistedCwd = workspace;
    try {
      fs.symlinkSync(workspace, workspaceLink, "dir");
      persistedCwd = workspaceLink;
    } catch {
      // The canonical-path assertion below remains useful on platforms that
      // do not permit test symlinks.
    }
    const canonicalCwd = fs.realpathSync(workspace);
    const original = createProjectGeneration(
      root,
      "session-project",
      "generation-rebind-old",
      "embedded.worker",
      "Original prompt",
      "digest-old",
    );
    const rebound = createProjectGeneration(
      root,
      "session-project",
      "generation-rebind-new",
      "embedded.worker",
      "Current prompt",
      "digest-new",
    );
    const persisted = {
      ...original.capture,
      provenance: {
        ...original.capture.provenance,
        processInstanceId: "prior-process",
      },
      // This path is intentionally forged and must never be used by the
      // fresh operation; the current capability supplies the canonical path.
      config: {
        ...original.capture.config,
        filePath: path.join(root, "outside", "forged.md"),
      },
    } as ProjectAgentRunCapture;
    const runId = `project-rebind-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, persisted, { cwd: persistedCwd });
    let rebindRequest: unknown;
    let dispatched: any;
    const executor = makeExecutor(
      root,
      createState(),
      {
        capability: rebound.capability,
        rebind: async (request) => {
          rebindRequest = request;
          return {
            capability: rebound.capability,
            expected: getProjectAgentSnapshotProvenance(rebound.capability),
            capture: rebound.capture,
          };
        },
      },
      {
        executeAsyncSingle: (continuedId: string, params: any) => {
          const details = {
            asyncId: continuedId,
            asyncDir: path.join(root, "continued-async"),
            results: [],
          };
          dispatched = { continuedId, params, details };
          return {
            content: [{ type: "text", text: "rebound" }],
            details,
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume-rebind",
        { action: "resume", id: runId, message: "Continue with the current definition." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.equal(result.details, dispatched.details);
      assert.equal(
        text(result),
        [
          `Revived async subagent from ${runId}.`,
          `Revived run: ${dispatched.continuedId}`,
          "Agent: embedded.worker",
          "Notice: Project agent 'embedded.worker' changed since the original run (digest digest-old → digest-new). The resumed child uses the current validated definition; review the change if it was unexpected.",
          `Session: ${path.join(asyncDir, "worker.jsonl")}`,
          `Async dir: ${path.join(root, "continued-async")}`,
          `Status if needed: subagent({ action: "status", id: "${dispatched.continuedId}" })`,
        ].join("\n"),
      );
      assert.deepEqual(rebindRequest, {
        projectRoot: root,
        cwd: canonicalCwd,
        sessionId: "session-project",
        agent: "embedded.worker",
      });
      assert.equal(dispatched.params.cwd, canonicalCwd);
      assert.equal(dispatched.params.ctx.cwd, canonicalCwd);
      assert.equal(dispatched.params.projectAgent.config.systemPrompt, "Current prompt");
      assert.equal(dispatched.params.projectAgent.config.filePath, rebound.capture.config.filePath);
      assert.deepEqual(getProjectAgentRunReferenceMetadata(dispatched.continuedId), [
        rebound.capture.provenance,
      ]);
      assert.match(text(result), /digest-old.*→.*digest-new/);
      assert.match(text(result), /current validated definition|review the change/i);
    } finally {
      cleanupRun(runId);
      if (dispatched?.continuedId) releaseProjectAgentRunReference(dispatched.continuedId);
      revokeIfRegistered(original.capability);
      revokeIfRegistered(rebound.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed when a fresh rebind is removed, untrusted, unsafe, or rooted elsewhere", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fresh-fail-")),
    );
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fresh-other-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["init", "--quiet", otherRoot]);
    const original = createProjectGeneration(
      root,
      "session-project",
      "generation-fresh-original",
      "embedded.worker",
      "Original fresh prompt",
      "digest-fresh-original",
    );
    const current = createProjectGeneration(
      root,
      "session-project",
      "generation-fresh-current",
      "embedded.worker",
      "Current fresh prompt",
      "digest-fresh-current",
    );
    const wrongRoot = createProjectGeneration(
      otherRoot,
      "session-project",
      "generation-fresh-other",
      "embedded.worker",
      "Wrong-root prompt",
      "digest-fresh-other",
    );
    const unsafeCapture = {
      ...current.capture,
      config: {
        ...current.capture.config,
        filePath: path.join(root, "outside", "forged.md"),
      },
    } as ProjectAgentRunCapture;
    const reboundFor =
      (value: { capability: ProjectAgentSnapshotCapability; capture: ProjectAgentRunCapture }) =>
      async () => ({
        capability: value.capability,
        expected: getProjectAgentSnapshotProvenance(value.capability),
        capture: value.capture,
      });
    const cases: Array<{
      label: string;
      rebind: ProjectAgentRebind;
    }> = [
      { label: "removed", rebind: async () => undefined },
      { label: "renamed", rebind: async () => undefined },
      { label: "untrusted", rebind: async () => undefined },
      {
        label: "unsafe",
        rebind: reboundFor({ capability: current.capability, capture: unsafeCapture }),
      },
      { label: "wrong-root", rebind: reboundFor(wrongRoot) },
    ];
    const runIds: string[] = [];
    try {
      for (const item of cases) {
        const runId = `project-fresh-${item.label}-${Date.now().toString(36)}`;
        runIds.push(runId);
        const persisted = {
          ...original.capture,
          provenance: {
            ...original.capture.provenance,
            processInstanceId: "prior-process",
          },
        } as ProjectAgentRunCapture;
        writeStatus(runId, root, persisted);
        let dispatchCalls = 0;
        const executor = makeExecutor(
          root,
          createState(),
          { capability: current.capability, rebind: item.rebind },
          {
            executeAsyncSingle: () => {
              dispatchCalls++;
              return {
                content: [{ type: "text", text: "unsafe dispatch" }],
                details: { results: [] },
              };
            },
          },
        );
        const result = await executor.execute(
          `fresh-${item.label}`,
          { action: "resume", id: runId, message: `Reject ${item.label}.` },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true, item.label);
        assert.match(text(result), /project-agent|rebind|unsafe|root|definition/i, item.label);
        assert.equal(dispatchCalls, 0, `${item.label} must not dispatch`);
      }
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(original.capability);
      revokeIfRegistered(current.capability);
      revokeIfRegistered(wrongRoot.capability);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
  it("fails closed for session, root, process, trust, generation, digest, config, and source corruption", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fail-")),
    );
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-other-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["init", "--quiet", otherRoot]);
    const generation = createProjectGeneration(root, "session-project", "generation-fail");
    const active = { capability: generation.capability, architect: true };
    const state = createState();
    const executor = makeExecutor(root, state, active);
    const cases: Array<{
      label: string;
      mutate: (capture: ProjectAgentRunCapture) => ProjectAgentRunCapture | Record<string, unknown>;
      context?: any;
      access?: any;
    }> = [
      {
        label: "new session",
        mutate: (capture) => capture,
        context: makeContext(root, "session-other"),
      },
      {
        label: "canonical root mismatch",
        mutate: (capture) => capture,
        context: makeContext(otherRoot),
      },
      {
        label: "stale process",
        mutate: (capture) => capture,
        access: {
          capability: generation.capability,
          expected: {
            ...getProjectAgentSnapshotProvenance(generation.capability),
            processInstanceId: "stale-process",
          },
          architect: true,
        },
      },
      {
        label: "trust revocation",
        mutate: (capture) => capture,
        access: {
          capability: generation.capability,
          architect: true,
          reauthorize: async () => false,
        },
      },
      {
        label: "digest corruption",
        mutate: (capture) => ({
          ...capture,
          provenance: { ...capture.provenance, digest: "wrong" },
        }),
      },
      {
        label: "config corruption",
        mutate: (capture) => ({
          ...capture,
          config: { ...capture.config, systemPrompt: "forged" },
        }),
      },
      {
        label: "source corruption",
        mutate: (capture) => ({
          ...capture,
          provenance: { ...capture.provenance, source: "user" },
        }),
      },
    ];
    const asyncDirs: string[] = [];
    const runIds: string[] = [];
    try {
      for (const item of cases) {
        const runId = `project-fail-${item.label.replaceAll(" ", "-")}-${Date.now().toString(36)}`;
        runIds.push(runId);
        retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
        const persisted = item.mutate(generation.capture);
        asyncDirs.push(
          writeStatus(runId, root, generation.capture, {
            steps: [
              {
                agent: generation.capture.provenance.agent,
                status: "complete",
                sessionFile: path.join(runAsyncDir(runId), "worker.jsonl"),
                projectAgent: persisted,
              },
            ],
          }),
        );
        const currentExecutor = item.access
          ? createSubagentExecutor({
              pi: {
                events: { emit() {}, on: () => () => {} },
                getSessionName: () => "parent",
              } as any,
              state,
              config: { maxSubagentDepth: 2, control: {} } as any,
              tempArtifactsDir: root,
              getSubagentSessionRoot: () => root,
              expandTilde: (value) => value,
              discoverAgents: () => ({ agents: [] }),
              getProjectAgentAccess: () => item.access,
              kill: () => true,
            })
          : executor;
        const result = await currentExecutor.execute(
          "resume",
          { action: "resume", id: runId, message: `Check ${item.label}.` },
          new AbortController().signal,
          undefined,
          item.context ?? makeContext(root),
        );
        assert.equal(result.isError, true, item.label);
        assert.match(
          text(result),
          /TLH project-agent control rejected|corrupt|different session|root|trust|invalid|generation/i,
        );
      }

      const missingGenerationId = `project-fail-missing-generation-${Date.now().toString(36)}`;
      runIds.push(missingGenerationId);
      retainProjectAgentRunReference(generation.capability, missingGenerationId, [
        generation.capture,
      ]);
      const missingDir = writeStatus(missingGenerationId, root, generation.capture);
      asyncDirs.push(missingDir);
      const staleAccess = {
        capability: generation.capability,
        expected: {
          ...getProjectAgentSnapshotProvenance(generation.capability),
          generationId: "missing-generation",
        },
        architect: true,
      };
      const missingExecutor = createSubagentExecutor({
        pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
        state,
        config: { maxSubagentDepth: 2, control: {} } as any,
        tempArtifactsDir: root,
        getSubagentSessionRoot: () => root,
        expandTilde: (value) => value,
        discoverAgents: () => ({ agents: [] }),
        getProjectAgentAccess: () => staleAccess,
        kill: () => true,
      });
      const missingResult = await missingExecutor.execute(
        "resume",
        { action: "resume", id: missingGenerationId, message: "Check missing generation." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(missingResult.isError, true);
      assert.match(text(missingResult), /invalid|generation|capability|rejected/i);
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
  it("rejects removed, empty, out-of-range, cohort-paused, and mixed ordinary child markers before steering", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-steer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-steer");
    const state = createState();
    const executor = makeExecutor(root, state, { capability: generation.capability });
    const runIds: string[] = [];
    try {
      const missingMarkerId = `project-steer-marker-${Date.now().toString(36)}`;
      runIds.push(missingMarkerId);
      retainProjectAgentRunReference(generation.capability, missingMarkerId, [generation.capture]);
      const missingMarkerDir = writeStatus(missingMarkerId, root, generation.capture);
      const missingMarkerStatus = JSON.parse(
        fs.readFileSync(path.join(missingMarkerDir, "status.json"), "utf8"),
      );
      delete missingMarkerStatus.steps[0].projectAgent;
      writeJson(path.join(missingMarkerDir, "status.json"), missingMarkerStatus);
      const missingMarker = await executor.execute(
        "steer",
        { action: "steer", id: missingMarkerId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(missingMarker.isError, true);
      assert.match(text(missingMarker), /missing|corrupt|project-agent/i);

      const emptyId = `project-steer-empty-${Date.now().toString(36)}`;
      runIds.push(emptyId);
      retainProjectAgentRunReference(generation.capability, emptyId, [generation.capture]);
      const emptyDir = writeStatus(emptyId, root, generation.capture, { steps: [] });
      const empty = await executor.execute(
        "steer",
        { action: "steer", id: emptyId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(empty.isError, true);
      assert.match(text(empty), /no selectable|project-agent/i);
      assert.equal(fs.existsSync(path.join(emptyDir, "control", "steer-requests")), false);

      const rangeId = `project-steer-range-${Date.now().toString(36)}`;
      runIds.push(rangeId);
      retainProjectAgentRunReference(generation.capability, rangeId, [generation.capture]);
      writeStatus(rangeId, root, generation.capture, { state: "running" });
      const range = await executor.execute(
        "steer",
        { action: "steer", id: rangeId, index: 3, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(range.isError, true);
      assert.match(text(range), /out of range|project-agent/i);

      const cohortId = `project-steer-cohort-${Date.now().toString(36)}`;
      runIds.push(cohortId);
      retainProjectAgentRunReference(generation.capability, cohortId, [generation.capture]);
      const cohortDir = writeStatus(cohortId, root, generation.capture, {
        state: "paused",
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "paused",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(cohortId), "one.jsonl"),
          },
          {
            agent: generation.capture.provenance.agent,
            status: "paused",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(cohortId), "two.jsonl"),
          },
        ],
      });
      fs.writeFileSync(path.join(runAsyncDir(cohortId), "two.jsonl"), "", "utf8");
      const cohort = await executor.execute(
        "steer",
        { action: "steer", id: cohortId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(cohort.isError, true);
      assert.match(text(cohort), /no running or pending|project-agent/i);
      assert.equal(fs.existsSync(path.join(cohortDir, "control", "steer-requests")), false);

      const mixedId = `project-steer-mixed-${Date.now().toString(36)}`;
      runIds.push(mixedId);
      retainProjectAgentRunReference(generation.capability, mixedId, [generation.capture]);
      const mixedDir = writeStatus(mixedId, root, generation.capture, {
        state: "running",
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "running",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(mixedId), "one.jsonl"),
          },
          {
            agent: "worker",
            status: "running",
            sessionFile: path.join(runAsyncDir(mixedId), "two.jsonl"),
          },
        ],
      });
      fs.writeFileSync(path.join(runAsyncDir(mixedId), "two.jsonl"), "", "utf8");
      const mixed = await executor.execute(
        "steer",
        { action: "steer", id: mixedId, message: "Do not select an ordinary sibling." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(mixed.isError, true);
      assert.match(text(mixed), /ordinary sibling|matching retained|project-agent/i);
      assert.equal(fs.existsSync(path.join(mixedDir, "control", "steer-requests")), false);
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
