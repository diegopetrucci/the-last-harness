import assert from "node:assert/strict";
import test from "node:test";

import { SELECTABLE_PRIMARY_AGENTS } from "../extensions/the-last-harness-primary-agent.mjs";
import {
  createTlhPrimaryAgentResourceLifecycle,
  retireTlhPrimaryAgentResourceRuntime,
} from "../extensions/the-last-harness/primary-agent-runtime-lifecycle.ts";
import {
  rushResumeDelegationReason,
  rushSteerDelegationReason,
} from "../extensions/the-last-harness/primary-agent-runtime-delegation.ts";
import { getTlhProjectAgentAccess } from "../extensions/the-last-harness/project-agent-access.mjs";

function accessFor(selection, hasActivePrimaryAgent = true) {
  createTlhPrimaryAgentResourceLifecycle({
    getPrimaryAgentSelection: () => selection,
    hasActivePrimaryAgent: () => hasActivePrimaryAgent,
  });
  return getTlhProjectAgentAccess({ cwd: process.cwd(), sessionId: "session", targetNames: [] });
}

test("lifecycle provider grants control and initiation to every enabled primary", (t) => {
  t.after(() => retireTlhPrimaryAgentResourceRuntime());
  const names = [...SELECTABLE_PRIMARY_AGENTS];
  assert.ok(names.length > 1, "expected several selectable primaries");
  for (const name of names) {
    const access = accessFor(name);
    assert.equal(access?.canManage, true, name);
    assert.equal(access?.canInitiate, true, name);
    assert.equal(access?.architect, name === "architect", name);
    assert.equal(access?.controlRestrictedToEmbedded, name === "rush", name);
    assert.equal(access?.resumeRestrictionReason, rushResumeDelegationReason(), name);
    assert.equal(access?.steerRestrictionReason, rushSteerDelegationReason(), name);
  }
});

test("lifecycle provider denies control without an active primary and after retirement", () => {
  const inactive = accessFor("architect", false);
  assert.equal(inactive?.canManage, false);
  retireTlhPrimaryAgentResourceRuntime();
  assert.equal(
    getTlhProjectAgentAccess({ cwd: process.cwd(), sessionId: null, targetNames: [] }),
    undefined,
  );
});
