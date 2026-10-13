import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSubagentSessions, scanSessionFile } from "../scripts/lib/session-analysis.mjs";
import { BACKGROUND_COMPLETION_NUDGE } from "../scripts/lib/subagent-analysis-wakeup.mjs";
import {
  completionBatchMessage,
  messageEntry,
  sessionHeader,
  telemetryEnvelope,
  writeFixture,
} from "./session-analysis-fixtures.mjs";

// ---------------------------------------------------------------------------
// Native (nudge-less) wakeups: the turn-triggering custom message starts the run
// ---------------------------------------------------------------------------

const nativeAssistant = (callId, runId) =>
  messageEntry({
    role: "assistant",
    usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    content: [
      {
        type: "toolCall",
        toolName: "subagent",
        toolCallId: callId,
        arguments: { action: "status", id: runId },
      },
    ],
  });

const FLAGLESS = Symbol("flagless");

// `triggersTurn` is the persisted structured flag: true exactly when the message
// was sent with { triggerTurn: true }. `FLAGLESS` omits the field and models a pre-change transcript.
const nativeCompletion = (runId, triggersTurn = true) =>
  messageEntry({
    role: "custom",
    customType: "subagent-notify",
    content: `Background task completed: ${runId}`,
    details: {
      agent: "native-agent",
      status: "completed",
      asyncId: runId,
      ...(triggersTurn === FLAGLESS ? {} : { triggersTurn }),
    },
  });

const nativeControl = (runId, triggersTurn = true) =>
  messageEntry({
    role: "custom",
    customType: "subagent_control_notice",
    content: "Subagent needs attention",
    details: {
      source: "async",
      ...(triggersTurn === FLAGLESS ? {} : { triggersTurn }),
      event: {
        runId,
        agent: "native-agent",
        type: "needs_attention",
        to: "needs_attention",
        ts: 5,
        reason: "idle",
        message: "needs a look",
      },
    },
  });

// A persisted role:'system' patch entry and an unrelated custom entry may sit
// around the starting message; they are not projected and must be tolerated.
const systemPatch = () =>
  messageEntry({ role: "system", sections: [{ id: "prompt", text: "patched" }] });
const otherCustom = () =>
  messageEntry({ role: "custom", customType: "other-extension", content: "ctx" });

test("subagent analysis: native single completion wake is attributed without a nudge", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-single"),
    messageEntry({ role: "assistant", content: [] }),
    systemPatch(),
    nativeCompletion("native-run"),
    otherCustom(),
    nativeAssistant("native-call", "native-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.assistantUsage?.costUsd, 0.5);
  assert.equal(output.wakeups[0]?.managementCalls.total, 1);
  const wakeups = output.coverage.wakeups;
  assert.equal(wakeups.nativeObserved, 1);
  assert.equal(wakeups.legacyObserved, 0);
  assert.equal(wakeups.attributed, 1);
  assert.equal(wakeups.missingNudge, 0);
  assert.equal(wakeups.unmatchedNudges, 0);
});

