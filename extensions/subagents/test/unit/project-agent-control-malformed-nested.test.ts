import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  lookupProjectAgentRunReference,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
  retainProjectAgentRunReference,
  resolveProjectAgentSnapshot,
} from "../../src/agents/project-agent-snapshot.ts";
import {
  hasMalformedProjectAgentControlMarker,
  hasProjectAgentControlMarker,
} from "../../src/runs/foreground/project-agent-control.ts";
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

const testEnvironment = createProjectAgentControlEnvironment();

describe("project-agent control malformed and nested rejection", () => {
  beforeEach(testEnvironment.setup);
  afterEach(testEnvironment.teardown);

  it("keeps retired nested markers in deny-only scans, including malformed captures", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-nested-marker-scan-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-nested-scan");
    const validNestedMarkers: unknown[] = [
      { steps: [{ children: [{ projectAgents: [generation.capture] }] }] },
      { nestedChildren: [{ results: [{ projectAgents: [generation.capture] }] }] },
    ];
    const malformedNestedMarkers: unknown[] = [
      { steps: [{ children: [{ projectAgents: [{ forged: true }] }] }] },
      { nestedChildren: [{ results: [{ projectAgents: [{ forged: true }] }] }] },
    ];

    try {
      for (const marker of validNestedMarkers) {
        assert.equal(hasProjectAgentControlMarker(marker), true);
        assert.equal(hasMalformedProjectAgentControlMarker(marker), false);
      }
      for (const marker of malformedNestedMarkers) {
        assert.equal(hasProjectAgentControlMarker(marker), true);
        assert.equal(hasMalformedProjectAgentControlMarker(marker), true);
      }
      assert.equal(hasProjectAgentControlMarker({ projectAgent: generation.capture }), true);
      assert.equal(hasProjectAgentControlMarker({}), false);
    } finally {
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies retired nested markers for steer and interrupt without fallback side effects", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-nested-live-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-nested-live");
    const suffix = Date.now().toString(36);
    const cases = [
      {
        label: "steps children valid",
        runId: `nested-steps-children-${suffix}`,
        marker: {
          steps: [
            {
              agent: "worker",
              status: "running" as const,
              children: [{ projectAgents: [generation.capture] }],
            },
          ],
        },
      },
      {
        label: "nestedChildren results valid",
        runId: `nested-children-results-${suffix}`,
        marker: { nestedChildren: [{ results: [{ projectAgents: [generation.capture] }] }] },
      },
      {
        label: "steps children malformed",
        runId: `nested-steps-children-malformed-${suffix}`,
        marker: {
          steps: [
            {
              agent: "worker",
              status: "running" as const,
              children: [{ projectAgents: [{ forged: true }] }],
            },
          ],
        },
      },
      {
        label: "nestedChildren results malformed",
        runId: `nested-children-results-malformed-${suffix}`,
        marker: { nestedChildren: [{ results: [{ projectAgents: [{ forged: true }] }] }] },
      },
    ];
    const asyncDirs = cases.map(({ runId, marker }) => {
      const asyncDir = runAsyncDir(runId);
      fs.mkdirSync(asyncDir, { recursive: true });
      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "single",
        state: "running",
        pid: process.pid,
        sessionId: "session-project",
        cwd: root,
        startedAt: 100,
        lastUpdate: Date.now(),
        steps: [{ agent: "worker", status: "running" }],
        ...marker,
      });
      return asyncDir;
    });
    const state = createState();
    for (const [index, { runId }] of cases.entries()) {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir: asyncDirs[index]!,
        status: "running",
        pid: process.pid,
        updatedAt: Date.now() + index,
        projectAgents: undefined,
      });
    }
    let signalCalls = 0;
    const executor = makeExecutor(
      root,
      state,
      { capability: generation.capability },
      {
        kill: (_pid, signal) => {
          if (signal !== 0) signalCalls++;
          return true;
        },
      },
    );

    try {
      for (const [index, { label, runId }] of cases.entries()) {
        const steer = await executor.execute(
          `nested-marker-steer-${index}`,
          { action: "steer", id: runId, message: "must not become a fallback message" },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(steer.isError, true, label);
        assert.match(text(steer), /private reference|project-agent|fallback/i);
        assert.doesNotMatch(text(steer), /Steering queued|Interrupt requested/);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "steer-requests")),
          false,
          label,
        );

        const interrupt = await executor.execute(
          `nested-marker-interrupt-${index}`,
          { action: "interrupt", id: runId },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(interrupt.isError, true, label);
        assert.match(text(interrupt), /private reference|project-agent|fallback/i);
        assert.doesNotMatch(text(interrupt), /Interrupt requested/);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "interrupt.json")),
          false,
          label,
        );
      }
      assert.equal(signalCalls, 0);
    } finally {
      for (const { runId } of cases) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects capture-bearing controls when the private reference is missing", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-ordinary-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-ordinary");
    const state = createState();
    const runId = `ordinary-steer-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(path.join(asyncDir, "worker.jsonl"), "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: "worker",
          status: "running",
          sessionFile: path.join(asyncDir, "worker.jsonl"),
          // Artifact presence alone must not turn an ordinary control into a
          // project authorization path when no private run reference exists.
          projectAgent: generation.capture,
        },
      ],
    });
    try {
      const executor = makeExecutor(root, state, {
        capability: generation.capability,
        architect: false,
      });
      const result = await executor.execute(
        "steer",
        { action: "steer", id: runId, message: "Do not fall back." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      const requestDir = path.join(asyncDir, "control", "steer-requests");
      assert.equal(fs.existsSync(requestDir), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("denies marker-bearing resume before same-name profile discovery", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-missing-resume-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-missing-resume",
    );
    const runId = `project-missing-resume-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture);
    const impostor = {
      ...makeAgent(root, generation.capture.provenance.agent, "Profile impostor"),
      packageName: "profile",
      source: "user",
      filePath: path.join(root, "profile", "impostor.md"),
    };
    let discoveryCalls = 0;
    let dispatchCalls = 0;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability },
      {
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [impostor] };
        },
        executeAsyncSingle: () => {
          dispatchCalls++;
          return { content: [{ type: "text", text: "forged dispatch" }], details: { results: [] } };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not dispatch the profile impostor." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(discoveryCalls, 0);
      assert.equal(dispatchCalls, 0);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects malformed retained project identity before continuation spawn", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-malformed-identity-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const malformedAgent = { ...makeAgent(root, "embedded.worker"), tools: [] };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "session-project",
      generationId: "generation-malformed-identity",
      entries: [
        {
          agent: malformedAgent as never,
          digest: "digest-malformed-identity",
          frontmatterFields: ["tools"],
        },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, malformedAgent as never);
    const runId = `project-malformed-identity-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, capture);
    retainProjectAgentRunReference(capability, runId, [capture]);
    let continuationSpawned = false;
    const executor = makeExecutor(
      root,
      createState(),
      { capability },
      {
        executeAsyncSingle: (continuationId: string) => {
          continuationSpawned = true;
          return {
            content: [{ type: "text", text: "forged continuation" }],
            details: { asyncId: continuationId, results: [] },
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume-malformed-identity",
        { action: "resume", id: runId, message: "Do not continue malformed identity." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /does not carry an explicit usable tools list/);
      assert.equal(continuationSpawned, false);
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");
      assert.equal(fs.existsSync(path.join(asyncDir, "control")), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("denies marker-bearing steer for architect and non-architect paths without a reference", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-missing-steer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-missing-steer");
    const runIds = [
      `project-missing-steer-architect-${Date.now().toString(36)}`,
      `project-missing-steer-nonarchitect-${Date.now().toString(36)}`,
    ];
    const asyncDirs = runIds.map((runId) =>
      writeStatus(runId, root, generation.capture, { state: "running" }),
    );
    try {
      for (const [index, architect] of [true, false].entries()) {
        const executor = makeExecutor(root, createState(), {
          capability: generation.capability,
          architect,
        });
        const result = await executor.execute(
          "steer",
          { action: "steer", id: runIds[index], message: "Do not fall back." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true, architect ? "architect" : "non-architect");
        assert.match(text(result), /private reference|project-agent|fallback/i);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "steer-requests")),
          false,
        );
      }
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      for (const asyncDir of asyncDirs) fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed when interrupting a project run loses its process-private reference", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-marker-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-interrupt");
    const runIds = [
      `project-interrupt-marker-architect-${Date.now().toString(36)}`,
      `project-interrupt-marker-nonarchitect-${Date.now().toString(36)}`,
    ];
    const asyncDirs = runIds.map((runId) =>
      writeStatus(runId, root, generation.capture, { state: "running" }),
    );
    try {
      for (const [index, architect] of [true, false].entries()) {
        let signalled = false;
        const executor = makeExecutor(
          root,
          createState(),
          { capability: generation.capability, architect },
          { kill: () => (signalled = true) },
        );
        // The run is intentionally not retained in the current process. An
        // interrupt must not silently become ordinary control over a persisted
        // project marker, regardless of primary mode.
        const result = await executor.execute(
          `interrupt-project-marker-${architect ? "architect" : "nonarchitect"}`,
          { action: "interrupt", id: runIds[index]! },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true);
        assert.match(text(result), /private reference|project-agent|fallback/i);
        assert.equal(signalled, false);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "interrupt.json")),
          false,
        );
      }
    } finally {
      for (const asyncDir of asyncDirs) fs.rmSync(asyncDir, { recursive: true, force: true });
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires interrupt resolution to match retained project runs and preserves ordinary errors", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-prefix-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-interrupt-prefix",
    );
    const suffix = Date.now().toString(36);
    const projectRunId = `target-project-${suffix}`;
    const mismatchedRunId = `target-other-${suffix}`;
    const ordinaryRunId = `ordinary-interrupt-${suffix}`;
    const ambiguousRunIds = [
      `ambiguous-project-interrupt-a-${suffix}`,
      `ambiguous-project-interrupt-b-${suffix}`,
    ];
    const genericAmbiguousRunIds = [
      `generic-interrupt-a-${suffix}`,
      `generic-interrupt-b-${suffix}`,
    ];
    const mismatchedDir = writeStatus(mismatchedRunId, root, generation.capture, {
      state: "running",
    });
    const ordinaryDir = writeStatus(ordinaryRunId, root, generation.capture, {
      state: "running",
    });
    for (const asyncDir of [mismatchedDir, ordinaryDir]) {
      const statusPath = path.join(asyncDir, "status.json");
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      delete status.steps[0].projectAgent;
      writeJson(statusPath, status);
    }
    retainProjectAgentRunReference(generation.capability, projectRunId, [generation.capture]);
    for (const runId of ambiguousRunIds) {
      retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    }
    try {
      let signalled = false;
      const executor = makeExecutor(
        root,
        createState(),
        { capability: generation.capability },
        { kill: () => (signalled = true) },
      );
      const mismatched = await executor.execute(
        "interrupt-prefix-mismatch",
        { action: "interrupt", id: "target-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(mismatched.isError, true);
      assert.match(text(mismatched), /does not match the resolved interrupt target/);
      assert.equal(signalled, false);
      assert.equal(fs.existsSync(path.join(mismatchedDir, "control", "interrupt.json")), false);

      const ambiguous = await executor.execute(
        "interrupt-prefix-ambiguous",
        { action: "interrupt", id: "ambiguous-project-interrupt-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ambiguous.isError, true);
      assert.match(text(ambiguous), /TLH project-agent control rejected/);
      assert.match(text(ambiguous), /ambiguous in the retained project-agent registry/);
      assert.equal(signalled, false);

      const ordinary = await executor.execute(
        "interrupt-ordinary",
        { action: "interrupt", id: ordinaryRunId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ordinary.isError, undefined, text(ordinary));
      assert.match(text(ordinary), /Interrupt requested for async run/);
      assert.doesNotMatch(text(ordinary), /TLH project-agent control rejected/);
      assert.equal(signalled, true);
      assert.equal(fs.existsSync(path.join(ordinaryDir, "control", "interrupt.json")), true);

      for (const runId of genericAmbiguousRunIds) {
        fs.mkdirSync(runAsyncDir(runId), { recursive: true });
      }
      const genericAmbiguous = await executor.execute(
        "interrupt-generic-prefix-ambiguous",
        { action: "interrupt", id: "generic-interrupt-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(genericAmbiguous.isError, true);
      assert.match(text(genericAmbiguous), /Ambiguous subagent run id prefix/);
      assert.doesNotMatch(text(genericAmbiguous), /TLH project-agent control rejected/);
    } finally {
      for (const runId of genericAmbiguousRunIds) {
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentRunReference(projectRunId);
      for (const runId of ambiguousRunIds) releaseProjectAgentRunReference(runId);
      cleanupRun(mismatchedRunId);
      cleanupRun(ordinaryRunId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps marker-free ordinary resume and steer behavior unchanged", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-ordinary-marker-free-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-ordinary-free");
    const impostor = {
      ...makeAgent(root, generation.capture.provenance.agent, "Profile ordinary agent"),
      packageName: "profile",
      source: "user",
      filePath: path.join(root, "profile", "ordinary.md"),
    };
    const resumeId = `ordinary-resume-${Date.now().toString(36)}`;
    const steerId = `ordinary-steer-${Date.now().toString(36)}`;
    const resumeDir = writeStatus(resumeId, root, generation.capture);
    const steerDir = writeStatus(steerId, root, generation.capture, { state: "running" });
    for (const statusPath of [
      path.join(resumeDir, "status.json"),
      path.join(steerDir, "status.json"),
    ]) {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      delete status.steps[0].projectAgent;
      writeJson(statusPath, status);
    }
    let discoveryCalls = 0;
    let dispatchCalls = 0;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability, architect: false },
      {
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [impostor] };
        },
        executeAsyncSingle: (runId: string) => {
          dispatchCalls++;
          return {
            content: [{ type: "text", text: "ordinary resumed" }],
            details: { asyncId: runId, results: [] },
          };
        },
      },
    );
    try {
      const resumed = await executor.execute(
        "resume",
        { action: "resume", id: resumeId, message: "Continue ordinary work." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(resumed.isError, undefined);
      const steered = await executor.execute(
        "steer",
        { action: "steer", id: steerId, message: "Steer ordinary work." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(steered.isError, undefined);
      assert.equal(discoveryCalls, 1);
      assert.equal(dispatchCalls, 1);
      assert.ok(fs.existsSync(path.join(steerDir, "control", "steer-requests")));
    } finally {
      cleanupRun(resumeId);
      cleanupRun(steerId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(resumeDir, { recursive: true, force: true });
      fs.rmSync(steerDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("authorizes concrete interrupt fallback targets while rejecting retired public directories", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-fallback-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-interrupt-fallback",
    );
    const projectRunId = `project-interrupt-fallback-${Date.now().toString(36)}`;
    const projectAsyncDir = writeStatus(projectRunId, root, generation.capture, {
      state: "running",
    });
    let ordinaryRunId: string | undefined;
    const state = createState();
    state.asyncJobs.set(projectRunId, {
      asyncId: projectRunId,
      asyncDir: projectAsyncDir,
      status: "running",
      pid: 12345,
      updatedAt: 0,
      projectAgents: [generation.capture],
    });
    let signalCalls = 0;
    const executor = makeExecutor(
      root,
      state,
      { capability: generation.capability },
      {
        kill: () => {
          signalCalls++;
          return true;
        },
      },
    );
    try {
      const noId = await executor.execute(
        "interrupt-no-id-project",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(noId.isError, true);
      assert.match(text(noId), /private reference|project-agent|fallback/i);
      assert.equal(signalCalls, 0);
      assert.equal(fs.existsSync(path.join(projectAsyncDir, "control", "interrupt.json")), false);

      const dirOnly = await executor.execute(
        "interrupt-dir-only-project",
        { action: "interrupt", dir: projectAsyncDir },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(dirOnly.isError, true);
      assert.equal(
        text(dirOnly),
        "dir is no longer supported. Run directories are resolved internally; public dir selectors are no longer supported.",
      );
      assert.equal(signalCalls, 0);
      assert.equal(fs.existsSync(path.join(projectAsyncDir, "control", "interrupt.json")), false);

      ordinaryRunId = `ordinary-interrupt-fallback-${Date.now().toString(36)}`;
      const ordinaryDir = writeStatus(ordinaryRunId, root, generation.capture, {
        state: "running",
      });
      const ordinaryStatusPath = path.join(ordinaryDir, "status.json");
      const ordinaryStatus = JSON.parse(fs.readFileSync(ordinaryStatusPath, "utf8"));
      delete ordinaryStatus.steps[0].projectAgent;
      writeJson(ordinaryStatusPath, ordinaryStatus);
      state.asyncJobs.set(ordinaryRunId, {
        asyncId: ordinaryRunId,
        asyncDir: ordinaryDir,
        status: "running",
        pid: 12345,
        updatedAt: Date.now() + 1000,
        projectAgents: undefined,
      });
      assert.equal(Object.hasOwn(state.asyncJobs.get(ordinaryRunId)!, "projectAgents"), true);
      const explicitOrdinary = await executor.execute(
        "interrupt-explicit-ordinary",
        { action: "interrupt", id: ordinaryRunId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(explicitOrdinary.isError, undefined, text(explicitOrdinary));
      assert.match(text(explicitOrdinary), /Interrupt requested for async run/);
      assert.equal(signalCalls > 0, true);
      const signalsAfterExplicit = signalCalls;
      const ordinary = await executor.execute(
        "interrupt-no-id-ordinary",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ordinary.isError, undefined, text(ordinary));
      assert.match(
        text(ordinary),
        new RegExp(`Interrupt requested for async run ${ordinaryRunId}`),
      );
      assert.equal(signalCalls > signalsAfterExplicit, true);
      assert.equal(fs.existsSync(path.join(ordinaryDir, "control", "interrupt.json")), true);
    } finally {
      if (ordinaryRunId) cleanupRun(ordinaryRunId);
      cleanupRun(projectRunId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps paused ordinary interrupts safe while rejecting retired public directories", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-paused-ordinary-interrupt-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-paused-ordinary-interrupt",
    );
    const runId = `paused-ordinary-interrupt-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "paused",
      pid: 12345,
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      sessionFile,
      pause: { kind: "awaiting_supervisor", pausedAt: Date.now() },
      steps: [{ agent: "ordinary", status: "paused", sessionFile }],
    });
    const state = createState();
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir,
      status: "running",
      pid: 12345,
      updatedAt: Date.now(),
      projectAgents: undefined,
    });
    const executor = makeExecutor(root, state, { capability: generation.capability });
    try {
      const noId = await executor.execute(
        "interrupt-paused-ordinary",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(noId.isError, true);
      assert.match(text(noId), /No running async run|interrupt-capable pid/i);
      const noIdStatus: unknown = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"),
      );
      assert.ok(
        typeof noIdStatus === "object" && noIdStatus !== null && !Array.isArray(noIdStatus),
      );
      assert.equal((noIdStatus as { state?: unknown }).state, "paused");
      assert.equal((noIdStatus as { cancel?: unknown }).cancel, undefined);

      const dirOnly = await executor.execute(
        "interrupt-paused-ordinary-dir",
        { action: "interrupt", dir: asyncDir },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(dirOnly.isError, true);
      assert.equal(
        text(dirOnly),
        "dir is no longer supported. Run directories are resolved internally; public dir selectors are no longer supported.",
      );
      const dirStatus: unknown = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"),
      );
      assert.ok(typeof dirStatus === "object" && dirStatus !== null && !Array.isArray(dirStatus));
      assert.equal((dirStatus as { state?: unknown }).state, "paused");
      assert.equal((dirStatus as { cancel?: unknown }).cancel, undefined);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed when no-id interrupt falls through to a project-marked foreground run", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-foreground-fallback-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-foreground-fallback",
    );
    const runId = `project-foreground-fallback-${Date.now().toString(36)}`;
    const state = createState();
    let signalled = false;
    state.foregroundRuns!.set(runId, {
      runId,
      mode: "single",
      cwd: root,
      updatedAt: Date.now(),
      children: [
        {
          agent: generation.capture.provenance.agent,
          index: 0,
          status: "running",
          projectAgent: generation.capture,
        },
      ],
    } as never);
    state.foregroundControls.set(runId, {
      runId,
      mode: "single",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      interrupt: () => {
        signalled = true;
        return true;
      },
    } as never);
    state.lastForegroundControlId = runId;
    const executor = makeExecutor(root, state, { capability: generation.capability });
    try {
      const result = await executor.execute(
        "interrupt-no-id-foreground-project",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);
    } finally {
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("authorizes a same-id async fallback independently of a foreground registry entry", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-dual-interrupt-registry-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-dual-interrupt-registry",
    );
    const runId = `dual-interrupt-registry-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture, { state: "running" });
    const state = createState();
    state.foregroundRuns!.set(runId, {
      runId,
      mode: "single",
      cwd: root,
      updatedAt: Date.now(),
      children: [{ agent: "ordinary", index: 0, status: "completed" }],
    } as never);
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir,
      status: "running",
      pid: 12345,
      updatedAt: Date.now() + 1,
      projectAgents: undefined,
    });
    let signalled = false;
    const executor = makeExecutor(
      root,
      state,
      { capability: generation.capability },
      { kill: () => (signalled = true) },
    );
    try {
      const result = await executor.execute(
        "interrupt-dual-registry",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("denies malformed project markers instead of degrading to profile control", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-malformed-marker-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-malformed-marker",
    );
    const runId = `project-malformed-marker-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture);
    const statusPath = path.join(asyncDir, "status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    delete status.steps[0].projectAgent;
    status.projectAgents = [generation.capture];
    writeJson(statusPath, status);
    let discoveryCalls = 0;
    let signalled = false;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability },
      {
        kill: () => {
          signalled = true;
          return true;
        },
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [makeAgent(root, generation.capture.provenance.agent)] };
        },
      },
    );
    try {
      const inventoryResult = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not degrade from a run inventory." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(inventoryResult.isError, true);
      assert.match(text(inventoryResult), /private reference|project-agent|fallback/i);
      assert.equal(discoveryCalls, 0);
      const interruptResult = await executor.execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(interruptResult.isError, true);
      assert.match(text(interruptResult), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);

      status.projectAgents = [{ forged: true }];
      writeJson(statusPath, status);
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not degrade malformed markers." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /invalid|project-agent|rejected/i);
      assert.equal(discoveryCalls, 0);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
