import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { waitForMockPiCall } from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

describe("async execution mock-call waits", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir();
    mockPi.reset();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("returns an expected call while terminal-aware polling is enabled", async () => {
    const terminalResultPath = path.join(tempDir, "result.json");
    const callPath = path.join(mockPi.dir, `call-${Date.now()}-${process.pid}-expected.json`);
    fs.writeFileSync(
      callPath,
      JSON.stringify({ args: ["--mode", "json"], systemPrompts: [] }),
      "utf-8",
    );

    const call = await waitForMockPiCall(mockPi, 0, scaleTestTimeout(1_000), {
      terminalResultPath,
    });
    assert.deepEqual(call.args, ["--mode", "json"]);
  });

  it("reports a terminal result immediately when the expected call never appears", async () => {
    const terminalResultPath = path.join(tempDir, "result.json");
    fs.writeFileSync(
      terminalResultPath,
      JSON.stringify({
        state: "failed",
        timedOut: true,
        error: "Subagent timed out before mock startup",
        summary: "startup timeout",
      }),
      "utf-8",
    );
    const originalSetTimeout = globalThis.setTimeout;
    let pollingAttempted = false;
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (..._args: Parameters<typeof setTimeout>) => {
        pollingAttempted = true;
        throw new Error("unexpected polling wait");
      },
    });
    try {
      await assert.rejects(
        waitForMockPiCall(mockPi, 0, scaleTestTimeout(10_000), { terminalResultPath }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /reached terminal state before recorded mock pi call 0/);
          assert.match(message, /state=failed/);
          assert.match(message, /timedOut=true/);
          assert.match(message, /Subagent timed out before mock startup/);
          return true;
        },
      );
    } finally {
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        writable: true,
        value: originalSetTimeout,
      });
    }
    assert.equal(
      pollingAttempted,
      false,
      "terminal-aware detection must fail before scheduling a polling wait",
    );
  });

  it("keeps the ordinary polling expiry when no terminal result is supplied", async () => {
    await assert.rejects(
      waitForMockPiCall(mockPi, 0, scaleTestTimeout(100)),
      /Timed out waiting for recorded mock pi call 0/,
    );
  });
});
