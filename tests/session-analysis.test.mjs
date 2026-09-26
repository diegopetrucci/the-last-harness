import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateCoverage,
  analyzeSubagentSessions,
  extractSubagentCorrelations,
  extractSubagentCorrelationsWithStatus,
  readSessionHeader,
  recordCorrelationEvidenceFailures,
  scanSessionFile,
} from "../scripts/lib/session-analysis.mjs";
import { makeTempDir } from "./test-fixture-helpers.mjs";

import {
  assistantMessageLine,
  sessionHeader,
  toolResultLine,
  writeFixture,
} from "./session-analysis-fixtures.mjs";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("subagent analysis uses an acyclic shared coverage boundary", () => {
  const sessionAnalysis = readFileSync(
    new URL("../scripts/lib/session-analysis.mjs", import.meta.url),
    "utf8",
  );
  const subagentAnalysis = readFileSync(
    new URL("../scripts/lib/subagent-analysis.mjs", import.meta.url),
    "utf8",
  );
  assert.match(subagentAnalysis, /from ["']\.\/session-analysis-coverage\.mjs["']/);
  assert.doesNotMatch(subagentAnalysis, /from ["']\.\/session-analysis\.mjs["']/);
  assert.match(sessionAnalysis, /from ["']\.\/subagent-analysis\.mjs["']/);
});

test("scanSessionFile: parses session header and a simple tool call pair", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-1", toolName: "bash" }]),
    toolResultLine("2026-01-01T00:00:02.000Z", "tc-1"),
  ]);

  const result = await scanSessionFile(filePath);

  assert.equal(result.sessionHeader?.id, "sess-001");
  assert.equal(result.sessionHeader?.cwd, "/workspace");
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.toolPairs[0]?.toolCallId, "tc-1");
  assert.equal(result.toolPairs[0]?.toolName, "bash");
  assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
  assert.equal(result.toolPairs[0]?.isError, false);
  assert.equal(result.malformedLines, 0);
  assert.equal(result.unmatchedToolCallCount, 0);
  assert.equal(result.unmatchedToolResultCount, 0);
  assert.equal(result.observedToolCallCount, 1);
  assert.equal(result.duplicateToolCallIdCount, 0);
  assert.equal(result.invalidTimestampPairCount, 0);
});

test("scanSessionFile: accepts persisted Pi tool fields and top-level custom messages", async (t) => {
  const compositeId = "call_provider_123|fc_provider_123";
  const filePath = writeFixture(t, [
    sessionHeader("persisted-shape"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        // Pi persists this message timestamp as epoch milliseconds.
        timestamp: 1767225600000,
        content: [{ type: "toolCall", id: compositeId, name: "subagent", arguments: {} }],
      },
      // The outer persisted envelope retains the usable ISO timestamp.
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: compositeId,
        toolName: "subagent",
        isError: false,
        content: [],
        details: { runId: "run-persisted", status: "completed", agent: "developer" },
        timestamp: 1767225601000,
      },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    JSON.stringify({
      type: "custom_message",
      customType: "subagent-notify",
      content: "Background task completed: developer",
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
    JSON.stringify({
      type: "custom_message",
      customType: "subagent-notify",
      content: "Background tasks completed: developer",
      details: {
        schemaVersion: 1,
        kind: "subagent_completion_batch",
        batchId: "batch-persisted|opaque",
        batchIndex: 0,
        batchCount: 1,
        triggersTurn: true,
        completions: [
          { agent: "developer", status: "completed", asyncId: "async-persisted|opaque" },
        ],
      },
      timestamp: "2026-01-01T00:00:02.500Z",
    }),
    JSON.stringify({
      type: "custom_message",
      customType: "subagent_control_notice",
      content: "Subagent needs attention: developer",
      details: {
        source: "async",
        event: {
          type: "needs_attention",
          to: "needs_attention",
          ts: 1767225602000,
          runId: "run-persisted-control|opaque",
          agent: "developer",
          index: 0,
          message: "attention",
          reason: "idle",
        },
      },
      timestamp: "2026-01-01T00:00:03.000Z",
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.toolPairs[0]?.toolCallId, compositeId);
  assert.equal(result.toolPairs[0]?.callTimestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(result.toolPairs[0]?.resultTimestamp, "2026-01-01T00:00:01.000Z");
  assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
  assert.equal(result.entries.filter((entry) => entry.message.customType).length, 3);

  const analysis = analyzeSubagentSessions([result]);
  assert.equal(analysis.coverage.evidence.completionNotifications, 2);
  assert.equal(analysis.coverage.evidence.controlNotifications, 1);
  assert.equal(analysis.coverage.evidence.legacyProseNotifications, 1);
  assert.equal(analysis.coverage.evidence.completionBatchesObserved, 1);
  assert.equal(analysis.coverage.evidence.completionBatchesComplete, 1);
});

test("subagent analysis: classifies malformed persisted calls as one unclassified operation", async (t) => {
  const compositeId = "call_provider_malformed|fc_provider_malformed";
  const filePath = writeFixture(t, [
    sessionHeader("persisted-malformed-call"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        // Pi persists provider tool calls with id/name and may retain malformed
        // serialized arguments from a failed tool invocation.
        timestamp: 1767225600000,
        content: [
          {
            type: "toolCall",
            id: compositeId,
            name: "subagent",
            arguments: '{"agent":',
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", compositeId, "subagent"),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.equal(scan.toolPairs.length, 1);
  assert.ok(scan.projectionGapCount > 0);

  const analysis = analyzeSubagentSessions([scan]);
  assert.equal(analysis.operations.malformedArguments, 1);
  assert.equal(analysis.operations.unclassified, 1);
  assert.equal(analysis.operations.launches.total, 0);
  assert.equal(analysis.operations.management.total, 0);
});

test("scanSessionFile: accepts management-mode subagent details without a projection gap", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("management-mode"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "management-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "management-call", "subagent", {
      details: { mode: "management", results: [] },
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.projectionGapCount, 0);
  assert.deepEqual(result.toolPairs[0]?.details, { mode: "management", results: [] });

  const runFilePath = writeFixture(t, [
    sessionHeader("management-run"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "management-run-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "management-run-call", "subagent", {
      details: { runId: "management-run-id", mode: "management", results: [] },
    }),
  ]);
  const analysis = analyzeSubagentSessions([await scanSessionFile(runFilePath)]);
  assert.equal(analysis.runs[0]?.mode, "management");

  const legacyChainLines = [sessionHeader("legacy-chain-gaps")];
  for (let index = 0; index < 5; index++) {
    const toolCallId = `legacy-chain-${index}`;
    legacyChainLines.push(
      assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId, toolName: "subagent" }]),
      toolResultLine("2026-01-01T00:00:01.000Z", toolCallId, "subagent", {
        details: { mode: "chain", results: [] },
      }),
    );
  }
  const legacyChain = await scanSessionFile(writeFixture(t, legacyChainLines));
  assert.equal(legacyChain.projectionGapCount, 5);
});

test("scanSessionFile: exposes malformed persisted subagent evidence as projection gaps", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("projection-gaps"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: [{ type: "toolCall", id: { malformed: true }, name: "subagent" }],
      },
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.ok(result.projectionGapCount > 0);
  assert.ok(analyzeSubagentSessions([result]).coverage.totalProjectionGaps > 0);
});

test("scanSessionFile: ignores malformed non-subagent display metadata in projection gaps", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("projection-gap-display"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: [{ type: "toolCall", id: { malformed: true }, name: "bash" }],
      },
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.projectionGapCount, 0);
  assert.equal(analyzeSubagentSessions([result]).coverage.totalProjectionGaps, 0);
});

test("scanSessionFile: skips and counts malformed lines without throwing", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    "this is not json {{{",
    assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-2", toolName: "bash" }]),
    "   ",
    "{broken json",
    toolResultLine("2026-01-01T00:00:03.000Z", "tc-2"),
  ]);

  const result = await scanSessionFile(filePath);

  // Two lines with invalid JSON should be counted
  assert.equal(result.malformedLines, 2);
  // The valid pair should still be resolved
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.toolPairs[0]?.toolCallId, "tc-2");
  assert.equal(result.toolPairs[0]?.observedLatencyMs, 2000);
});

