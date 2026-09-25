import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ACCEPTANCE_EVIDENCE_REPORT_FILE,
  evaluateAcceptanceWorkspace,
  evaluationExitCode,
  writeAcceptanceEvidenceReport,
} from "./tlh-acceptance-evidence.mjs";

const suiteId = "tlh-packaged-acceptance";
const candidateCommit = "candidate-commit";

function jsonl(entries, trailingNewline = true) {
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function put(root, path, value, options = {}) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(
    target,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    options,
  );
  return target;
}

function sessionFile(root, id, options = {}) {
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-09-08T00:00:00.000Z",
      cwd: "/owned/fixture",
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    },
  ];
  let parentId = null;
  const append = (entry) => {
    entries.push({ ...entry, parentId, timestamp: entry.timestamp || "2026-09-08T00:00:01.000Z" });
    parentId = entry.id;
  };
  if (options.approval) {
    append({
      type: "message",
      id: "approval",
      message: { role: "user", content: "approve the prepared plan", timestamp: 1 },
    });
  }
  for (const call of options.calls || [{ id: "tool-call", name: "read" }]) {
    append({
      type: "message",
      id: `${call.id}-assistant`,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments || {} },
        ],
        api: "test",
        provider: "test-provider",
        model: "test-model",
        usage: {},
        stopReason: "toolUse",
        timestamp: 1,
      },
    });
    append({
      type: "message",
      id: `${call.id}-result`,
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "observed" }],
        isError: false,
        timestamp: 2,
      },
    });
  }
  append({
    type: "message",
    id: "final",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 3 },
  });
  return put(root, `sessions/${id}.jsonl`, jsonl(entries));
}

function nativeModelFields(model = "provider/model", thinking = "medium") {
  return {
    model,
    thinking,
    modelIdentity: { provider: "provider", model: "model", thinking },
    modelResolution: { kind: "explicit", source: "acceptance-fixture" },
    attemptedModels: [model],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
}

function nativeToolResult({ agent, runId, childSessionId, isError = false, observedModel = true }) {
  const details = {
    mode: "single",
    ...(runId ? { runId } : {}),
    results: isError
      ? []
      : [
          {
            agent,
            task: "fixture task",
            exitCode: 0,
            sessionFile: `sessions/${childSessionId}.jsonl`,
            ...(observedModel ? nativeModelFields() : undefined),
          },
        ],
  };
  return {
    content: [{ type: "text", text: isError ? `Unknown agent: ${agent}` : "done" }],
    ...(isError ? { isError: true } : {}),
    details,
  };
}

function parentSessionFile(root, calls = []) {
  const entries = [
    {
      type: "session",
      version: 3,
      id: "parent-session",
      timestamp: "2026-09-08T00:00:00.000Z",
      cwd: "/owned/fixture",
    },
  ];
  let parentId = null;
  const append = (entry) => {
    entries.push({ ...entry, parentId, timestamp: entry.timestamp || "2026-09-08T00:00:01.000Z" });
    parentId = entry.id;
  };
  append({
    type: "message",
    id: "plan-approval",
    message: { role: "user", content: "approve", timestamp: 1 },
  });
  for (const call of calls) {
    append({
      type: "message",
      id: call.entryId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: call.callId,
            name: "subagent",
            arguments: {
              agent: call.agent,
              cwd: "workspace/fixture",
              model: "provider/model:medium",
              agentScope: "user",
              context: "fresh",
            },
          },
        ],
        api: "test",
        provider: "test-provider",
        model: "test-model",
        usage: {},
        stopReason: "toolUse",
        timestamp: 2,
      },
    });
    append({
      type: "message",
      id: `${call.entryId}-result`,
      message: {
        role: "toolResult",
        toolCallId: call.callId,
        toolName: "subagent",
        ...nativeToolResult({
          agent: call.agent,
          runId: call.runId,
          childSessionId: call.childSessionId || `child-${call.agent}-${call.runId}`,
          isError: call.isError === true,
          observedModel: call.observedModel !== false,
        }),
        timestamp: 3,
      },
    });
  }
  return put(root, "sessions/parent-session.jsonl", jsonl(entries));
}

