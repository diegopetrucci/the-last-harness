import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNoDeveloperPolicyActive,
  normalizeProjectAgentAccess,
} from "../../src/runs/shared/project-agent-control.ts";
import {
  createTlhNoDeveloperPolicyRuntime,
  getTlhProjectAgentAccess,
  setTlhProjectAgentAccessProvider,
} from "../../../the-last-harness/project-agent-access.mjs";

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

  it("preserves the captured no-developer policy through normal and restrictive normalization", () => {
    assert.equal(
      normalizeProjectAgentAccess({
        architect: false,
        canManage: true,
        canInitiate: true,
        noDeveloper: true,
      })?.noDeveloper,
      true,
    );
    assert.equal(
      normalizeProjectAgentAccess({
        controlRestrictedToEmbedded: true,
        noDeveloper: true,
      })?.noDeveloper,
      true,
    );
  });

  it("fails closed when captured no-developer evidence is malformed", () => {
    assert.equal(
      normalizeProjectAgentAccess({
        architect: false,
        canManage: true,
        noDeveloper: "true" as never,
      })?.noDeveloperPolicyInvalid,
      true,
    );
  });

  it("denies malformed permission booleans without reconstructing access", () => {
    for (const noDeveloper of [false, true]) {
      const access = normalizeProjectAgentAccess({
        architect: true,
        canManage: "yes" as never,
        canInitiate: "no" as never,
        noDeveloper,
      });
      assert.deepEqual(
        {
          architect: access?.architect,
          canManage: access?.canManage,
          canInitiate: access?.canInitiate,
          noDeveloper: access?.noDeveloper,
        },
        { architect: false, canManage: false, canInitiate: false, noDeveloper },
      );
      assert.equal(isNoDeveloperPolicyActive(access), noDeveloper);
    }
  });

  it("retains an active no-developer snapshot when the host bridge throws or disappears", () => {
    const runtime = createTlhNoDeveloperPolicyRuntime();
    runtime.capture(true);
    try {
      setTlhProjectAgentAccessProvider(() => {
        throw new Error("bridge broken");
      });
      assert.equal(
        (getTlhProjectAgentAccess({}) as { noDeveloper?: boolean } | undefined)?.noDeveloper,
        true,
      );

      setTlhProjectAgentAccessProvider(undefined);
      assert.deepEqual(getTlhProjectAgentAccess({}), {
        architect: false,
        canManage: false,
        canInitiate: false,
        noDeveloper: true,
      });
    } finally {
      setTlhProjectAgentAccessProvider(undefined);
      runtime.clear();
    }
  });

  it("keeps an absent bridge unrestricted when no host restriction is active", () => {
    setTlhProjectAgentAccessProvider(undefined);
    assert.equal(getTlhProjectAgentAccess({}), undefined);
  });

  it("falls back to architect for legacy providers and rejects malformed input", () => {
    assert.equal(normalizeProjectAgentAccess({ architect: true })?.canManage, true);
    assert.equal(normalizeProjectAgentAccess({}), undefined);
  });
});
