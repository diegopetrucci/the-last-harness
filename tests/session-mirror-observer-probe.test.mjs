import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SESSION_MIRROR_OBSERVER_PROBE_BOUNDS,
  SESSION_MIRROR_OBSERVER_TIMING_BUCKETS,
  createSessionMirrorObserverProbe,
} = await jiti.import("../extensions/the-last-harness/session-mirror-observer-probe.ts");
const { projectSessionMirrorSnapshot } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/session-adapter.ts",
);

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-session-mirror-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sessionFile: join(root, "synthetic-session.jsonl") };
}

function manager(fixture, entries) {
  return {
    getSessionFile: () => fixture.sessionFile,
    getSessionId: () => "synthetic-session",
    getLeafId: () => entries.at(-1)?.id ?? null,
    getEntries: () => entries,
  };
}

function entry(id, parentId, message) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}

function user(text) {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "synthetic-provider",
    model: "synthetic-model",
    stopReason,
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function drain(scheduled) {
  while (scheduled.length > 0) scheduled.shift()();
}

function attested() {
  return { ok: true, phase: "session-file" };
}

test("probe converts production envelopes into bounded aggregate metrics without retaining private content", (t) => {
  const fixture = makeFixture(t);
  const entries = [
    entry("root", null, user("SENTINEL_PRIVATE_USER")),
    entry("assistant", "root", assistant("SENTINEL_PRIVATE_ASSISTANT")),
    entry("tool", "assistant", assistant("SENTINEL_PRIVATE_TOOL", "toolUse")),
  ];
  const scheduled = [];
  const probe = createSessionMirrorObserverProbe({
    getSessionManager: () => manager(fixture, entries),
    attest: attested,
    project: projectSessionMirrorSnapshot,
    scheduler: (task) => scheduled.push(task),
    now: (() => {
      let tick = 0;
      return () => {
        tick += 1;
        return tick;
      };
    })(),
  });

  probe.sessionStart();
  probe.agentSettled();
  assert.equal(scheduled.length > 0, true);
  drain(scheduled);

  const state = probe.getState();
  assert.equal(state.envelopeCategory, "mixed");
  assert.equal(state.entryCount, 3);
  assert.equal(state.rootCount, 1);
  assert.equal(state.maxDepth, 3);
  assert.equal(state.envelopeBytes > 0, true);
  assert.equal(state.envelopeBytes <= SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxEnvelopeBytes, true);
  assert.equal(SESSION_MIRROR_OBSERVER_TIMING_BUCKETS.includes(state.timing.attestation), true);
  assert.equal(SESSION_MIRROR_OBSERVER_TIMING_BUCKETS.includes(state.timing.projection), true);
  assert.equal(SESSION_MIRROR_OBSERVER_TIMING_BUCKETS.includes(state.timing.sink), true);
  assert.doesNotMatch(JSON.stringify(state), /SENTINEL_PRIVATE/);
  assert.equal("envelope" in state, false);
});

test("probe lifecycle methods are nonthrowing around attestation and projection failures", (t) => {
  const fixture = makeFixture(t);
  const scheduled = [];
  const throwingAttestor = createSessionMirrorObserverProbe({
    getSessionManager: () => manager(fixture, []),
    attest: () => {
      throw new Error("SENTINEL_ATTESTATION");
    },
    scheduler: (task) => scheduled.push(task),
  });
  assert.doesNotThrow(() => {
    throwingAttestor.sessionStart();
    throwingAttestor.agentSettled();
    throwingAttestor.requestSnapshot();
    drain(scheduled);
  });
  assert.equal(throwingAttestor.getState().enabled, false);
  assert.doesNotMatch(JSON.stringify(throwingAttestor.getState()), /SENTINEL/);

  const projectionScheduled = [];
  const throwingProjector = createSessionMirrorObserverProbe({
    getSessionManager: () => manager(fixture, []),
    attest: attested,
    project: () => {
      throw new Error("SENTINEL_PROJECTION");
    },
    scheduler: (task) => projectionScheduled.push(task),
  });
  assert.doesNotThrow(() => {
    throwingProjector.sessionStart();
    throwingProjector.agentSettled();
    drain(projectionScheduled);
  });
  const projectionState = throwingProjector.getState();
  assert.equal(projectionState.envelopeCategory, "error");
  assert.equal(projectionState.diagnostics.projectionFailure, 1);
  assert.doesNotMatch(JSON.stringify(projectionState), /SENTINEL/);
});

test("probe sink measurement errors are bounded and nonthrowing", (t) => {
  const fixture = makeFixture(t);
  const scheduled = [];
  const projected = projectSessionMirrorSnapshot(manager(fixture, []), {
    eventId: "event",
    revision: 1,
    cursor: "cursor",
    snapshotId: "snapshot",
    runtimeVersion: "runtime",
    sessionSchemaVersion: "schema",
    status: "idle",
  });
  assert.equal(projected.ok, true);
  const hostileEnvelope = new Proxy(projected.envelope, {
    get(target, property) {
      if (property === "message") throw new Error("SENTINEL_SINK");
      return target[property];
    },
  });
  const probe = createSessionMirrorObserverProbe({
    getSessionManager: () => manager(fixture, []),
    attest: attested,
    project: () => ({ ok: true, envelope: hostileEnvelope }),
    scheduler: (task) => scheduled.push(task),
  });
  assert.doesNotThrow(() => {
    probe.sessionStart();
    probe.agentSettled();
    drain(scheduled);
  });
  const state = probe.getState();
  assert.equal(state.envelopeCategory, "error");
  assert.equal(state.diagnostics.sinkThrow, 1);
  assert.equal(state.snapshotRequired, true);
  assert.doesNotMatch(JSON.stringify(state), /SENTINEL/);
});

test("probe request and shutdown remain deferred and invalidate pending state", (t) => {
  const fixture = makeFixture(t);
  const scheduled = [];
  const probe = createSessionMirrorObserverProbe({
    getSessionManager: () => manager(fixture, []),
    attest: attested,
    scheduler: (task) => scheduled.push(task),
  });
  probe.sessionStart();
  const beforeRequest = scheduled.length;
  assert.doesNotThrow(() => probe.requestSnapshot());
  assert.equal(scheduled.length, beforeRequest, "coalesced work remains scheduler-deferred");
  assert.doesNotThrow(() => probe.sessionShutdown());
  const state = probe.getState();
  assert.equal(state.attestation, "shutdown");
  assert.equal(state.enabled, false);
  assert.equal(state.queueDepth, 0);
  assert.equal(state.envelopeCategory, "none");
});

test("generated native-lazy probe and observer files contain no runtime peer import", async () => {
  const { readFileSync } = await import("node:fs");
  const probeSource = readFileSync(
    new URL("../extensions/the-last-harness/session-mirror-observer-probe.js", import.meta.url),
    "utf8",
  );
  const observerSource = readFileSync(
    new URL("../extensions/the-last-harness/session-mirror/observer.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(probeSource, /@earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(observerSource, /@earendil-works\/pi-coding-agent/);
});