test("scanSessionFile: tolerates unterminated final line (no trailing newline)", async (t) => {
  const filePath = writeFixture(
    t,
    [
      sessionHeader(),
      assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-3", toolName: "bash" }]),
      // Last line has no newline — simulates live append
      toolResultLine("2026-01-01T00:00:02.500Z", "tc-3"),
    ],
    { noTrailingNewline: true },
  );

  const result = await scanSessionFile(filePath);

  assert.equal(result.malformedLines, 0);
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.toolPairs[0]?.observedLatencyMs, 1500);
});

test("scanSessionFile: pairs multiple parallel tool calls in one assistant message by toolCallId", async (t) => {
  // One assistant message with three simultaneous tool calls, results arrive
  // in reverse order to confirm adjacency is not used for pairing.
  const filePath = writeFixture(t, [
    sessionHeader(),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-a", toolName: "bash" },
      { toolCallId: "tc-b", toolName: "read" },
      { toolCallId: "tc-c", toolName: "write" },
    ]),
    // Results in reverse order to prove adjacency is not used
    toolResultLine("2026-01-01T00:00:03.000Z", "tc-c", "write"),
    toolResultLine("2026-01-01T00:00:02.000Z", "tc-b", "read"),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-a", "bash"),
  ]);

  const result = await scanSessionFile(filePath);

  assert.equal(result.toolPairs.length, 3);
  assert.equal(result.unmatchedToolCallCount, 0);
  assert.equal(result.unmatchedToolResultCount, 0);
  assert.equal(result.observedToolCallCount, 3);

  const byId = Object.fromEntries(result.toolPairs.map((p) => [p.toolCallId, p]));

  assert.equal(byId["tc-a"]?.toolName, "bash");
  assert.equal(byId["tc-a"]?.observedLatencyMs, 1000);

  assert.equal(byId["tc-b"]?.toolName, "read");
  assert.equal(byId["tc-b"]?.observedLatencyMs, 2000);

  assert.equal(byId["tc-c"]?.toolName, "write");
  assert.equal(byId["tc-c"]?.observedLatencyMs, 3000);
});

