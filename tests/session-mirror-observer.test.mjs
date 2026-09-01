import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionMirrorObserverRuntime } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/observer.ts",
);
const { projectSessionMirrorSnapshot } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/session-adapter.ts",
);

const SESSION_FILE = "/synthetic/profile/sessions/session.jsonl";

function makeEnvelope(metadata) {
  return {
    protocol: { family: "session-mirror", major: 1, minor: 0 },
    source: {
      runtimeVersion: metadata.runtimeVersion,
      sessionSchemaVersion: metadata.sessionSchemaVersion,
    },
    sessionId: "synthetic-session",
    capabilities: [
      "session-tree",
      "completed-turns-only",
      "snapshot",
      "cursor-recovery",
      "custom-entries",
      "coarse-status",
    ],
    message: {
      kind: "snapshot",
      eventId: metadata.eventId,
      revision: metadata.revision,
      cursor: metadata.cursor,
      operation: "replace",
      snapshot: {
        snapshotId: metadata.snapshotId,
        status: metadata.status,
        tree: { rootIds: [], activeLeafId: null, entries: [] },
      },
    },
  };
}

function harness(options = {}) {
  const scheduled = [];
  const manager = options.manager ?? {
    getSessionFile: () => SESSION_FILE,
    getSessionId: () => "synthetic-session",
    getLeafId: () => null,
    getEntries: () => [],
  };
  const calls = { attest: 0, project: 0, sink: 0 };
  const published = [];
  const attest = (input) => {
    calls.attest += 1;
    if (options.attest) return options.attest(input);
    return { ok: true, phase: "session-file" };
  };
  const project = (sessionManager, metadata) => {
    calls.project += 1;
    if (options.project) return options.project(sessionManager, metadata);
    return { ok: true, envelope: makeEnvelope(metadata) };
  };
  const sink = (envelope) => {
    calls.sink += 1;
    published.push(envelope);
    return options.sink?.(envelope);
  };
  const scheduler = options.scheduler ?? ((task) => scheduled.push(task));
  const runtime = createSessionMirrorObserverRuntime({
    getSessionManager: () => manager,
    scheduler,
    attest,
    project,
    sink,
    queueCapacity: options.queueCapacity,
  });
  return { calls, manager, published, runtime, scheduled };
}

function runScheduled(harnessState) {
  while (harnessState.scheduled.length > 0) {
    harnessState.scheduled.shift()();
  }
}

test("lifecycle methods synchronously enqueue only bounded marker work", () => {
  const state = harness();
  assert.equal(state.runtime.sessionStart(), undefined);
  assert.equal(state.runtime.agentStart(), undefined);
  assert.equal(state.runtime.messageEnd(), undefined);
  assert.equal(state.runtime.turnEnd(), undefined);
  assert.equal(state.runtime.agentSettled(), undefined);

  assert.deepEqual(state.calls, { attest: 0, project: 0, sink: 0 });
  assert.equal(state.runtime.getState().queueDepth <= state.runtime.getState().queueCapacity, true);
  assert.equal(JSON.stringify(state.runtime.getState()).includes("synthetic"), false);

  runScheduled(state);
  assert.deepEqual(state.calls, { attest: 2, project: 1, sink: 1 });
  assert.equal(state.runtime.getState().sinkInFlight, false);
  assert.equal(state.runtime.getState().dirty, false);
  assert.equal(state.runtime.getState().snapshotRequired, false);
});

test("the real projector publishes only closed placeholders for aborted and error assistants", () => {
  const manager = {
    getSessionFile: () => SESSION_FILE,
    getSessionId: () => "synthetic-session",
    getLeafId: () => "aborted",
    getEntries: () => [
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "synthetic request", timestamp: 1 },
      },
      {
        type: "message",
        id: "error",
        parentId: "user",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "SENTINEL_ERROR_PARTIAL" }],
          stopReason: "error",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "aborted",
        parentId: "error",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "SENTINEL_ABORTED_PARTIAL" }],
          stopReason: "aborted",
          timestamp: 3,
        },
      },
    ],
  };
  const state = harness({ manager, project: projectSessionMirrorSnapshot });
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);

  assert.deepEqual(state.calls, { attest: 2, project: 1, sink: 1 });
  const envelope = state.published[0];
  assert.equal(envelope.message.operation, "replace");
  const entries = envelope.message.snapshot.tree.entries;
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.kind, entry.status, entry.payload]),
    [
      [
        "user",
        "user-turn",
        "completed",
        { content: { format: "text", text: "synthetic request" } },
      ],
      ["error", "source-placeholder", "completed", { sourceType: "unsupported" }],
      ["aborted", "source-placeholder", "completed", { sourceType: "unsupported" }],
    ],
  );
  assert.equal(JSON.stringify(envelope).includes("SENTINEL_ERROR_PARTIAL"), false);
  assert.equal(JSON.stringify(envelope).includes("SENTINEL_ABORTED_PARTIAL"), false);
});

