import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProjectAgentAccess } from "../../src/runs/shared/project-agent-control.ts";

describe("normalizeProjectAgentAccess", () => {
  it("lets canManage and canInitiate come from enabled non-architect primaries", () => {
    const access = normalizeProjectAgentAccess({
      architect: false,
      canManage: true,
      canInitiate: true,
    });
    assert.equal(access?.canManage, true);
    assert.equal(access?.canInitiate, true);
    assert.equal(access?.architect, false);
  });

  it("keeps disabled mode initiate-only", () => {
    const access = normalizeProjectAgentAccess({
      architect: false,
      canManage: false,
      canInitiate: true,
    });
    assert.equal(access?.canManage, false);
    assert.equal(access?.canInitiate, true);
  });

  it("falls back to architect for legacy providers and rejects malformed input", () => {
    assert.equal(normalizeProjectAgentAccess({ architect: true })?.canManage, true);
    assert.equal(normalizeProjectAgentAccess({}), undefined);
  });
});