test("scanSessionFile: counts unmatched tool calls and tool results separately", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    // Tool call with no result
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-orphan-call", toolName: "bash" },
    ]),
    // Tool result with no matching call
    toolResultLine("2026-01-01T00:00:05.000Z", "tc-orphan-result", "bash"),
  ]);

  const result = await scanSessionFile(filePath);

  assert.equal(result.toolPairs.length, 0);
  assert.equal(result.unmatchedToolCallCount, 1);
  assert.equal(result.unmatchedToolResultCount, 1);
  // Fix 4: observedToolCallCount counts the call even though it is unmatched.
  assert.equal(result.observedToolCallCount, 1);
});

// ---------------------------------------------------------------------------
// Fix 1: run-history.jsonl guard
// ---------------------------------------------------------------------------

test("scanSessionFile: rejects run-history.jsonl path", async (t) => {
  const dir = makeTempDir("session-analysis-rh-", t);
  const rhPath = join(dir, "run-history.jsonl");
  writeFileSync(rhPath, '{"type":"session"}\n', "utf8");

  await assert.rejects(
    () => scanSessionFile(rhPath),
    (err) => {
      assert.ok(err instanceof Error, "must throw an Error");
      assert.ok(
        err.message.includes("run-history.jsonl"),
        `error message must mention run-history.jsonl; got: ${err.message}`,
      );
      return true;
    },
  );
});

test("scanSessionFile: rejects run-history.jsonl via symlink", async (t) => {
  const dir = makeTempDir("session-analysis-rh-sym-", t);
  const rhPath = join(dir, "run-history.jsonl");
  const linkPath = join(dir, "alias.jsonl");
  writeFileSync(rhPath, '{"type":"session"}\n', "utf8");
  symlinkSync(rhPath, linkPath);

  await assert.rejects(
    () => scanSessionFile(linkPath),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("run-history.jsonl"));
      return true;
    },
  );
});

test("readSessionHeader: rejects run-history.jsonl path", async (t) => {
  const dir = makeTempDir("session-analysis-rh-hdr-", t);
  const rhPath = join(dir, "run-history.jsonl");
  writeFileSync(rhPath, '{"type":"session"}\n', "utf8");

  await assert.rejects(
    () => readSessionHeader(rhPath),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("run-history.jsonl"));
      return true;
    },
  );
});