test("an inline scheduler defers all observer work until lifecycle methods return", async () => {
  const state = harness({ scheduler: (task) => task() });
  for (const method of [
    "sessionStart",
    "agentStart",
    "messageEnd",
    "turnEnd",
    "agentSettled",
    "sessionTree",
    "sessionCompact",
    "requestSnapshot",
  ]) {
    assert.equal(state.runtime[method](), undefined);
    assert.deepEqual(state.calls, { attest: 0, project: 0, sink: 0 });
  }
  await Promise.resolve();
  assert.deepEqual(state.calls, { attest: 2, project: 1, sink: 1 });

  const shutdownState = harness({ scheduler: (task) => task() });
  assert.equal(shutdownState.runtime.sessionShutdown(), undefined);
  assert.deepEqual(shutdownState.calls, { attest: 0, project: 0, sink: 0 });
  await Promise.resolve();
  assert.deepEqual(shutdownState.calls, { attest: 0, project: 0, sink: 0 });
});

test("a scheduler failure is fail-open and a later scheduling attempt can publish", () => {
  let scheduleAttempts = 0;
  const state = harness({
    scheduler: (task) => {
      scheduleAttempts += 1;
      if (scheduleAttempts === 1) throw new Error("synthetic scheduler failure");
      state.scheduled.push(task);
    },
  });
  assert.doesNotThrow(() => state.runtime.sessionStart());
  const failed = state.runtime.getState();
  assert.equal(failed.diagnostics.schedulerFailure, 1);
  assert.equal(failed.queueDepth <= failed.queueCapacity, true);
  assert.equal(failed.snapshotRequired, true);

  assert.doesNotThrow(() => state.runtime.agentSettled());
  runScheduled(state);
  assert.equal(scheduleAttempts, 2);
  assert.deepEqual(state.calls, { attest: 2, project: 1, sink: 1 });
});

test("directory-only attestation waits for a concrete session file before publishing", () => {
  let phase = "directory-only";
  const state = harness({
    attest: () => ({ ok: true, phase }),
  });
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);

  assert.deepEqual(state.calls, { attest: 2, project: 0, sink: 0 });
  assert.equal(state.runtime.getState().attestation, "directory-only");
  assert.equal(state.runtime.getState().diagnostics.attestationNotReady, 1);

  phase = "session-file";
  state.runtime.requestSnapshot();
  runScheduled(state);
  assert.deepEqual(state.calls, { attest: 3, project: 1, sink: 1 });
  assert.equal(state.published[0].message.operation, "replace");
});

test("a never-settling sink never blocks lifecycle calls or permits a second operation", () => {
  let resolveSink;
  const pending = new Promise((resolve) => {
    resolveSink = resolve;
  });
  const state = harness({ sink: () => pending });

  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);
  assert.equal(state.calls.sink, 1);
  assert.equal(state.runtime.getState().sinkInFlight, true);

  assert.doesNotThrow(() => {
    state.runtime.messageEnd();
    state.runtime.agentSettled();
    state.runtime.requestSnapshot();
    state.runtime.sessionShutdown();
  });
  assert.equal(state.runtime.getState().queueDepth, 0);
  assert.equal(state.runtime.getState().sinkInFlight, true);

  resolveSink();
  return pending.then(() => {
    runScheduled(state);
    assert.equal(state.calls.sink, 1);
    assert.equal(state.runtime.getState().attestation, "shutdown");
  });
});

test("queue overflow becomes one replacement request and publishes after settlement", () => {
  const state = harness({ queueCapacity: 2 });
  state.runtime.sessionStart();
  state.runtime.agentStart();
  state.runtime.messageEnd();

  const before = state.runtime.getState();
  assert.equal(before.queueDepth, 1);
  assert.equal(before.snapshotRequired, true);
  assert.equal(before.diagnostics.queueOverflow, 1);
  assert.equal(before.droppedMarkers > 0, true);

  state.runtime.agentSettled();
  runScheduled(state);
  assert.equal(state.calls.sink, 1);
  assert.equal(state.runtime.getState().snapshotRequired, false);
});

test("attestation failures disable only the current generation and never call projection", () => {
  const state = harness({
    attest: () => ({ ok: false, reason: "profile-mismatch" }),
  });
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);

  const current = state.runtime.getState();
  assert.equal(current.enabled, false);
  assert.equal(current.attestation, "disabled");
  assert.equal(current.lastAttestationFailure, "profile-mismatch");
  assert.equal(current.diagnostics.attestationFailure, 1);
  assert.equal(state.calls.project, 0);
  assert.equal(state.calls.sink, 0);
});