function makeJob(root, runId, agent, options = {}) {
  const childId = options.childSessionId || `child-${agent}-${runId}`;
  const state = options.state || "complete";
  const resultState = options.resultState || state;
  const success = options.success ?? state === "complete";
  const sessionReference = `sessions/${childId}.jsonl`;
  const observedModel =
    options.observedModel === false
      ? {}
      : nativeModelFields(options.observedModel || "provider/model", options.thinking || "medium");
  sessionFile(root, childId, {
    calls: options.calls || [{ id: `${agent}-read`, name: "read" }],
  });
  const status = {
    lifecycleArtifactVersion: 1,
    runId,
    sessionId: "parent-session",
    mode: "single",
    state,
    startedAt: 1,
    endedAt: 3,
    ...(state === "continued"
      ? {
          lifecycle: {
            continuation: { phase: "continued", continuationRunId: `${runId}-continuation` },
          },
        }
      : {}),
    ...(state === "paused"
      ? { pause: { kind: "awaiting_supervisor", requestedAt: 2, pausedAt: 2 }, pid: undefined }
      : {}),
    steps: [
      {
        agent,
        status: state === "complete" ? "complete" : state === "continued" ? "continued" : state,
        sessionFile: sessionReference,
        ...observedModel,
        ...options.statusStep,
      },
    ],
  };
  const result = {
    lifecycleArtifactVersion: 1,
    id: runId,
    agent,
    mode: "single",
    success,
    state: resultState,
    summary: success ? "done" : "failed",
    results: [
      {
        agent,
        success,
        exitCode: success ? 0 : 1,
        sessionFile: sessionReference,
        output: success ? "done" : "provider failure",
        ...observedModel,
        ...options.resultStep,
      },
    ],
  };
  const eventTypes = [
    { type: "subagent.run.started", lifecycleArtifactVersion: 1, ts: 1, runId },
    { type: "subagent.step.started", ts: 1, runId, stepIndex: 0, agent },
  ];
  if (options.lifecycle) {
    eventTypes.push({ type: "subagent.run.pausing", ts: 2, runId });
    eventTypes.push({ type: "subagent.run.paused", ts: 2, runId });
    eventTypes.push({ type: "subagent.resume.requested", ts: 2, runId });
  }
  eventTypes.push({
    type:
      state === "failed"
        ? "subagent.step.failed"
        : state === "paused"
          ? "subagent.step.paused"
          : "subagent.step.completed",
    ts: 3,
    runId,
    stepIndex: 0,
    agent,
    exitCode: success ? 0 : 1,
  });
  eventTypes.push({
    type: "subagent.run.completed",
    lifecycleArtifactVersion: 1,
    ts: 3,
    runId,
    status: state,
  });
  eventTypes.push(...(options.nativeEvents || []));
  put(root, `jobs/${runId}/status.json`, status);
  put(root, `jobs/${runId}/result.json`, result);
  put(root, `jobs/${runId}/events.jsonl`, jsonl(eventTypes));
  return {
    runId,
    agent,
    childSessionId: childId,
    statusPath: `jobs/${runId}/status.json`,
    resultPath: `jobs/${runId}/result.json`,
    eventsPath: `jobs/${runId}/events.jsonl`,
  };
}

function baseManifest(scenarioId, checks, options = {}) {
  return {
    schemaVersion: 1,
    suiteId,
    suiteVersion: 1,
    scenarioId,
    status: options.status || "prepared",
    scoreStatus: "pending",
    acceptanceModel: { requested: "provider/model:medium" },
    candidate: { status: "ready", mode: "packaged-commit", commit: candidateCommit },
    fixture: {
      workspacePath: "workspace/fixture",
      baselineCommit: "baseline",
      ticketIds: options.ticketIds || [],
      evidenceDirectory: "evidence/",
    },
    checks,
    ...(options.dispatchPolicy ? { dispatchPolicy: options.dispatchPolicy } : {}),
    ...(options.prerequisites ? { prerequisites: { missing: options.prerequisites } } : {}),
  };
}

function setupWorkspace(scenarioId, checks, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "tlh-acceptance-evidence-test-"));
  mkdirSync(join(root, "artifacts", scenarioId, "evidence"), { recursive: true });
  mkdirSync(join(root, "workspace", "fixture", ".tickets"), { recursive: true });
  put(
    root,
    `artifacts/${scenarioId}/evidence-manifest.json`,
    baseManifest(scenarioId, checks, options),
  );
  return root;
}

function writeEvidence(root, scenarioId, name, records, trailingNewline = true) {
  return put(root, `artifacts/${scenarioId}/evidence/${name}`, jsonl(records, trailingNewline));
}

function check(id, location, extra = {}) {
  return { id, label: id, captureLocations: [location], ...extra };
}