test("readSessionHeader: rejects run-history.jsonl via symlink", async (t) => {
  const dir = makeTempDir("session-analysis-rh-hdr-sym-", t);
  const rhPath = join(dir, "run-history.jsonl");
  const linkPath = join(dir, "alias.jsonl");
  writeFileSync(rhPath, '{"type":"session"}\n', "utf8");
  symlinkSync(rhPath, linkPath);

  await assert.rejects(
    () => readSessionHeader(linkPath),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("run-history.jsonl"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Fix 2: extractSubagentCorrelations — subagent-only, child resolution
// ---------------------------------------------------------------------------

test("extractSubagentCorrelations: resolves parent -> child correlation from subagent tool result", async (t) => {
  const childSessionFile =
    "/home/user/.the-last-harness/agent/sessions/proj/parent-sess/run-1/run-1/session.jsonl";

  const filePath = writeFixture(t, [
    sessionHeader("parent-sess-id"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-sub", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:10.000Z", "tc-sub", "subagent", {
      details: {
        runId: "run-abc123",
        results: [{ agent: "code-agent", sessionFile: childSessionFile }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.equal(scan.toolPairs.length, 1);
  assert.equal(scan.toolPairs[0]?.observedLatencyMs, 10000);

  const correlations = await extractSubagentCorrelations(scan);
  assert.equal(correlations.length, 1);

  const c = correlations[0];
  assert.equal(c?.parentSessionId, "parent-sess-id");
  assert.equal(c?.toolCallId, "tc-sub");
  assert.equal(c?.runId, "run-abc123");
  assert.equal(c?.agent, "code-agent");
  assert.equal(c?.childSessionFile, childSessionFile);
});

test("extractSubagentCorrelations: only extracts from subagent tool calls, not other tools", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("parent-filter"),
    // bash tool with subagent-like details — must NOT produce a correlation
    assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-bash", toolName: "bash" }]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-bash", "bash", {
      details: {
        runId: "run-fake",
        results: [{ agent: "impostor", sessionFile: "/sessions/fake/session.jsonl" }],
      },
    }),
    // subagent tool — MUST produce a correlation
    assistantMessageLine("2026-01-01T00:00:02.000Z", [
      { toolCallId: "tc-sub", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:03.000Z", "tc-sub", "subagent", {
      details: {
        runId: "run-real",
        results: [{ agent: "real-agent", sessionFile: "/sessions/real/session.jsonl" }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const correlations = await extractSubagentCorrelations(scan);
  assert.equal(correlations.length, 1, "must only produce correlation from subagent tool");
  assert.equal(correlations[0]?.runId, "run-real");
});

test("extractSubagentCorrelations: emits one correlation per child sessionFile in results array", async (t) => {
  const childA = "/sessions/child-a/session.jsonl";
  const childB = "/sessions/child-b/session.jsonl";

  const filePath = writeFixture(t, [
    sessionHeader("parent-multi"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-multi", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:05.000Z", "tc-multi", "subagent", {
      details: {
        runId: "run-multi",
        results: [
          { agent: "agent-a", sessionFile: childA },
          { agent: "agent-b", sessionFile: childB },
        ],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const correlations = await extractSubagentCorrelations(scan);
  assert.equal(correlations.length, 2);
  assert.deepEqual(correlations.map((c) => c.childSessionFile).sort(), [childA, childB].sort());
});

test("extractSubagentCorrelations: ignores tool-call IDs added after the scan snapshot", async (t) => {
  const originalChild = "/sessions/original/session.jsonl";
  const addedChild = "/sessions/added/session.jsonl";
  const originalLines = [
    sessionHeader("parent-snapshot"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-original", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-original", "subagent", {
      details: {
        runId: "run-original",
        results: [{ agent: "original-agent", sessionFile: originalChild }],
      },
    }),
  ];
  const filePath = writeFixture(t, originalLines);
  const scan = await scanSessionFile(filePath);
  assert.deepEqual(
    scan.toolPairs.filter((pair) => pair.toolName === "subagent").map((pair) => pair.toolCallId),
    ["tc-original"],
  );

  // Replace the file after the streaming snapshot with a newer generation
  // containing an additional, otherwise valid subagent correlation.
  writeFileSync(
    filePath,
    [
      ...originalLines,
      assistantMessageLine("2026-01-01T00:00:02.000Z", [
        { toolCallId: "tc-added", toolName: "subagent" },
      ]),
      toolResultLine("2026-01-01T00:00:03.000Z", "tc-added", "subagent", {
        details: {
          runId: "run-added",
          results: [{ agent: "added-agent", sessionFile: addedChild }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const correlations = await extractSubagentCorrelations(scan);
  assert.equal(correlations.length, 1, "newer tool-call IDs must not be correlated");
  assert.equal(correlations[0]?.toolCallId, "tc-original");
  assert.equal(correlations[0]?.runId, "run-original");
});

test("extractSubagentCorrelations: rejects correlation evidence after a digest mismatch", async (t) => {
  const originalChild = "/sessions/original-generation/session.jsonl";
  const replacementChild = "/sessions/replaced-generation/session.jsonl";
  const originalLines = [
    sessionHeader("parent-generation"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-generation", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-generation", "subagent", {
      details: {
        runId: "run-original-generation",
        results: [{ agent: "original-agent", sessionFile: originalChild }],
      },
    }),
  ];
  const filePath = writeFixture(t, originalLines);
  const scan = await scanSessionFile(filePath);
  assert.match(scan.correlationEvidenceDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(scan.correlationEvidenceGeneration, 2);

  writeFileSync(
    filePath,
    [
      sessionHeader("parent-generation"),
      assistantMessageLine("2026-01-01T00:00:00.000Z", [
        { toolCallId: "tc-generation", toolName: "subagent" },
      ]),
      toolResultLine("2026-01-01T00:00:01.000Z", "tc-generation", "subagent", {
        details: {
          runId: "run-replacement-generation",
          results: [{ agent: "replacement-agent", sessionFile: replacementChild }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const replacementScan = await scanSessionFile(filePath);
  assert.notEqual(
    replacementScan.correlationEvidenceDigest,
    scan.correlationEvidenceDigest,
    "replacement evidence must have a different digest",
  );
  assert.equal(
    replacementScan.correlationEvidenceGeneration,
    scan.correlationEvidenceGeneration,
    "digest mismatch must not be hidden by a generation change",
  );
  const mismatch = await extractSubagentCorrelationsWithStatus(scan);
  assert.deepEqual(mismatch.failureReasons, ["digestMismatch"]);
  const coverage = aggregateCoverage([scan]);
  recordCorrelationEvidenceFailures(coverage, mismatch.failureReasons);
  assert.equal(coverage.totalCorrelationEvidenceFailures, 1);
  assert.equal(coverage.correlationEvidenceFailures.digestMismatch, 1);
  assert.deepEqual(
    mismatch.correlations,
    [],
    "mismatched evidence must not combine with the original scan snapshot",
  );
});

test("extractSubagentCorrelations: reports digest and generation mismatches", async (t) => {
  const lines = [
    sessionHeader("evidence-generation-mismatch"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "repeated-generation", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "repeated-generation", "subagent", {
      details: {
        runId: "generation-run",
        results: [{ agent: "generation-agent", sessionFile: "/sessions/generation.jsonl" }],
      },
    }),
  ];
  const filePath = writeFixture(t, lines);
  const scan = await scanSessionFile(filePath);

  writeFileSync(
    filePath,
    [
      ...lines,
      assistantMessageLine("2026-01-01T00:00:02.000Z", [
        { toolCallId: "repeated-generation", toolName: "subagent" },
      ]),
      toolResultLine("2026-01-01T00:00:03.000Z", "repeated-generation", "subagent", {
        details: {
          runId: "generation-run",
          results: [{ agent: "generation-agent", sessionFile: "/sessions/generation.jsonl" }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const mismatch = await extractSubagentCorrelationsWithStatus(scan);
  assert.deepEqual(mismatch.failureReasons, ["digestMismatch", "generationMismatch"]);
  const coverage = aggregateCoverage([scan]);
  recordCorrelationEvidenceFailures(coverage, mismatch.failureReasons);
  assert.equal(coverage.totalCorrelationEvidenceFailures, 1);
  assert.equal(coverage.correlationEvidenceFailures.digestMismatch, 1);
  assert.equal(coverage.correlationEvidenceFailures.generationMismatch, 1);
  assert.deepEqual(mismatch.correlations, []);
});

test("scanSessionFile: correlation evidence is bounded at the 4096-ID boundary", async (t) => {
  const makeLines = (count, toolName = "subagent") => {
    const lines = [sessionHeader(`evidence-${toolName}-${count}`)];
    for (let index = 0; index < count; index++) {
      const toolCallId = `${toolName}-evidence-${index}`;
      lines.push(assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId, toolName }]));
      lines.push(toolResultLine("2026-01-01T00:00:01.000Z", toolCallId, toolName));
    }
    return lines;
  };

  const atLimit = await scanSessionFile(writeFixture(t, makeLines(4096)));
  assert.equal(atLimit.toolPairs.length, 4096);
  assert.match(atLimit.correlationEvidenceDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(atLimit.correlationEvidenceGeneration, 8192);

  const overLimit = await scanSessionFile(writeFixture(t, makeLines(4097)));
  assert.equal(overLimit.toolPairs.length, 4097);
  assert.equal(overLimit.correlationEvidenceDigest, null);
  assert.equal(overLimit.correlationEvidenceGeneration, 0);
  assert.equal(overLimit.correlationEvidenceCaptureOverflow, true);
  assert.equal(aggregateCoverage([overLimit]).correlationEvidenceFailures.scanCaptureOverflow, 1);

  // Non-subagent tool IDs do not consume the subagent correlation evidence
  // budget, even when their count exceeds the same boundary.
  const displayOnly = await scanSessionFile(writeFixture(t, makeLines(4097, "bash")));
  assert.equal(displayOnly.toolPairs.length, 4097);
  assert.match(displayOnly.correlationEvidenceDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(displayOnly.correlationEvidenceGeneration, 0);
});

test("scanSessionFile: repeated correlation evidence overflows per-ID bounds", async (t) => {
  const count = 129;
  const lines = [sessionHeader("evidence-occurrence-overflow")];
  for (let index = 0; index < count; index++) {
    lines.push(
      assistantMessageLine("2026-01-01T00:00:00.000Z", [
        { toolCallId: "repeated-subagent", toolName: "subagent" },
      ]),
    );
    lines.push(toolResultLine("2026-01-01T00:00:01.000Z", "repeated-subagent", "subagent"));
  }

  const result = await scanSessionFile(writeFixture(t, lines));
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.duplicateToolCallIdCount, count - 1);
  assert.equal(result.correlationEvidenceDigest, null);
  assert.equal(result.correlationEvidenceGeneration, 0);
});

test("extractSubagentCorrelations: reports bounded rescan overflow", async (t) => {
  const initialLines = [
    sessionHeader("evidence-rescan-overflow"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "rescan-overflow", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "rescan-overflow", "subagent", {
      details: {
        runId: "rescan-run",
        results: [{ agent: "rescan-agent", sessionFile: "/sessions/rescan.jsonl" }],
      },
    }),
  ];
  const filePath = writeFixture(t, initialLines);
  const scan = await scanSessionFile(filePath);
  const appendedLines = [];
  for (let index = 0; index < 128; index++) {
    appendedLines.push(
      assistantMessageLine("2026-01-01T00:00:02.000Z", [
        { toolCallId: "rescan-overflow", toolName: "subagent" },
      ]),
      toolResultLine("2026-01-01T00:00:03.000Z", "rescan-overflow", "subagent", {
        details: {
          runId: "rescan-run",
          results: [{ agent: "rescan-agent", sessionFile: "/sessions/rescan.jsonl" }],
        },
      }),
    );
  }
  writeFileSync(filePath, [...initialLines, ...appendedLines].join("\n") + "\n", "utf8");

  const overflow = await extractSubagentCorrelationsWithStatus(scan);
  assert.deepEqual(overflow.failureReasons, ["rescanCaptureOverflow"]);
  assert.deepEqual(overflow.correlations, []);
  const coverage = aggregateCoverage([scan]);
  recordCorrelationEvidenceFailures(coverage, overflow.failureReasons);
  assert.equal(coverage.totalCorrelationEvidenceFailures, 1);
  assert.equal(coverage.correlationEvidenceFailures.rescanCaptureOverflow, 1);
});

test("extractSubagentCorrelations: skips the correlation rescan when no subagent call was paired", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("no-subagent-snapshot"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-bash", toolName: "bash" }]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-bash"),
  ]);
  const scan = await scanSessionFile(filePath);
  assert.equal(
    scan.toolPairs.some((pair) => pair.toolName === "subagent"),
    false,
  );

  let filePathRead = false;
  Object.defineProperty(scan, "filePath", {
    configurable: true,
    enumerable: true,
    get() {
      filePathRead = true;
      return filePath;
    },
  });

  assert.deepEqual(await extractSubagentCorrelations(scan), []);
  assert.equal(filePathRead, false, "empty paired-ID set must not reread the file");
});

test("extractSubagentCorrelations: returns empty array when no session header", async (t) => {
  // File with no session header entry
  const filePath = writeFixture(t, [
    assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-x", toolName: "bash" }]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-x"),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.equal(scan.sessionHeader, null);
  assert.deepEqual(await extractSubagentCorrelations(scan), []);
});

test("extractSubagentCorrelations: skips results missing sessionFile", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("sess-partial"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-partial", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:02.000Z", "tc-partial", "subagent", {
      details: {
        runId: "run-partial",
        results: [
          { agent: "agent-no-file" }, // no sessionFile
        ],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const correlations = await extractSubagentCorrelations(scan);
  assert.equal(correlations.length, 0);
});

test("extractSubagentCorrelations: marks child as resolved when child file is readable and under sessionsDir", async (t) => {
  const dir = makeTempDir("session-analysis-child-resolve-", t);

  // Write child session file
  const childPath = join(dir, "sessions", "child-proj", "session.jsonl");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "sessions", "child-proj"), { recursive: true });
  writeFileSync(childPath, sessionHeader("child-sess-id", "/workspace") + "\n", "utf8");

  const sessionsDir = join(dir, "sessions");

  // Write parent session file (not under sessionsDir for testing purposes)
  const parentPath = writeFixture(t, [
    sessionHeader("parent-id"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-s", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-s", "subagent", {
      details: {
        runId: "run-x",
        results: [{ agent: "agent-x", sessionFile: childPath }],
      },
    }),
  ]);

  const scan = await scanSessionFile(parentPath);
  const correlations = await extractSubagentCorrelations(scan, sessionsDir);
  assert.equal(correlations.length, 1);
  const c = correlations[0];
  assert.equal(c?.childResolved, true, "child must be marked resolved");
  assert.equal(c?.childSessionId, "child-sess-id");
  assert.ok(typeof c?.childStartedAt === "string");
});

test("extractSubagentCorrelations: marks child as unresolved when file does not exist", async (t) => {
  const dir = makeTempDir("session-analysis-child-missing-", t);
  const sessionsDir = join(dir, "sessions");
  const missingChild = join(sessionsDir, "ghost", "session.jsonl");

  const filePath = writeFixture(t, [
    sessionHeader("p-id"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-g", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-g", "subagent", {
      details: {
        runId: "run-g",
        results: [{ agent: "ghost", sessionFile: missingChild }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const correlations = await extractSubagentCorrelations(scan, sessionsDir);
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0]?.childResolved, false);
  assert.equal(correlations[0]?.childSessionId, undefined);
});

test("extractSubagentCorrelations: does not resolve child outside sessionsDir (path safety)", async (t) => {
  const dir = makeTempDir("session-analysis-path-safety-", t);
  const sessionsDir = join(dir, "sessions");

  // Child file outside sessionsDir
  const outsidePath = join(dir, "outside", "session.jsonl");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(outsidePath, sessionHeader("outside-id", "/x") + "\n", "utf8");

  const filePath = writeFixture(t, [
    sessionHeader("p-id"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-o", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-o", "subagent", {
      details: {
        runId: "run-o",
        results: [{ agent: "outside", sessionFile: outsidePath }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const correlations = await extractSubagentCorrelations(scan, sessionsDir);
  assert.equal(correlations.length, 1);
  // Correlation is emitted (visible gap) but child is NOT resolved (outside boundary).
  assert.equal(
    correlations[0]?.childResolved,
    false,
    "child outside sessionsDir must not be resolved",
  );
  assert.equal(correlations[0]?.childSessionId, undefined);
});

// ---------------------------------------------------------------------------
// Fix 4: honest tool-call counting and duplicate ids
// ---------------------------------------------------------------------------

test("scanSessionFile: observedToolCallCount counts all calls including unmatched", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    // Three calls, only one result
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-a", toolName: "bash" },
      { toolCallId: "tc-b", toolName: "bash" },
      { toolCallId: "tc-c", toolName: "bash" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-a"),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.observedToolCallCount, 3, "must count all 3 observed calls");
  assert.equal(result.toolPairs.length, 1, "only one matched pair");
  assert.equal(result.unmatchedToolCallCount, 2, "two unmatched calls");
});

test("scanSessionFile: duplicate toolCallId is counted as ambiguity", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [{ toolCallId: "tc-dup", toolName: "bash" }]),
    // Same toolCallId appears again — duplicate
    assistantMessageLine("2026-01-01T00:00:01.000Z", [{ toolCallId: "tc-dup", toolName: "read" }]),
    toolResultLine("2026-01-01T00:00:02.000Z", "tc-dup"),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.observedToolCallCount, 2, "both occurrences counted");
  assert.equal(result.duplicateToolCallIdCount, 1, "duplicate must be counted");
  // Only one pair (last call wins)
  assert.equal(result.toolPairs.length, 1);
});

// ---------------------------------------------------------------------------
// Fix 6: latency math robustness
// ---------------------------------------------------------------------------

test("scanSessionFile: invalid timestamps produce invalidTimestampPairCount, not NaN latency", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    // Call with invalid timestamp
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "tc-bad-ts", toolName: "bash" }],
        timestamp: "not-a-date",
      },
    }),
    // Result with valid timestamp
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc-bad-ts",
        toolName: "bash",
        isError: false,
        content: [],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.invalidTimestampPairCount, 1, "bad timestamp pair must be counted");
  assert.equal(result.toolPairs.length, 0, "invalid pair must not appear in toolPairs");
});

test("scanSessionFile: negative latency is counted as invalid, not included in toolPairs", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader(),
    // Result timestamp BEFORE call timestamp (clock skew / bad data)
    assistantMessageLine("2026-01-01T00:00:05.000Z", [{ toolCallId: "tc-neg", toolName: "bash" }]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-neg"),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.invalidTimestampPairCount, 1, "negative latency must be counted as invalid");
  assert.equal(result.toolPairs.length, 0);
});

// ---------------------------------------------------------------------------
// readSessionHeader tests
// ---------------------------------------------------------------------------

test("readSessionHeader: returns header from first valid session entry", async (t) => {
  const filePath = writeFixture(t, [
    "not json",
    sessionHeader("hdr-only-id", "/my/cwd"),
    assistantMessageLine("2026-01-01T00:00:01.000Z", []),
  ]);

  const header = await readSessionHeader(filePath);
  assert.equal(header?.id, "hdr-only-id");
  assert.equal(header?.cwd, "/my/cwd");
});

test("readSessionHeader: returns null for file with no session header", async (t) => {
  const filePath = writeFixture(t, [assistantMessageLine("2026-01-01T00:00:01.000Z", [])]);

  const header = await readSessionHeader(filePath);
  assert.equal(header, null);
});

// ---------------------------------------------------------------------------
// aggregateCoverage tests
// ---------------------------------------------------------------------------

test("aggregateCoverage: sums fields across multiple scan results", () => {
  // Construct minimal fake scan results (no need to read real files)
  const results = [
    {
      filePath: "/a.jsonl",
      sessionHeader: null,
      toolPairs: [],
      malformedLines: 3,
      unmatchedToolCallCount: 1,
      unmatchedToolResultCount: 2,
      fileSizeChangedDuringScan: true,
      observedToolCallCount: 1,
      duplicateToolCallIdCount: 0,
      invalidTimestampPairCount: 0,
    },
    {
      filePath: "/b.jsonl",
      sessionHeader: null,
      toolPairs: [],
      malformedLines: 0,
      unmatchedToolCallCount: 0,
      unmatchedToolResultCount: 0,
      fileSizeChangedDuringScan: false,
      observedToolCallCount: 0,
      duplicateToolCallIdCount: 0,
      invalidTimestampPairCount: 0,
    },
    {
      filePath: "/c.jsonl",
      sessionHeader: null,
      toolPairs: [],
      malformedLines: 5,
      unmatchedToolCallCount: 2,
      unmatchedToolResultCount: 1,
      fileSizeChangedDuringScan: true,
      observedToolCallCount: 2,
      duplicateToolCallIdCount: 1,
      invalidTimestampPairCount: 2,
    },
  ];

  const coverage = aggregateCoverage(results);
  assert.equal(coverage.filesScanned, 3);
  assert.equal(coverage.totalMalformedLines, 8);
  assert.equal(coverage.totalUnmatchedToolCalls, 3);
  assert.equal(coverage.totalUnmatchedToolResults, 3);
  assert.equal(coverage.filesWithSizeChange, 2);
  assert.equal(coverage.totalDuplicateToolCallIds, 1);
  assert.equal(coverage.totalInvalidTimestampPairs, 2);
  // Without extra, filesDiscovered defaults to filesScanned
  assert.equal(coverage.filesDiscovered, 3);
  assert.equal(coverage.failedScans, 0);
  assert.equal(coverage.unreadableDirectories, 0);
});

test("aggregateCoverage: extra data overrides defaults", () => {
  const coverage = aggregateCoverage([], {
    filesDiscovered: 10,
    failedScans: 3,
    unreadableDirectories: 1,
  });
  assert.equal(coverage.filesDiscovered, 10);
  assert.equal(coverage.filesScanned, 0);
  assert.equal(coverage.failedScans, 3);
  assert.equal(coverage.unreadableDirectories, 1);
});

test("scanSessionFile: accepts fixture-style timestamps at entry level (not message level)", async (t) => {
  // Some fixtures put timestamp on the outer entry, not on .message — both must work.
  const filePath = writeFixture(t, [
    sessionHeader(),
    JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z", // entry-level timestamp
      message: {
        role: "assistant",
        model: "m",
        provider: "p",
        api: "a",
        responseId: "r",
        stopReason: "tool_use",
        usage: {},
        content: [{ type: "toolCall", toolCallId: "tc-entry-ts", toolName: "bash" }],
        // no timestamp on message itself
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:02.000Z", // entry-level timestamp
      message: {
        role: "toolResult",
        toolCallId: "tc-entry-ts",
        toolName: "bash",
        isError: false,
        content: [],
        // no timestamp on message itself
      },
    }),
  ]);

  const result = await scanSessionFile(filePath);
  assert.equal(result.toolPairs.length, 1);
  assert.equal(result.toolPairs[0]?.observedLatencyMs, 1000);
  assert.equal(result.malformedLines, 0);
});

// ---------------------------------------------------------------------------
// Finding 3: path-boundary hardening — traversal and symlink
// ---------------------------------------------------------------------------

test("extractSubagentCorrelations: refuses path traversal escaping sessionsDir without throwing", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const dir = makeTempDir("session-analysis-traversal-", t);

  // Create a real file outside sessionsDir that the traversal would reach.
  const outsideDir = join(dir, "outside");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(
    join(outsideDir, "session.jsonl"),
    sessionHeader("outside-id", "/x") + "\n",
    "utf8",
  );

  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  // Construct a path that starts under sessionsDir but traverses out via "..".
  // e.g. <sessionsDir>/sub/../../outside/session.jsonl → resolves outside
  const traversalPath = join(sessionsDir, "sub", "..", "..", "outside", "session.jsonl");

  const filePath = writeFixture(t, [
    sessionHeader("p-traversal"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-trav", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-trav", "subagent", {
      details: {
        runId: "run-trav",
        results: [{ agent: "attacker", sessionFile: traversalPath }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  // Must not throw; traversal path must be refused (childResolved = false).
  const correlations = await extractSubagentCorrelations(scan, sessionsDir);
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0]?.childResolved, false, "traversal path must not be resolved");
  assert.equal(correlations[0]?.childSessionId, undefined);
});

test("extractSubagentCorrelations: refuses symlink pointing outside sessionsDir without throwing", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const dir = makeTempDir("session-analysis-symlink-escape-", t);

  // Create real target outside sessionsDir.
  const outsideDir = join(dir, "outside");
  mkdirSync(outsideDir, { recursive: true });
  const realTarget = join(outsideDir, "session.jsonl");
  writeFileSync(realTarget, sessionHeader("outside-sym-id", "/x") + "\n", "utf8");

  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  // Symlink inside sessionsDir pointing to the outside target.
  const linkPath = join(sessionsDir, "escape-link.jsonl");
  symlinkSync(realTarget, linkPath);

  const filePath = writeFixture(t, [
    sessionHeader("p-symlink"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "tc-sym", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "tc-sym", "subagent", {
      details: {
        runId: "run-sym",
        results: [{ agent: "escaper", sessionFile: linkPath }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  // Must not throw; symlink escape must be refused (childResolved = false).
  const correlations = await extractSubagentCorrelations(scan, sessionsDir);
  assert.equal(correlations.length, 1);
  assert.equal(
    correlations[0]?.childResolved,
    false,
    "symlink pointing outside sessionsDir must not be resolved",
  );
  assert.equal(correlations[0]?.childSessionId, undefined);
});