test("throwing and rejecting sinks fail open and retry only after a later marker", async () => {
  let attempts = 0;
  const throwing = harness({
    sink: () => {
      attempts += 1;
      throw new Error("synthetic sink failure");
    },
  });
  throwing.runtime.sessionStart();
  throwing.runtime.agentSettled();
  runScheduled(throwing);
  assert.equal(attempts, 1);
  assert.equal(throwing.runtime.getState().diagnostics.sinkThrow, 1);
  assert.equal(throwing.runtime.getState().snapshotRequired, true);

  throwing.runtime.requestSnapshot();
  runScheduled(throwing);
  assert.equal(attempts, 2);

  let reject;
  const rejection = new Promise((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const rejecting = harness({ sink: () => rejection });
  rejecting.runtime.sessionStart();
  rejecting.runtime.agentSettled();
  runScheduled(rejecting);
  assert.equal(rejecting.runtime.getState().sinkInFlight, true);
  reject(new Error("synthetic rejection"));
  await rejection.catch(() => undefined);
  assert.equal(rejecting.runtime.getState().diagnostics.sinkReject, 1);
  assert.equal(rejecting.runtime.getState().snapshotRequired, true);
});

test("direct sessionStart replacement drops queued work before stale sink completion", async () => {
  let resolveSink;
  const pending = new Promise((resolve) => {
    resolveSink = resolve;
  });
  let sinkCalls = 0;
  const state = harness({
    sink: () => {
      sinkCalls += 1;
      return sinkCalls === 1 ? pending : undefined;
    },
  });
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);
  assert.equal(sinkCalls, 1);

  state.runtime.messageEnd();
  const oldGeneration = state.runtime.getState().generation;
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  assert.notEqual(state.runtime.getState().generation, oldGeneration);
  assert.equal(state.runtime.getState().queueDepth, 2);
  resolveSink();
  await pending;
  runScheduled(state);

  assert.equal(sinkCalls, 2);
  assert.equal(state.published.length, 2);
  assert.notEqual(state.published[0].message.eventId, state.published[1].message.eventId);
  assert.equal(state.runtime.getState().successfulPublications, 1);
  assert.equal(state.runtime.getState().diagnostics.staleGeneration > 0, true);
});

test("an invalidated never-settling sink remains the global in-flight operation", async () => {
  let resolveSink;
  const pending = new Promise((resolve) => {
    resolveSink = resolve;
  });
  let sinkCalls = 0;
  const state = harness({
    sink: () => {
      sinkCalls += 1;
      return sinkCalls === 1 ? pending : undefined;
    },
  });
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);
  assert.equal(sinkCalls, 1);
  assert.equal(state.runtime.getState().sinkInFlight, true);

  state.runtime.sessionShutdown();
  state.runtime.sessionStart();
  state.runtime.agentSettled();
  runScheduled(state);
  for (let index = 0; index < 12; index += 1) {
    state.runtime.sessionStart();
    state.runtime.agentSettled();
    runScheduled(state);
  }

  const blocked = state.runtime.getState();
  assert.equal(sinkCalls, 1);
  assert.equal(blocked.sinkInFlight, true);
  assert.equal(blocked.publicationPending, true);
  assert.equal(blocked.queueDepth > 0, true);
  assert.equal(blocked.queueDepth <= blocked.queueCapacity, true);
  const newestGeneration = blocked.generation;

  resolveSink();
  await pending;
  runScheduled(state);
  assert.equal(sinkCalls, 2);
  assert.equal(state.published[1].message.eventId.startsWith(`g${newestGeneration}-`), true);
  assert.equal(state.runtime.getState().successfulPublications, 1);
  assert.equal(state.runtime.getState().sinkInFlight, false);
});

test("marker coalescing and the dormant API have no message update hook", () => {
  const state = harness();
  state.runtime.sessionStart();
  state.runtime.messageEnd();
  state.runtime.turnEnd();
  state.runtime.messageEnd();
  const current = state.runtime.getState();
  assert.equal(current.coalescedMarkers >= 2, true);
  assert.equal("message_update" in state.runtime, false);
  assert.equal("messageUpdate" in state.runtime, false);
});

test("tree/compaction and explicit requests force replacement snapshots without retaining event data", () => {
  const state = harness();
  state.runtime.sessionStart();
  state.runtime.sessionTree();
  state.runtime.sessionCompact();
  state.runtime.requestSnapshot();

  assert.equal(state.runtime.getState().queueDepth <= 2, true);
  assert.equal(JSON.stringify(state.runtime.getState()).includes("session.jsonl"), false);
  runScheduled(state);
  assert.equal(state.calls.sink, 1);
  assert.equal(state.runtime.getState().successfulPublications, 1);
});