test("subagent analysis: native async control notice wake is attributed without a nudge", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-control"),
    nativeControl("native-control-run"),
    nativeAssistant("native-control-call", "native-control-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.kind, "control");
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.coverage.wakeups.nativeObserved, 1);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: native batch final chunk wakes once, tolerating a system patch between chunks", async (t) => {
  const batch = (index, triggersTurn, runId) => ({
    schemaVersion: 1,
    kind: "subagent_completion_batch",
    batchId: "native-batch",
    batchIndex: index,
    batchCount: 2,
    triggersTurn,
    wakeMode: "native",
    completions: [
      {
        agent: "native-agent",
        status: "completed",
        asyncId: runId,
        telemetry: telemetryEnvelope(runId, "async", { index }),
      },
    ],
  });
  const filePath = writeFixture(t, [
    sessionHeader("native-batch"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(batch(0, false, "native-batch-one")),
    systemPatch(),
    completionBatchMessage(batch(1, true, "native-batch-two")),
    nativeAssistant("native-batch-call", "native-batch-two"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.deepEqual(output.wakeups[0]?.runIds?.length, 2);
  assert.equal(output.wakeups[0]?.managementCalls.total, 1);
  assert.equal(output.coverage.wakeups.nativeObserved, 1);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: a batch without triggersTurn never wakes natively", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-batch-steer"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "steer-batch",
      batchIndex: 0,
      batchCount: 1,
      triggersTurn: false,
      wakeMode: "native",
      completions: [
        {
          agent: "native-agent",
          status: "completed",
          asyncId: "steer-batch-run",
          telemetry: telemetryEnvelope("steer-batch-run", "async"),
        },
      ],
    }),
    nativeAssistant("steer-batch-call", "steer-batch-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.observed, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: assistant -> custom(triggersTurn false) -> assistant is a steer, not a wakeup", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-steer"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("steer-run", false),
    nativeControl("steer-control-run", false),
    nativeAssistant("steer-call", "steer-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.observed, 0);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: a lifecycle-flush completion (triggersTurn false) at end of transcript is not a wakeup", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-lifecycle-flush"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("flush-run", false),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.missingAssistantTurn, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: non-boolean triggersTurn values never count as native", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-bad-flag"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("bad-flag-run", "true"),
    nativeAssistant("bad-flag-call", "bad-flag-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
});

test("subagent analysis: a flagless completion followed by human input is still a missing nudge", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-flagless-human"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("flagless-run", FLAGLESS),
    messageEntry({ role: "user", content: "hello" }),
    nativeAssistant("flagless-call", "flagless-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 1);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.interruptedByHumanInput, 0);
});

test("subagent analysis: human input after a native wake source is interrupted-by-human-input", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-interrupted"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("interrupted-run"),
    messageEntry({ role: "user", content: "never mind" }),
    nativeAssistant("interrupted-call", "interrupted-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, false);
  assert.equal(output.wakeups[0]?.reason, "interrupted-by-human-input");
  assert.equal(output.coverage.wakeups.interruptedByHumanInput, 1);
  assert.equal(output.coverage.wakeups.nativeObserved, 1);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: native source at end of transcript is a missing assistant turn", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-eof"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("eof-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups[0]?.reason, "missing-assistant-turn");
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: back-to-back native sources wake once for the last source", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-superseded"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("first-run"),
    nativeCompletion("second-run"),
    nativeAssistant("superseded-call", "second-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.ok(output.wakeups[0]?.runId);
  assert.equal(output.coverage.wakeups.supersededSources, 1);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: legacy nudge shape still counts as a legacy wake", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("legacy-still"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("legacy-run", FLAGLESS),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    nativeAssistant("legacy-call", "legacy-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.coverage.wakeups.legacyObserved, 1);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
});

test("subagent analysis: a steered completion(false) never displaces a pending native completion(true)", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-steer-into-run"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("first-run", true),
    nativeCompletion("steered-run", false),
    nativeAssistant("steer-into-call", "first-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.managementCalls.total, 1);
  const wakeups = output.coverage.wakeups;
  assert.equal(wakeups.nativeObserved, 1);
  assert.equal(wakeups.missingNudge, 0);
  assert.equal(wakeups.supersededSources, 0);
  assert.equal(wakeups.unmatchedNudges, 0);
});

test("subagent analysis: a steered control notice(false) never displaces a pending native notice(true)", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-control-steer-into-run"),
    messageEntry({ role: "assistant", content: [] }),
    nativeControl("first-control-run", true),
    nativeControl("steered-control-run", false),
    nativeAssistant("control-steer-call", "first-control-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.kind, "control");
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.managementCalls.total, 1);
  const wakeups = output.coverage.wakeups;
  assert.equal(wakeups.nativeObserved, 1);
  assert.equal(wakeups.missingNudge, 0);
  assert.equal(wakeups.supersededSources, 0);
});

test("subagent analysis: a malformed legacy-text control notice(false) never displaces a pending native source", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("native-malformed-control-false"),
    messageEntry({ role: "assistant", content: [] }),
    nativeCompletion("first-run", true),
    messageEntry({
      role: "custom",
      customType: "subagent_control_notice",
      content: "Subagent needs attention: legacy text",
      details: { triggersTurn: false, event: { runId: "bad/run", type: "needs_attention" } },
    }),
    nativeAssistant("malformed-control-call", "first-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.kind, "completion");
  assert.equal(output.wakeups[0]?.attributed, true);
  const wakeups = output.coverage.wakeups;
  assert.equal(wakeups.nativeObserved, 1);
  assert.equal(wakeups.missingNudge, 0);
  assert.equal(wakeups.supersededSources, 0);
  assert.equal(output.coverage.evidence.legacyProseNotifications, 1);
  assert.equal(output.coverage.evidence.malformedControlDetails, 1);
});

// Pre-#780 batches persisted `triggersTurn: true` on the final chunk to mean "a
// synthetic nudge follows"; only the `wakeMode: "native"` marker makes it a wake.
const legacyBatch = (batchId, runId, extra = {}) => ({
  schemaVersion: 1,
  kind: "subagent_completion_batch",
  batchId,
  batchIndex: 0,
  batchCount: 1,
  triggersTurn: true,
  completions: [
    {
      agent: "native-agent",
      status: "completed",
      asyncId: runId,
      telemetry: telemetryEnvelope(runId, "async"),
    },
  ],
  ...extra,
});

test("subagent analysis: a markerless batch with triggersTurn true and no nudge is a missing nudge", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("legacy-batch-no-nudge"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(legacyBatch("legacy-batch-a", "legacy-batch-run")),
    messageEntry({ role: "user", content: "human first" }),
    nativeAssistant("legacy-batch-call", "legacy-batch-run"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 1);
});

test("subagent analysis: a markerless batch followed by assistant without a nudge is a missing nudge", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("legacy-batch-assistant"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(legacyBatch("legacy-batch-b", "legacy-batch-run-b")),
    nativeAssistant("legacy-batch-call-b", "legacy-batch-run-b"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 1);
});

test("subagent analysis: a markerless batch -> nudge -> assistant is an unchanged legacy wake", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("legacy-batch-nudge"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(legacyBatch("legacy-batch-c", "legacy-batch-run-c")),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    nativeAssistant("legacy-batch-call-c", "legacy-batch-run-c"),
  ]);
  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.coverage.wakeups.legacyObserved, 1);
  assert.equal(output.coverage.wakeups.nativeObserved, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 0);
});

test("subagent analysis: a marked final chunk with triggersTurn true wakes natively; a non-native marker value does not", async (t) => {
  const native = writeFixture(t, [
    sessionHeader("marked-batch"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(legacyBatch("marked-batch-a", "marked-run", { wakeMode: "native" })),
    nativeAssistant("marked-call", "marked-run"),
  ]);
  const nativeOut = analyzeSubagentSessions([await scanSessionFile(native)]);
  assert.equal(nativeOut.wakeups.length, 1);
  assert.equal(nativeOut.wakeups[0]?.attributed, true);
  assert.equal(nativeOut.coverage.wakeups.nativeObserved, 1);
  assert.equal(nativeOut.coverage.wakeups.missingNudge, 0);

  const other = writeFixture(t, [
    sessionHeader("marked-batch-other"),
    messageEntry({ role: "assistant", content: [] }),
    completionBatchMessage(legacyBatch("marked-batch-b", "other-run", { wakeMode: "other" })),
    nativeAssistant("other-call", "other-run"),
  ]);
  const otherOut = analyzeSubagentSessions([await scanSessionFile(other)]);
  assert.equal(otherOut.wakeups.length, 0);
  assert.equal(otherOut.coverage.wakeups.nativeObserved, 0);
  assert.equal(otherOut.coverage.wakeups.missingNudge, 1);
});