function dispatchEvidence({
  checkId,
  agent,
  runId,
  callId,
  entryId,
  sequence,
  childSessionId,
  extra = {},
}) {
  return {
    kind: "dispatch",
    checkId,
    candidateCommit,
    agent,
    sequence,
    parentSessionId: "parent-session",
    parentSessionPath: "sessions/parent-session.jsonl",
    parentEntryId: entryId,
    toolCallId: callId,
    childSessionId,
    runId,
    toolCall: {
      id: callId,
      name: "subagent",
      input: {
        agent,
        cwd: "workspace/fixture",
        agentScope: "user",
        model: "provider/model:medium",
      },
    },
    toolResult: nativeToolResult({ agent, runId, childSessionId }),
    resolvedScope: "user",
    childScope: "user",
    ...extra,
  };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("prepared and absent evidence stays pending and never becomes a manual pass", () => {
  const root = setupWorkspace("architect-e2e", [
    check(
      "architect-independent-function-behavior",
      "artifacts/architect-e2e/evidence/behavior.jsonl",
    ),
  ]);
  try {
    const report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.status, "pending");
    assert.equal(report.summary.checks.deterministic.pending, 1);
    assert.equal(report.scenarios[0].checks[0].passed, null);
    assert.equal(evaluationExitCode(report), 2);
    assert.equal(writeAcceptanceEvidenceReport(root, report), ACCEPTANCE_EVIDENCE_REPORT_FILE);
    assert.deepEqual(evaluateAcceptanceWorkspace(root), report);
  } finally {
    cleanup(root);
  }
});

