import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatLogger } from "../../src/runs/shared/heartbeat-logger.ts";
import type { HeartbeatLogRecord } from "../../src/runs/shared/heartbeat-logger.ts";

function makeRecord(partial: Partial<HeartbeatLogRecord> = {}): HeartbeatLogRecord {
  return {
    ts: 1_000,
    sessionId: "sess-1",
    gapId: "gap-1",
    beatIndex: 0,
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    outcome: "cache_read",
    ...partial,
  };
}

describe("createHeartbeatLogger — no-op when logPath is undefined", () => {
  it("does not throw", () => {
    const logger = createHeartbeatLogger(undefined);
    assert.doesNotThrow(() => logger.append(makeRecord()));
  });
});

describe("createHeartbeatLogger — appends JSONL lines", () => {
  it("calls mkdirSync and appendFileSync with a newline-terminated JSON record", () => {
    const written: string[] = [];
    const dirs: string[] = [];

    const logger = createHeartbeatLogger("/fake/subagents/heartbeat.jsonl", {
      mkdirSync(dir) {
        dirs.push(dir);
      },
      appendFileSync(_file, data) {
        written.push(data);
      },
    });

    const record = makeRecord({
      usage: { input: 10, cacheRead: 5000, cacheWrite: 0, output: 1 },
      estCostUsd: 0.000125,
      latencyMs: 456,
    });
    logger.append(record);

    assert.equal(written.length, 1);
    assert.ok(written[0].endsWith("\n"), "line must end with newline");

    const parsed = JSON.parse(written[0]) as HeartbeatLogRecord;
    assert.equal(parsed.ts, 1_000);
    assert.equal(parsed.sessionId, "sess-1");
    assert.equal(parsed.gapId, "gap-1");
    assert.equal(parsed.beatIndex, 0);
    assert.equal(parsed.model, "claude-sonnet-4-20250514");
    assert.equal(parsed.provider, "anthropic");
    assert.equal(parsed.outcome, "cache_read");
    assert.ok(parsed.usage);
    assert.equal(parsed.usage.cacheRead, 5000);
    assert.equal(parsed.estCostUsd, 0.000125);
    assert.equal(parsed.latencyMs, 456);

    // Directory parent should have been created
    assert.ok(dirs.some((d) => d.includes("subagents")));
  });

  it("creates parent directory before each write", () => {
    const mkdirCalls: string[] = [];
    const logger = createHeartbeatLogger("/fake/path/heartbeat.jsonl", {
      mkdirSync(dir) {
        mkdirCalls.push(dir);
      },
      appendFileSync() {},
    });

    logger.append(makeRecord());
    logger.append(makeRecord({ beatIndex: 1 }));
    assert.equal(mkdirCalls.length, 2);
  });

  it("swallows errors from mkdirSync without throwing", () => {
    const logger = createHeartbeatLogger("/fake/heartbeat.jsonl", {
      mkdirSync() {
        throw new Error("permission denied");
      },
      appendFileSync() {},
    });
    assert.doesNotThrow(() => logger.append(makeRecord()));
  });

  it("swallows errors from appendFileSync without throwing", () => {
    const logger = createHeartbeatLogger("/fake/heartbeat.jsonl", {
      mkdirSync() {},
      appendFileSync() {
        throw new Error("disk full");
      },
    });
    assert.doesNotThrow(() => logger.append(makeRecord()));
  });
});

describe("createHeartbeatLogger — record shapes for all outcomes", () => {
  const outcomes = ["cache_read", "cache_write_mismatch", "error", "capped", "lost"] as const;

  for (const outcome of outcomes) {
    it(`writes a parseable record for outcome=${outcome}`, () => {
      const written: string[] = [];
      const logger = createHeartbeatLogger("/fake/heartbeat.jsonl", {
        mkdirSync() {},
        appendFileSync(_file, data) {
          written.push(data);
        },
      });
      logger.append(makeRecord({ outcome }));
      const parsed = JSON.parse(written[0]) as HeartbeatLogRecord;
      assert.equal(parsed.outcome, outcome);
    });
  }
});
