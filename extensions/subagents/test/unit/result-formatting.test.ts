import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSubagentResultStatus } from "../../src/shared/result-formatting.ts";

describe("result formatter", () => {
  it("resolves paused, completed, and failed statuses", () => {
    assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
    assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
    assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
  });
});
