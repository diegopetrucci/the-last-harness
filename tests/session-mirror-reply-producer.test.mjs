import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionMirrorReplyProducer, SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS } =
  await jiti.import(
    "../extensions/the-last-harness/session-mirror/session-mirror-reply-producer.ts",
  );

const SESSION_ID = "synthetic-session";
const SOURCE_INSTANCE_ID = "a".repeat(32);
const ROOT_ID = "root-entry";
const LEAF_ID = "leaf-entry";
const REPLY_ID = "reply-entry";

function entry(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: text },
  };
}

function createHarness({ text = "reply text", now = () => 0, publishedBranchId = ROOT_ID } = {}) {
  let entries = [entry(ROOT_ID, null, "existing"), entry(LEAF_ID, ROOT_ID, "existing leaf")];
  const observer = {
    enabled: true,
    attestation: "attested",
    status: "idle",
    settled: true,
    dirty: false,
    snapshotRequired: false,
    publicationPending: false,
    sinkInFlight: false,
    successfulPublications: 1,
    generation: 1,
    revision: 7,
  };
  const scheduled = [];
  const timers = [];
  const persistenceChecks = [];
  const sent = [];
  const outcomes = [];
  const channels = [];
  let sendHook = () => {};
  let idle = true;
  let snapshots = 0;
  const manager = {
    getLeafId: () => LEAF_ID,
    getEntries: () => entries,
  };
  const producer = createSessionMirrorReplyProducer({
    enabled: true,
    bridgeDirectory: undefined,
    getSessionManager: () => manager,
    getObserverState: () => observer,
    sendUserMessage: (value) => {
      sent.push(value);
      sendHook(value);
    },
    isIdle: () => idle,
    requestSnapshot: () => {
      snapshots += 1;
    },
    createChannel: (options) => {
      channels.push(options);
      return {
        open: async () => true,
        close: () => options.onClosed?.(),
        getState: () => "open",
      };
    },
    now,
    scheduleConfirmation: (task) => scheduled.push(task),
    setTimeout: (task, delay) => {
      if (delay === 0) persistenceChecks.push(task);
      else timers.push(task);
      return timers.length + persistenceChecks.length;
    },
    clearTimeout: () => {},
    notify: (outcome) => outcomes.push(outcome),
  });
  producer.sessionStart();
  producer.publicationReady({
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 1,
    branchId: publishedBranchId,
    leafId: LEAF_ID,
    sourceRevision: 7,
  });
  assert.equal(channels.length, 1);

  return {
    entries,
    observer,
    scheduled,
    timers,
    persistenceChecks,
    sent,
    outcomes,
    channels,
    producer,
    snapshots: () => snapshots,
    setSendHook(hook) {
      sendHook = hook;
    },
    setIdle(value) {
      idle = value;
    },
    replaceEntries(value) {
      entries = value;
    },
    appendReply() {
      entries = [...entries, entry(REPLY_ID, LEAF_ID, text)];
    },
    request(overrides = {}) {
      return channels[0].onRequest({
        kind: "reply",
        requestId: "request-1",
        generation: 1,
        branchId: publishedBranchId,
        leafId: LEAF_ID,
        sourceRevision: 7,
        ttlSeconds: 30,
        text,
        ...overrides,
      });
    },
  };
}

test("producer accepts only after persisted user-message observation and requests a snapshot", async () => {
  const harness = createHarness();
  const result = harness.request();
  assert.deepEqual(harness.sent, ["reply text"]);
  harness.producer.messageStart({ message: { role: "user", content: "reply text" } });
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.persistenceChecks.length, 1);
  assert.equal(harness.snapshots(), 0);

  harness.appendReply();
  harness.persistenceChecks.shift()();
  assert.equal(await result, "accepted");
  assert.equal(harness.snapshots(), 1);
  assert.equal(harness.channels[0].generation, 1);
  assert.deepEqual(harness.outcomes, ["accepted"]);
  assert.equal(JSON.stringify(harness.producer.getState()).includes("reply text"), false);

  assert.equal(await harness.request(), "duplicate");
  assert.deepEqual(harness.sent, ["reply text"]);
});

test("producer does not cancel its own upstream input event", async () => {
  const harness = createHarness();
  harness.setSendHook((text) => harness.producer.input({ source: "extension", text }));
  const result = harness.request();
  harness.producer.messageStart({ message: { role: "user", content: "reply text" } });
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  harness.appendReply();
  harness.persistenceChecks.shift()();
  assert.equal(await result, "accepted");
  assert.equal(harness.snapshots(), 1);
});

test("producer confirms persistence on the next macrotask before fast-settle publication", async () => {
  const harness = createHarness();
  const result = harness.request();
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  harness.appendReply();
  harness.producer.agentSettled();
  assert.equal(harness.persistenceChecks.length, 1);
  harness.persistenceChecks.shift()();
  assert.equal(await result, "accepted");
  assert.equal(harness.snapshots(), 1);

  harness.observer.revision = 8;
  harness.producer.publicationReady({
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 1,
    branchId: ROOT_ID,
    leafId: LEAF_ID,
    sourceRevision: 8,
  });
  assert.equal(harness.channels.length, 2);
});

