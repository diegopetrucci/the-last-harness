/**
 * Regression tests for the async launch receipt renderer.
 *
 * Covers both single-agent and parallel (multi-agent) receipts.
 * Verifies "Background run started", run ID, agent/count, status location,
 * and "Completion arrives separately." — never implies completion.
 *
 * Ticket: tlhf-5veu
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAsyncLaunchReceipt } from "../../src/runs/background/async-execution.ts";

describe("buildAsyncLaunchReceipt — single agent", () => {
  it("contains 'Background run started' as the first line", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "abc-123",
      asyncDir: "/tmp/tlh-runs/abc-123",
      agent: "developer",
    });
    const lines = receipt.split("\n");
    assert.equal(lines[0], "Background run started");
  });

  it("contains the agent name", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "abc-123",
      asyncDir: "/tmp/tlh-runs/abc-123",
      agent: "developer",
    });
    assert.match(receipt, /Agent: developer/);
  });

  it("contains the run ID", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "run-xyz-456",
      asyncDir: "/tmp/tlh-runs/run-xyz-456",
      agent: "developer",
    });
    assert.match(receipt, /Run ID: run-xyz-456/);
  });

  it("contains the status/artifacts path (asyncDir/status.json)", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "run-abc",
      asyncDir: "/tmp/tlh-runs/run-abc",
      agent: "developer",
    });
    assert.match(receipt, /Status\/artifacts: \/tmp\/tlh-runs\/run-abc\/status\.json/);
  });

  it("contains 'Completion arrives separately.' as the last line", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "abc-123",
      asyncDir: "/tmp/tlh-runs/abc-123",
      agent: "developer",
    });
    const lines = receipt.split("\n");
    assert.equal(lines[lines.length - 1], "Completion arrives separately.");
  });

  it("does not contain words that imply completion (done, finished, complete, succeeded)", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "abc-123",
      asyncDir: "/tmp/tlh-runs/abc-123",
      agent: "developer",
    });
    const lower = receipt.toLowerCase();
    assert.ok(!lower.includes("finished"), "must not say 'finished'");
    assert.ok(!lower.includes("succeeded"), "must not say 'succeeded'");
    // 'complete' only appears inside 'Completion arrives separately' which is allowed
    // by design; check the receipt does not claim the run IS complete
    assert.ok(
      !lower.includes("run complete") && !lower.includes("completed successfully"),
      "must not imply run is already complete",
    );
  });
});

describe("buildAsyncLaunchReceipt — parallel (multi-agent)", () => {
  it("contains 'Background run started' as the first line", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-001",
      asyncDir: "/tmp/tlh-runs/par-001",
      agentNames: ["developer", "code-reviewer"],
    });
    const lines = receipt.split("\n");
    assert.equal(lines[0], "Background run started");
  });

  it("shows agent count and names for multi-agent parallel", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-001",
      asyncDir: "/tmp/tlh-runs/par-001",
      agentNames: ["developer", "code-reviewer"],
    });
    assert.match(receipt, /Agents: 2/);
    assert.match(receipt, /developer/);
    assert.match(receipt, /code-reviewer/);
  });

  it("shows single agent name when agentNames has one entry", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-002",
      asyncDir: "/tmp/tlh-runs/par-002",
      agentNames: ["developer"],
    });
    assert.match(receipt, /Agent: developer/);
  });

  it("shows count:3 for three parallel agents (count expansion)", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-003",
      asyncDir: "/tmp/tlh-runs/par-003",
      agentNames: ["developer", "developer", "developer"],
    });
    assert.match(receipt, /Agents: 3/);
  });

  it("contains the run ID", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-run-99",
      asyncDir: "/tmp/tlh-runs/par-run-99",
      agentNames: ["developer", "test-runner"],
    });
    assert.match(receipt, /Run ID: par-run-99/);
  });

  it("contains the status/artifacts path", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-run-99",
      asyncDir: "/tmp/tlh-runs/par-run-99",
      agentNames: ["developer", "test-runner"],
    });
    assert.match(receipt, /Status\/artifacts: \/tmp\/tlh-runs\/par-run-99\/status\.json/);
  });

  it("contains 'Completion arrives separately.' as the last line", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "par-run-99",
      asyncDir: "/tmp/tlh-runs/par-run-99",
      agentNames: ["developer", "test-runner"],
    });
    const lines = receipt.split("\n");
    assert.equal(lines[lines.length - 1], "Completion arrives separately.");
  });
});

describe("buildAsyncLaunchReceipt — no agent specified", () => {
  it("omits the agent line when neither agent nor agentNames is provided", () => {
    const receipt = buildAsyncLaunchReceipt({
      id: "bare-001",
      asyncDir: "/tmp/tlh-runs/bare-001",
    });
    assert.ok(!receipt.includes("Agent:"), "no agent line when neither agent nor agentNames given");
    assert.match(receipt, /Background run started/);
    assert.match(receipt, /Run ID: bare-001/);
    assert.match(receipt, /Completion arrives separately\./);
  });
});
