import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { makeTempDir } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { aggregateSessionUsage } = await jiti.import(
  "../extensions/the-last-harness/session-limit-report-aggregator.ts",
);
const { createSessionLimitReportCommandHandler } = await jiti.import(
  "../extensions/the-last-harness/session-limit-report.ts",
);

const WINDOW = {
  startMs: Date.parse("2026-05-01T10:00:00Z"),
  endMs: Date.parse("2026-05-01T15:00:00Z"),
};
const IN = "2026-05-01T12:00:00.000Z";
const OUT = "2026-05-01T08:00:00.000Z";

function usage(input, cost) {
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    cost: { total: cost },
  };
}

test("aggregator adds non-turn usage without incrementing turn counts", () => {
  const entries = [
    { type: "session", id: "s1", cwd: "/p" },
    { type: "model_change", provider: "anthropic", modelId: "m" },
    { type: "message", timestamp: IN, message: { role: "assistant", usage: usage(100, 1) } },
    { type: "usage", timestamp: IN, usage: usage(10, 0.5) },
    { type: "usage", timestamp: OUT, usage: usage(1000, 9) },
    { type: "compaction", timestamp: IN, usage: usage(20, 0.25) },
    { type: "branch_summary", timestamp: IN, usage: usage(30, 0.125) },
    { type: "message", timestamp: IN, message: { role: "toolResult", usage: usage(40, 0.0625) } },
  ];
  const result = aggregateSessionUsage(WINDOW, "/sessions", [
    { filePath: "/sessions/--p--/a.jsonl", entries, malformedLineCount: 0 },
  ]);
  const t = result.rows[0].windowTotals;
  assert.equal(t.inputTokens, 200);
  assert.equal(t.costUsd, 1.9375);
  assert.equal(t.turns, 1);
  assert.equal(t.assistantMessages, 1);
  assert.equal(result.rows[0].coverage.assistantMessages, 1);
  assert.equal(result.perProviderTotals[0].usage.costUsd, 1.9375);
});

test("session-limit report slimming keeps non-turn usage but drops content", async (t) => {
  const baseDir = makeTempDir("tlh-slr-nonturn-", t);
  const sessionsRoot = join(baseDir, "sessions");
  const projectDir = join(sessionsRoot, "--Users-foo-proj--");
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    { type: "session", id: "s1", cwd: "/Users/foo/proj", timestamp: IN },
    {
      type: "usage",
      timestamp: IN,
      reason: "SECRET REASON",
      provider: "anthropic",
      model: "m",
      usage: usage(7777, 0.4),
    },
    { type: "compaction", timestamp: IN, summary: "SECRET SUMMARY", usage: usage(1111, 0.1) },
  ];
  writeFileSync(join(projectDir, "a.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const now = new Date("2026-05-01T13:00:00.000Z");
  let opened;
  const handler = createSessionLimitReportCommandHandler(
    { on() {}, registerCommand() {}, getThinkingLevel: () => "off" },
    {
      openReport: async (p) => {
        opened = p;
      },
      now: () => now,
      getSnapshot: () => ({
        provider: "anthropic",
        fetchedAt: now.getTime(),
        windows: {
          session: {
            key: "session",
            label: "Session",
            percent: 10,
            resetsAt: new Date(now.getTime() + 2 * 3600e3).toISOString(),
            durationMs: 5 * 3600e3,
          },
        },
      }),
    },
  );
  await handler("", {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(baseDir, "cur", "session.jsonl"),
      getSessionDir: () => projectDir,
    },
  });
  assert.ok(opened);
  const html = readFileSync(opened, "utf8");
  assert.match(html, /8,888/);
  assert.doesNotMatch(html, /SECRET/);
});
