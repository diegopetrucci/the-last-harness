/**
 * Integration tests for runSync error handling.
 *
 * Covers agent crashes, stderr capture, and hidden-failure overrides.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  removeTempDir,
  makeAgentConfigs,
  events,
  tryImport,
} from "../support/helpers.ts";

// Top-level await
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");

const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;

describe(
  "runSync error handling",
  { skip: !piAvailable ? "pi packages not available" : undefined },
  () => {
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

    it("captures stderr on non-zero exit", async () => {
      mockPi.onCall({ exitCode: 2, stderr: "Fatal: out of memory" });
      const agents = makeAgentConfigs(["crash"]);

      const result = await runSync(tempDir, agents, "crash", "Do heavy work", {});

      assert.equal(result.exitCode, 2);
      assert.ok(result.error?.includes("out of memory"));
    });

    it("detectSubagentError overrides exit 0 on hidden failure", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolStart("bash", { command: "deploy" }),
          events.toolEnd("bash"),
          events.toolResult("bash", "connection refused"),
        ],
      });
      const agents = makeAgentConfigs(["deployer"]);

      const result = await runSync(tempDir, agents, "deployer", "Deploy app", {});

      assert.notEqual(result.exitCode, 0, "should detect hidden failure");
      assert.ok(result.error?.includes("connection refused"));
    });
  },
);
