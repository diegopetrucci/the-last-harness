import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRIMARY_AGENT,
  PRIMARY_AGENT_SESSION_STATE_ENTRY,
  nextPrimaryAgentSelection,
  primaryAgentDefaultLabel,
  primaryAgentSelectionFromBranch,
  resolvePrimaryAgentConfig,
  resolvePrimaryAgentSessionState,
} from "../extensions/the-last-harness-primary-agent.mjs";

test("primary-agent config defaults to architect without settings", () => {
  assert.equal(resolvePrimaryAgentConfig(undefined).selection, DEFAULT_PRIMARY_AGENT);
  assert.equal(resolvePrimaryAgentConfig({}).selection, DEFAULT_PRIMARY_AGENT);
  assert.equal(resolvePrimaryAgentConfig({ enabled: true }).selection, DEFAULT_PRIMARY_AGENT);
  assert.equal(primaryAgentDefaultLabel(undefined), "unset (TLH default: architect)");
});

test("primary-agent config supports selectable primaries", () => {
  assert.equal(resolvePrimaryAgentConfig({ selected: "rush" }).selection, "rush");
  assert.equal(resolvePrimaryAgentConfig({ enabled: true, selected: "rush" }).selection, "rush");
  assert.equal(resolvePrimaryAgentConfig({ selected: "product" }).selection, "product");
  assert.equal(
    resolvePrimaryAgentConfig({ enabled: true, selected: "product" }).selection,
    "product",
  );
  assert.equal(resolvePrimaryAgentConfig({ selected: "bug-hunter" }).selection, "bug-hunter");
  assert.equal(
    resolvePrimaryAgentConfig({ enabled: true, selected: "bug-hunter" }).selection,
    "bug-hunter",
  );
});

test("retired disabled inputs in persistent config fall back to architect via the generic invalid-selection diagnostic", () => {
  const expected = { selection: DEFAULT_PRIMARY_AGENT, invalidSelected: "disabled" };
  assert.deepEqual(resolvePrimaryAgentConfig({ selected: "disabled" }), expected);
  assert.deepEqual(resolvePrimaryAgentConfig({ enabled: false }), expected);
  assert.deepEqual(resolvePrimaryAgentConfig({ enabled: false, selected: "product" }), expected);
  assert.equal(
    primaryAgentDefaultLabel({ enabled: false }),
    'invalid "disabled" (TLH fallback: architect)',
  );
});

test("invalid persistent primary names fall back to architect with a diagnostic", () => {
  assert.deepEqual(resolvePrimaryAgentConfig({ selected: "planner" }), {
    selection: DEFAULT_PRIMARY_AGENT,
    invalidSelected: "planner",
  });
  assert.equal(
    primaryAgentDefaultLabel({ selected: "planner" }),
    'invalid "planner" (TLH fallback: architect)',
  );
});

test("session primary state preserves old enabled booleans and supports selected primaries", () => {
  assert.deepEqual(resolvePrimaryAgentSessionState({}), {});
  assert.equal(resolvePrimaryAgentSessionState(true).selection, DEFAULT_PRIMARY_AGENT);
  assert.equal(resolvePrimaryAgentSessionState({ enabled: true }).selection, DEFAULT_PRIMARY_AGENT);
  assert.equal(resolvePrimaryAgentSessionState({ selected: "rush" }).selection, "rush");
  assert.equal(
    resolvePrimaryAgentSessionState({ enabled: true, selected: "rush" }).selection,
    "rush",
  );
  assert.equal(resolvePrimaryAgentSessionState({ selected: "product" }).selection, "product");
  assert.equal(
    resolvePrimaryAgentSessionState({ enabled: true, selected: "product" }).selection,
    "product",
  );
  assert.equal(resolvePrimaryAgentSessionState({ selected: "bug-hunter" }).selection, "bug-hunter");
  assert.equal(
    resolvePrimaryAgentSessionState({ enabled: true, selected: "bug-hunter" }).selection,
    "bug-hunter",
  );
});

test("retired disabled session state falls back to architect via the generic invalid-selection diagnostic", () => {
  const expected = { selection: DEFAULT_PRIMARY_AGENT, invalidSelected: "disabled" };
  assert.deepEqual(resolvePrimaryAgentSessionState(false), expected);
  assert.deepEqual(resolvePrimaryAgentSessionState({ enabled: false }), expected);
  assert.deepEqual(resolvePrimaryAgentSessionState({ selected: "disabled" }), expected);
});

test("latest session primary state wins over earlier compatibility entries", () => {
  assert.deepEqual(
    primaryAgentSelectionFromBranch([
      { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { enabled: false } },
      { type: "message", data: { selected: "product" } },
      {
        type: "custom",
        customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
        data: { selected: "product" },
      },
    ]),
    { selection: "product" },
  );
  assert.deepEqual(
    primaryAgentSelectionFromBranch([
      {
        type: "custom",
        customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
        data: { selected: "product" },
      },
      { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: {} },
    ]),
    {},
  );
});

test("Shift+Tab advances through each primary selection and wraps back to architect", () => {
  assert.equal(nextPrimaryAgentSelection("architect"), "rush");
  assert.equal(nextPrimaryAgentSelection("rush"), "product");
  assert.equal(nextPrimaryAgentSelection("product"), "bug-hunter");
  assert.equal(nextPrimaryAgentSelection("bug-hunter"), "architect");
});