test("matching non-extension input invalidates a pending reply and latches busy", async () => {
  const harness = createHarness();
  const result = harness.request();
  harness.producer.input({ source: "interactive", text: "reply text" });
  assert.equal(await result, "unconfirmed");
  assert.equal(harness.producer.getState().busyLatch, true);
  assert.equal(await harness.request({ requestId: "after-input" }), "busy");
  assert.deepEqual(harness.sent, ["reply text"]);
});

test("producer rejects stale, busy, malformed, and non-idle requests before injection", async () => {
  const harness = createHarness();
  assert.equal(await harness.request({ text: "/not-a-command" }), "invalid");

  harness.producer.agentStart();
  assert.equal(await harness.request({ requestId: "busy-request" }), "busy");
  harness.producer.agentSettled();

  harness.observer.revision = 8;
  assert.equal(await harness.request({ requestId: "stale-request" }), "stale");
  assert.deepEqual(harness.sent, []);
});

test("producer returns busy when the live idle seam is false and clears its latch", async () => {
  const harness = createHarness();
  harness.setIdle(false);
  assert.equal(await harness.request(), "busy");
  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.outcomes, []);
  assert.equal(harness.producer.getState().busyLatch, false);
});

test("producer uses the published branch target across bounded root reparenting and long history", async () => {
  const publishedBranchId = "history-100";
  const harness = createHarness({ publishedBranchId });
  const entries = [entry("raw-root", null, "root")];
  let parentId = "raw-root";
  for (let index = 0; index < 1_100; index += 1) {
    const id = `history-${index}`;
    entries.push(entry(id, parentId, "history"));
    parentId = id;
  }
  entries.push(entry(LEAF_ID, parentId, "existing leaf"));
  harness.replaceEntries(entries);

  const result = harness.request();
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  harness.appendReply();
  harness.persistenceChecks.shift()();
  assert.equal(await result, "accepted");
});

test("producer settles missing persistence as bounded unconfirmed and releases busy state", async () => {
  assert.equal(SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS <= 5_000, true);
  const harness = createHarness();
  const result = harness.request();
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.persistenceChecks.length, 1);
  harness.persistenceChecks.shift()();
  assert.equal(harness.producer.getState().inFlight, true);
  harness.scheduled.shift()();
  assert.equal(await result, "unconfirmed");
  assert.equal(harness.producer.getState().busyLatch, false);
  harness.timers[0]();
  assert.equal(harness.producer.getState().lastOutcome, "unconfirmed");
});

test("producer records idempotency before a failed injection", async () => {
  const harness = createHarness();
  let requestHandler;
  const second = createSessionMirrorReplyProducer({
    enabled: true,
    getSessionManager: () => ({
      getLeafId: () => LEAF_ID,
      getEntries: () => [
        entry(ROOT_ID, null, "existing"),
        entry(LEAF_ID, ROOT_ID, "existing leaf"),
      ],
    }),
    getObserverState: () => harness.observer,
    sendUserMessage: () => {
      throw new Error("injection failed");
    },
    isIdle: () => true,
    requestSnapshot: () => {},
    createChannel: (options) => {
      requestHandler = options.onRequest;
      return { open: async () => true, close: () => {}, getState: () => "open" };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  second.sessionStart();
  second.publicationReady({
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 1,
    branchId: ROOT_ID,
    leafId: LEAF_ID,
    sourceRevision: 7,
  });
  const request = {
    kind: "reply",
    requestId: "failed-request",
    generation: 1,
    branchId: ROOT_ID,
    leafId: LEAF_ID,
    sourceRevision: 7,
    ttlSeconds: 1,
    text: "bounded",
  };
  assert.equal(await requestHandler(request), "unconfirmed");
  assert.equal(await requestHandler(request), "duplicate");
});

test("terminal input and compaction invalidate pending replies before confirmation", async () => {
  const harness = createHarness();
  const terminalResult = harness.request();
  harness.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  harness.producer.input({ source: "interactive" });
  assert.equal(await terminalResult, "unconfirmed");
  harness.appendReply();
  for (const task of harness.scheduled) task();
  assert.equal(harness.snapshots(), 0);

  const second = createHarness();
  const compactResult = second.request();
  second.producer.messageEnd({ message: { role: "user", content: "reply text" } });
  second.producer.sessionBeforeCompact();
  assert.equal(await compactResult, "unconfirmed");
  second.appendReply();
  for (const task of second.scheduled) task();
  assert.equal(second.snapshots(), 0);

  second.producer.agentSettled();
  assert.equal(second.producer.getState().compactionLatched, false);
  const afterCancelledCompaction = second.request({ requestId: "after-cancelled-compaction" });
  second.producer.input({ source: "interactive" });
  assert.equal(await afterCancelledCompaction, "unconfirmed");
});

test("producer expiry is bounded and never retries injection", async () => {
  const harness = createHarness();
  const result = harness.request({ ttlSeconds: 1 });
  assert.equal(harness.timers.length, 1);
  harness.timers[0]();
  assert.equal(await result, "expired");
  assert.deepEqual(harness.sent, ["reply text"]);
  assert.equal(harness.timers.length, 1);
});