test("architect machine checks require native approvals, ordered dispatches, fixture evidence, and terminal jobs", () => {
  const checks = [
    check("architect-plan-approval-gate", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-ticket-approval-gate", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-developer-dispatch", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-test-runner-dispatch", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-code-reviewer-dispatch", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-independent-function-behavior", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-orchestration-boundary", "artifacts/architect-e2e/evidence/flow.jsonl"),
    check("architect-fixture-repo-contained", "artifacts/architect-e2e/evidence/flow.jsonl"),
  ];
  const root = setupWorkspace("architect-e2e", checks, {
    ticketIds: ["implementation", "validation"],
  });
  try {
    put(root, "workspace/fixture/.tickets/implementation.md", "ticket\n");
    put(root, "workspace/fixture/.tickets/validation.md", "ticket\n");
    put(root, "artifacts/architect-e2e/evidence/function-behavior.json", {
      candidateCommit,
      command: "node --input-type=module -e '<independent probe>'",
      cwd: "workspace/fixture",
      exitCode: 0,
      stdout: "independent behavior passed\n",
      stderr: "",
      independent: true,
      expectedBehaviorChecked: true,
    });
    const roles = ["developer", "test-runner", "code-reviewer"];
    const calls = roles.map((agent) => ({
      agent,
      callId: `${agent}-call`,
      entryId: `${agent}-dispatch`,
      runId: `architect-${agent}`,
      childSessionId: `child-${agent}-architect-${agent}`,
    }));
    parentSessionFile(root, calls);
    const records = [
      {
        kind: "approval",
        checkId: "architect-plan-approval-gate",
        candidateCommit,
        actor: "user",
        decision: "approved",
        sessionPath: "sessions/parent-session.jsonl",
        entryId: "plan-approval",
      },
      {
        kind: "approval",
        checkId: "architect-ticket-approval-gate",
        candidateCommit,
        actor: "user",
        decision: "approved",
        ticketIds: ["implementation", "validation"],
        sessionPath: "sessions/parent-session.jsonl",
        entryId: "plan-approval",
      },
    ];
    for (const [index, call] of calls.entries()) {
      const job = makeJob(root, `architect-${call.agent}`, call.agent);
      records.push(
        dispatchEvidence({
          checkId: `architect-${call.agent}-dispatch`,
          agent: call.agent,
          runId: job.runId,
          callId: call.callId,
          entryId: call.entryId,
          sequence: index + 1,
          childSessionId: job.childSessionId,
        }),
      );
      records.push({
        kind: "job",
        checkId: `architect-${call.agent}-dispatch`,
        candidateCommit,
        ...job,
      });
    }
    records.push(
      {
        kind: "fixture-change",
        checkId: "architect-independent-function-behavior",
        candidateCommit,
        fixturePath: "workspace/fixture",
        observed: true,
        changedFiles: ["src/greeter.mjs", "test/greeter.test.mjs"],
        staged: false,
        outsideFixture: false,
      },
      {
        kind: "fixture-test",
        checkId: "architect-independent-function-behavior",
        candidateCommit,
        fixturePath: "workspace/fixture",
        resultPath: "artifacts/architect-e2e/evidence/function-behavior.json",
      },
      {
        kind: "orchestration",
        parentSessionId: "parent-session",
        parentSessionPath: "sessions/parent-session.jsonl",
        parentEntryId: "developer-dispatch",
        toolCallId: "developer-call",
        runId: "architect-developer",
        childSessionId: "child-developer-architect-developer",
        checkId: "architect-orchestration-boundary",
        candidateCommit,
        parentEdited: false,
        childEdited: true,
        dispatchObserved: true,
      },
      {
        kind: "fixture-change",
        checkId: "architect-fixture-repo-contained",
        candidateCommit,
        fixturePath: "workspace/fixture",
        observed: true,
        changedFiles: ["src/greeter.mjs"],
        staged: false,
        outsideFixture: false,
      },
    );
    writeEvidence(root, "architect-e2e", "flow.jsonl", records);
    const report = evaluateAcceptanceWorkspace(root);
    const repeat = evaluateAcceptanceWorkspace(root);
    assert.deepEqual(repeat, report);
    assert.match(report.metadata.idempotencyKey, /^[a-f0-9]{64}$/);
    assert.equal(report.status, "passed");
    assert.equal(report.summary.checks.deterministic.failed, 0);
    assert.equal(report.summary.checks.deterministic.pending, 0);
    assert.equal(report.summary.checks.deterministic.passed, 8);
    assert.equal(evaluationExitCode(report), 0);
    assert.equal(report.identity.candidate.commit, candidateCommit);
    assert.equal(report.identity.suiteId, suiteId);
    assert.equal(
      report.metadata.evidenceReferences.some((ref) => ref.includes("sessions/")),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test("subagent role, scope, fresh-context, denied-target, lifecycle, and human checks remain separate", () => {
  const roles = [
    "developer",
    "test-runner",
    "code-reviewer",
    "repo-scout",
    "diff-summarizer",
    "librarian",
    "web-scout",
    "oracle",
    "contrarian",
  ];
  const checks = roles.flatMap((role) => [
    check(
      `subagent-acceptance-${role}-dispatch`,
      `artifacts/subagent-acceptance/evidence/roles/${role}-dispatch.jsonl`,
    ),
    check(
      `subagent-acceptance-${role}-execution`,
      `artifacts/subagent-acceptance/evidence/roles/${role}-result.jsonl`,
    ),
  ]);
  checks.push(
    check(
      "subagent-acceptance-nonallowlisted-block",
      "artifacts/subagent-acceptance/evidence/blocked.jsonl",
    ),
    check("subagent-acceptance-user-scope", "artifacts/subagent-acceptance/evidence/scope.jsonl"),
    check(
      "subagent-acceptance-fresh-context",
      "artifacts/subagent-acceptance/evidence/fresh.jsonl",
    ),
    check(
      "subagent-acceptance-native-supervisor-pause-resume",
      "artifacts/subagent-acceptance/evidence/lifecycle.jsonl",
    ),
    check(
      "subagent-acceptance-async-status-resume",
      "artifacts/subagent-acceptance/evidence/lifecycle.jsonl",
    ),
    check(
      "subagent-acceptance-compact-description",
      "artifacts/subagent-acceptance/evidence/manual.jsonl",
      { humanReviewRequired: true },
    ),
    check(
      "subagent-acceptance-max-thinking-badge",
      "artifacts/subagent-acceptance/evidence/manual.jsonl",
      { humanReviewRequired: true },
    ),
  );
  const root = setupWorkspace("subagent-acceptance", checks, {
    dispatchPolicy: { allowedRoles: roles, requiredScope: "user", freshContext: true },
  });
  try {
    const calls = roles.map((agent) => ({
      agent,
      callId: `${agent}-call`,
      entryId: `${agent}-dispatch`,
      runId: `role-${agent}`,
      childSessionId: `child-${agent}-role-${agent}`,
    }));
    parentSessionFile(root, [
      ...calls,
      {
        agent: "planner",
        callId: "planner-call",
        entryId: "planner-blocked",
        isError: true,
      },
    ]);
    const lifecycleJob = makeJob(root, "lifecycle-job", "developer", {
      state: "continued",
      resultState: "continued",
      success: false,
      lifecycle: true,
      calls: [
        { id: "contact", name: "contact_supervisor", arguments: { reason: "need_decision" } },
        { id: "resume-read", name: "read" },
      ],
    });
    const roleRecords = [];
    for (const [index, role] of roles.entries()) {
      const job = makeJob(root, `role-${role}`, role);
      writeEvidence(root, "subagent-acceptance", `roles/${role}-dispatch.jsonl`, [
        dispatchEvidence({
          checkId: `subagent-acceptance-${role}-dispatch`,
          agent: role,
          runId: job.runId,
          callId: `${role}-call`,
          entryId: `${role}-dispatch`,
          sequence: index + 1,
          childSessionId: job.childSessionId,
        }),
      ]);
      writeEvidence(root, "subagent-acceptance", `roles/${role}-result.jsonl`, [
        { kind: "job", checkId: `subagent-acceptance-${role}-execution`, candidateCommit, ...job },
      ]);
      roleRecords.push(
        dispatchEvidence({
          checkId: `subagent-acceptance-${role}-dispatch`,
          agent: role,
          runId: job.runId,
          callId: `${role}-call`,
          entryId: `${role}-dispatch`,
          sequence: index + 1,
          childSessionId: job.childSessionId,
        }),
      );
    }
    writeEvidence(root, "subagent-acceptance", "blocked.jsonl", [
      {
        kind: "no-launch",
        checkId: "subagent-acceptance-nonallowlisted-block",
        candidateCommit,
        target: "planner",
        launchObserved: false,
        parentSessionId: "parent-session",
        parentSessionPath: "sessions/parent-session.jsonl",
        parentEntryId: "planner-blocked",
        toolCallId: "planner-call",
        toolCall: {
          id: "planner-call",
          name: "subagent",
          input: {
            agent: "planner",
            cwd: "workspace/fixture",
            model: "provider/model:medium",
            agentScope: "user",
            context: "fresh",
          },
        },
        toolResult: nativeToolResult({ agent: "planner", isError: true }),
      },
    ]);
    writeEvidence(root, "subagent-acceptance", "scope.jsonl", roleRecords);
    writeEvidence(root, "subagent-acceptance", "fresh.jsonl", roleRecords);
    writeEvidence(root, "subagent-acceptance", "lifecycle.jsonl", [
      {
        kind: "lifecycle",
        checkId: "subagent-acceptance-native-supervisor-pause-resume",
        candidateCommit,
        ...lifecycleJob,
        receiptId: lifecycleJob.runId,
        resumeId: lifecycleJob.runId,
        request: { tool: "contact_supervisor" },
        sessionPath: "sessions/child-developer-lifecycle-job.jsonl",
        childSessionId: lifecycleJob.childSessionId,
      },
      {
        kind: "lifecycle",
        checkId: "subagent-acceptance-async-status-resume",
        candidateCommit,
        ...lifecycleJob,
        receiptId: lifecycleJob.runId,
        resumeId: lifecycleJob.runId,
      },
    ]);
    put(root, "artifacts/subagent-acceptance/evidence/compact.txt", "compact TUI capture\n");
    put(root, "artifacts/subagent-acceptance/evidence/max.txt", "max badge capture\n");
    writeEvidence(root, "subagent-acceptance", "manual.jsonl", [
      {
        kind: "human-review",
        checkId: "subagent-acceptance-compact-description",
        candidateCommit,
        reviewerType: "human",
        decision: "passed",
        runId: "role-developer",
        captureReference: "artifacts/subagent-acceptance/evidence/compact.txt",
      },
      {
        kind: "human-review",
        checkId: "subagent-acceptance-max-thinking-badge",
        candidateCommit,
        reviewerType: "human",
        decision: "passed",
        maxSupported: true,
        runId: "role-developer",
        captureReference: "artifacts/subagent-acceptance/evidence/max.txt",
      },
    ]);
    const report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.status, "passed");
    assert.equal(report.summary.checks.deterministic.passed, roles.length * 2 + 5);
    assert.equal(report.summary.checks.manual.passed, 2);
    assert.equal(report.summary.checks.manual.pending, 0);
  } finally {
    cleanup(root);
  }
});

test("boolean-only scope, orchestration, fixture, and denied-target claims remain pending", () => {
  const checks = [
    check(
      "architect-independent-function-behavior",
      "artifacts/architect-e2e/evidence/claims.jsonl",
    ),
    check("architect-orchestration-boundary", "artifacts/architect-e2e/evidence/claims.jsonl"),
    check(
      "subagent-acceptance-nonallowlisted-block",
      "artifacts/architect-e2e/evidence/claims.jsonl",
    ),
    check("subagent-acceptance-user-scope", "artifacts/architect-e2e/evidence/claims.jsonl"),
  ];
  const root = setupWorkspace("architect-e2e", checks, {
    dispatchPolicy: { allowedRoles: ["developer"], requiredScope: "user" },
  });
  try {
    writeEvidence(root, "architect-e2e", "claims.jsonl", [
      {
        kind: "fixture-test",
        checkId: "architect-independent-function-behavior",
        candidateCommit,
        fixturePath: "workspace/fixture",
        independent: true,
        exitCode: 0,
        expectedBehaviorChecked: true,
      },
      {
        kind: "orchestration",
        checkId: "architect-orchestration-boundary",
        candidateCommit,
        parentEdited: false,
        childEdited: true,
        dispatchObserved: true,
      },
      {
        kind: "no-launch",
        checkId: "subagent-acceptance-nonallowlisted-block",
        candidateCommit,
        target: "planner",
        blocked: true,
        launchObserved: false,
      },
      {
        kind: "dispatch",
        checkId: "subagent-acceptance-user-scope",
        candidateCommit,
        agent: "developer",
        runId: "claimed-without-job",
        toolCall: {
          id: "claimed-call",
          name: "subagent",
          input: {
            agent: "developer",
            cwd: "workspace/fixture",
            agentScope: "user",
            context: "fresh",
            model: "provider/model:medium",
          },
        },
        resolvedScope: "user",
        childScope: "user",
      },
    ]);
    const report = evaluateAcceptanceWorkspace(root);
    const byId = new Map(report.scenarios[0].checks.map((entry) => [entry.id, entry]));
    for (const id of checks.map((definition) => definition.id)) {
      assert.equal(byId.get(id).status, "pending", id);
    }
    assert.equal(report.status, "pending");
  } finally {
    cleanup(root);
  }
});

test("negative, blocked, assistant-only, unsupported-max, and identity evidence never pass", () => {
  const checks = [
    check(
      "subagent-acceptance-developer-dispatch",
      "artifacts/subagent-acceptance/evidence/evidence.jsonl",
    ),
    check(
      "subagent-acceptance-developer-execution",
      "artifacts/subagent-acceptance/evidence/evidence.jsonl",
    ),
    check(
      "subagent-acceptance-nonallowlisted-block",
      "artifacts/subagent-acceptance/evidence/evidence.jsonl",
    ),
    check(
      "subagent-acceptance-max-thinking-badge",
      "artifacts/subagent-acceptance/evidence/evidence.jsonl",
      { humanReviewRequired: true },
    ),
  ];
  const root = setupWorkspace("subagent-acceptance", checks, {
    dispatchPolicy: { allowedRoles: ["developer"] },
  });
  try {
    parentSessionFile(root, [
      { agent: "developer", callId: "developer-call", entryId: "developer-dispatch" },
    ]);
    const failedJob = makeJob(root, "failed-developer", "developer", {
      state: "failed",
      success: false,
    });
    writeEvidence(root, "subagent-acceptance", "evidence.jsonl", [
      {
        kind: "assistant-claim",
        checkId: "subagent-acceptance-developer-execution",
        candidateCommit,
        claim: "the model says it passed",
      },
      {
        kind: "dispatch",
        checkId: "subagent-acceptance-developer-dispatch",
        candidateCommit,
        agent: "developer",
        runId: failedJob.runId,
        parentSessionPath: "sessions/parent-session.jsonl",
        parentSessionId: "parent-session",
        parentEntryId: "developer-dispatch",
        toolCall: { name: "subagent", id: "developer-call", input: { agent: "developer" } },
        // Deliberately no toolResult: attempted-only evidence is incomplete.
      },
      {
        kind: "job",
        checkId: "subagent-acceptance-developer-execution",
        candidateCommit,
        ...failedJob,
      },
      {
        kind: "no-launch",
        checkId: "subagent-acceptance-nonallowlisted-block",
        candidateCommit,
        target: "planner",
        blocked: false,
        launchObserved: true,
        runId: "unexpected-launch",
      },
      {
        kind: "human-review",
        checkId: "subagent-acceptance-max-thinking-badge",
        candidateCommit,
        reviewerType: "ai",
        decision: "passed",
        runId: failedJob.runId,
        captureReference: "artifacts/subagent-acceptance/evidence/max.txt",
      },
    ]);
    put(root, "artifacts/subagent-acceptance/evidence/max.txt", "capture\n");
    const report = evaluateAcceptanceWorkspace(root);
    const byId = new Map(report.scenarios[0].checks.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("subagent-acceptance-developer-dispatch").status, "pending");
    assert.equal(byId.get("subagent-acceptance-developer-execution").status, "failed");
    assert.equal(byId.get("subagent-acceptance-nonallowlisted-block").status, "failed");
    assert.equal(byId.get("subagent-acceptance-max-thinking-badge").status, "pending");
    assert.equal(report.status, "failed");
  } finally {
    cleanup(root);
  }
});

test("malformed/truncated JSONL, traversal, symlink escapes, and wrong job identity are rejected", () => {
  const checkDefinition = check(
    "architect-independent-function-behavior",
    "artifacts/architect-e2e/evidence/bad.jsonl",
  );
  const root = setupWorkspace("architect-e2e", [checkDefinition]);
  try {
    writeEvidence(
      root,
      "architect-e2e",
      "bad.jsonl",
      [{ kind: "fixture-test", checkId: checkDefinition.id }],
      false,
    );
    assert.throws(() => evaluateAcceptanceWorkspace(root), /truncated/);

    put(
      root,
      "artifacts/architect-e2e/evidence-manifest.json",
      baseManifest("architect-e2e", [check(checkDefinition.id, "../outside.jsonl")]),
    );
    assert.throws(() => evaluateAcceptanceWorkspace(root), /escapes/);

    put(
      root,
      "artifacts/architect-e2e/evidence-manifest.json",
      baseManifest("architect-e2e", [checkDefinition]),
    );
    writeEvidence(root, "architect-e2e", "bad.jsonl", [
      { kind: "fixture-test", checkId: checkDefinition.id },
    ]);
    writeFileSync(join(root, "outside.jsonl"), "{}\n");
    if (process.platform !== "win32") {
      symlinkSync(
        join(root, "outside.jsonl"),
        join(root, "artifacts", "architect-e2e", "evidence", "escape.jsonl"),
      );
      put(
        root,
        "artifacts/architect-e2e/evidence-manifest.json",
        baseManifest("architect-e2e", [
          check(checkDefinition.id, "artifacts/architect-e2e/evidence/escape.jsonl"),
        ]),
      );
      assert.throws(() => evaluateAcceptanceWorkspace(root), /symlink/);
    }

    const job = makeJob(root, "right-job", "developer");
    put(
      root,
      "artifacts/architect-e2e/evidence-manifest.json",
      baseManifest("architect-e2e", [
        check("architect-developer-dispatch", "artifacts/architect-e2e/evidence/job.jsonl"),
      ]),
    );
    writeEvidence(root, "architect-e2e", "job.jsonl", [
      {
        kind: "job",
        checkId: "architect-developer-dispatch",
        candidateCommit,
        ...job,
        runId: "wrong-job",
      },
    ]);
    assert.throws(() => evaluateAcceptanceWorkspace(root), /another job/);

    writeEvidence(root, "architect-e2e", "job.jsonl", [
      {
        kind: "job",
        checkId: "architect-developer-dispatch",
        candidateCommit,
        ...job,
        childSessionId: "wrong-child-session",
      },
    ]);
    assert.throws(() => evaluateAcceptanceWorkspace(root), /child\/session identity/);
  } finally {
    cleanup(root);
  }
});

test("native child projections and diagnostics are accepted without becoming lifecycle proof", () => {
  const checkDefinition = check(
    "subagent-acceptance-developer-dispatch",
    "artifacts/subagent-acceptance/evidence/evidence.jsonl",
  );
  const root = setupWorkspace("subagent-acceptance", [checkDefinition]);
  try {
    const runId = "native-events-job";
    const childSessionId = `child-developer-${runId}`;
    parentSessionFile(root, [
      {
        agent: "developer",
        callId: "developer-call",
        entryId: "developer-dispatch",
        runId,
        childSessionId,
      },
    ]);
    let job = makeJob(root, runId, "developer", {
      nativeEvents: [
        { type: "subagent.control", event: { type: "progress" }, channels: ["parent"] },
        {
          type: "session",
          version: 3,
          id: childSessionId,
          cwd: "/owned/fixture",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "agent_start",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "turn_start",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "message_start",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "tool_execution_update",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "turn_end",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
        {
          type: "agent_end",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
      ],
    });
    writeEvidence(root, "subagent-acceptance", "evidence.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    let report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "passed");

    job = makeJob(root, runId, "developer", {
      nativeEvents: [
        {
          type: "agent_start",
          subagentSource: "child",
          subagentRunId: "different-job",
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
      ],
    });
    writeEvidence(root, "subagent-acceptance", "evidence.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    assert.throws(() => evaluateAcceptanceWorkspace(root), /another job/);

    job = makeJob(root, runId, "developer", {
      nativeEvents: [
        {
          type: "subagent.run.unknown",
          subagentSource: "child",
          subagentRunId: runId,
          subagentStepIndex: 0,
          subagentAgent: "developer",
          observedAt: 1,
        },
      ],
    });
    writeEvidence(root, "subagent-acceptance", "evidence.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    assert.throws(() => evaluateAcceptanceWorkspace(root), /unknown native event type/);

    job = makeJob(root, runId, "developer", {
      nativeEvents: [
        { type: "subagent.control", event: { type: "progress" }, channels: ["parent"] },
        { type: "subagent.events.truncated", ts: 4, maxBytes: 1024 },
      ],
    });
    writeEvidence(root, "subagent-acceptance", "evidence.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "pending");
  } finally {
    cleanup(root);
  }
});

test("requested model text cannot replace missing or fallback execution identity", () => {
  const checkDefinition = check(
    "subagent-acceptance-developer-dispatch",
    "artifacts/subagent-acceptance/evidence/model.jsonl",
  );
  const root = setupWorkspace("subagent-acceptance", [checkDefinition]);
  try {
    const runId = "model-evidence-job";
    const childSessionId = `child-developer-${runId}`;
    parentSessionFile(root, [
      {
        agent: "developer",
        callId: "developer-call",
        entryId: "developer-dispatch",
        runId,
        childSessionId,
        observedModel: false,
      },
    ]);
    let job = makeJob(root, runId, "developer", { observedModel: false });
    writeEvidence(root, "subagent-acceptance", "model.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    let report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "pending");

    const fallbackFields = {
      model: "other/model",
      thinking: "low",
      modelIdentity: { provider: "other", model: "model", thinking: "low" },
      modelResolution: { kind: "fallback", source: "provider-fallback" },
      attemptedModels: ["provider/model", "other/model"],
      modelAttempts: [{ model: "provider/model" }, { model: "other/model" }],
    };
    job = makeJob(root, runId, "developer", {
      observedModel: false,
      resultStep: fallbackFields,
      statusStep: fallbackFields,
    });
    writeEvidence(root, "subagent-acceptance", "model.jsonl", [
      dispatchEvidence({
        checkId: checkDefinition.id,
        agent: "developer",
        runId,
        callId: "developer-call",
        entryId: "developer-dispatch",
        sequence: 1,
        childSessionId,
      }),
      { kind: "job", checkId: checkDefinition.id, candidateCommit, ...job },
    ]);
    report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "failed");
  } finally {
    cleanup(root);
  }
});

test("a new dispatch cannot masquerade as an async same-job resume", () => {
  const checkDefinition = check(
    "subagent-acceptance-async-status-resume",
    "artifacts/subagent-acceptance/evidence/lifecycle.jsonl",
  );
  const root = setupWorkspace("subagent-acceptance", [checkDefinition]);
  try {
    const job = makeJob(root, "async-job", "developer", {
      state: "continued",
      resultState: "continued",
      success: false,
      lifecycle: true,
    });
    writeEvidence(root, "subagent-acceptance", "lifecycle.jsonl", [
      {
        kind: "lifecycle",
        checkId: checkDefinition.id,
        candidateCommit,
        ...job,
        receiptId: job.runId,
        resumeId: "replacement-dispatch",
        newDispatch: true,
      },
    ]);
    const report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "failed");
  } finally {
    cleanup(root);
  }
});

test("active session branches and compaction retained tails are handled without counting abandoned history", () => {
  const checkDefinition = check(
    "architect-developer-dispatch",
    "artifacts/architect-e2e/evidence/branch.jsonl",
  );
  const root = setupWorkspace("architect-e2e", [checkDefinition]);
  try {
    const entries = [
      {
        type: "session",
        version: 3,
        id: "branch-parent",
        timestamp: "2026-09-08T00:00:00.000Z",
        cwd: "/owned",
      },
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-09-08T00:00:01.000Z",
        message: { role: "user", content: "start", timestamp: 1 },
      },
      {
        type: "message",
        id: "abandoned-call",
        parentId: "root",
        timestamp: "2026-09-08T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "abandoned-tool", name: "subagent", arguments: {} }],
          api: "test",
          provider: "test",
          model: "test",
          usage: {},
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "abandoned-result",
        parentId: "abandoned-call",
        timestamp: "2026-09-08T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "abandoned-tool",
          toolName: "subagent",
          content: [],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "active-final",
        parentId: "root",
        timestamp: "2026-09-08T00:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "active" }], timestamp: 4 },
      },
    ];
    put(root, "sessions/branch-parent.jsonl", jsonl(entries));
    writeEvidence(root, "architect-e2e", "branch.jsonl", [
      {
        kind: "dispatch",
        checkId: checkDefinition.id,
        candidateCommit,
        agent: "developer",
        parentSessionPath: "sessions/branch-parent.jsonl",
        parentSessionId: "branch-parent",
        parentEntryId: "abandoned-call",
        toolCallId: "abandoned-tool",
        toolCall: { name: "subagent", id: "abandoned-tool", input: { agent: "developer" } },
        toolResult: { ok: true, runId: "historic" },
        runId: "historic",
      },
    ]);
    let report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "pending");

    const compactionEntries = [
      {
        type: "session",
        version: 3,
        id: "compact-parent",
        timestamp: "2026-09-08T00:00:00.000Z",
        cwd: "/owned",
      },
      {
        type: "message",
        id: "compact-root",
        parentId: null,
        timestamp: "2026-09-08T00:00:01.000Z",
        message: { role: "user", content: "start", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "compact-checkpoint",
        parentId: "compact-root",
        timestamp: "2026-09-08T00:00:02.000Z",
        summary: "retained",
        retainedTail: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "compact-tool", name: "subagent", arguments: {} }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {},
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "compact-tool",
            toolName: "subagent",
            content: [],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      {
        type: "message",
        id: "compact-final",
        parentId: "compact-checkpoint",
        timestamp: "2026-09-08T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4 },
      },
    ];
    put(root, "sessions/compact-parent.jsonl", jsonl(compactionEntries));
    writeEvidence(root, "architect-e2e", "branch.jsonl", [
      {
        kind: "dispatch",
        checkId: checkDefinition.id,
        candidateCommit,
        agent: "developer",
        parentSessionPath: "sessions/compact-parent.jsonl",
        parentSessionId: "compact-parent",
        parentEntryId: "compact-checkpoint",
        toolCallId: "compact-tool",
        toolCall: { name: "subagent", id: "compact-tool", input: { agent: "developer" } },
        toolResult: { ok: true, runId: "compact" },
        runId: "compact",
        childSessionId: "missing-child",
      },
    ]);
    report = evaluateAcceptanceWorkspace(root);
    assert.equal(report.scenarios[0].checks[0].status, "pending");
  } finally {
    cleanup(root);
  }
});
