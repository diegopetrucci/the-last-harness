import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createCommandContext,
  registerRuntimeHarness,
  selectablePrimaryAgents,
  writePrimaryConfig,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const INVALID_DISABLED_WARNING =
  'TLH primary agent "disabled" is not valid; falling back to architect. Available: architect, rush, product, bug-hunter.';

function sessionState(data) {
  return [{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data }];
}

async function statusFor(fixture, { settings, branch }) {
  const settingsPath = join(fixture.agent, "settings.json");
  if (settings !== undefined) {
    writePrimaryConfig(fixture.agent, settings);
  }
  const before = settings === undefined ? undefined : readFileSync(settingsPath, "utf8");
  const { pi, applySessionStart } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const command = pi.commands.get("switch-primary-agent");
  assert.ok(command, "registers /switch-primary-agent");
  const { ctx, notifications } = createCommandContext(branch ?? [], { cwd: fixture.cwd });
  await applySessionStart(ctx);
  await command.handler("status", ctx);
  const status = notifications.at(-1)?.message ?? "";
  const after = settings === undefined ? undefined : readFileSync(settingsPath, "utf8");
  return { notifications, status, unchanged: before === after };
}

const LEGACY_SETTINGS = [
  ["tlh.primaryAgent.selected disabled", { selected: "disabled" }],
  ["tlh.primaryAgent.enabled false", { enabled: false }],
  ["tlh.primaryAgent.enabled false with selected", { enabled: false, selected: "disabled" }],
];

for (const [label, settings] of LEGACY_SETTINGS) {
  test(`legacy ${label} falls back to architect with the invalid-selection warning and leaves settings untouched`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", {
      cwd: true,
      test: t,
    });
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const result = await statusFor(fixture, { settings });
      assert.ok(
        result.notifications.some((entry) => entry.message === INVALID_DISABLED_WARNING),
        `expected invalid-selection warning, got ${JSON.stringify(result.notifications)}`,
      );
      assert.match(result.status, /Primary agent: architect\./);
      assert.equal(result.unchanged, true, "settings.json must not be rewritten");
    });
  });
}

const LEGACY_SESSION_STATES = [
  ["boolean false", false],
  ["{ enabled: false }", { enabled: false }],
  ['{ selected: "disabled" }', { selected: "disabled" }],
];

for (const [label, data] of LEGACY_SESSION_STATES) {
  test(`legacy session state ${label} falls back to architect with the invalid-selection warning`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", {
      cwd: true,
      test: t,
    });
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writePrimaryConfig(fixture.agent, { selected: "rush" });
      const result = await statusFor(fixture, { branch: sessionState(data) });
      assert.ok(
        result.notifications.some((entry) => entry.message === INVALID_DISABLED_WARNING),
        `expected invalid-selection warning, got ${JSON.stringify(result.notifications)}`,
      );
      assert.match(result.status, /Primary agent: architect\./);
    });
  });
}

test("/switch-primary-agent rejects disabled for the session and as a persistent default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const settingsPath = join(fixture.agent, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify({ tlh: { primaryAgent: {} } }, null, 2)}\n`);
    const { pi } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const command = pi.commands.get("switch-primary-agent");
    assert.ok(command, "registers /switch-primary-agent");

    for (const args of ["disabled", "default disabled"]) {
      const { ctx, notifications } = createCommandContext([], { cwd: fixture.cwd });
      await command.handler(args, ctx);
      const last = notifications.at(-1);
      assert.equal(last?.type, "error", args);
      assert.match(last?.message ?? "", /^Usage: \/switch-primary-agent /, args);
      assert.doesNotMatch(last?.message ?? "", /disabled/, args);
    }
    assert.equal(
      readFileSync(settingsPath, "utf8"),
      `${JSON.stringify({ tlh: { primaryAgent: {} } }, null, 2)}\n`,
      "rejected commands must not write settings",
    );

    for (const prefix of ["d", "default d"]) {
      const values = ((await command.getArgumentCompletions(prefix)) ?? []).map((c) => c.value);
      assert.equal(
        values.some((value) => value.includes("disabled")),
        false,
        prefix,
      );
    }
  });
});

test("Shift+Tab cycles through every primary and wraps without a disabled stop", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const shortcut = [...pi.shortcuts.values()][0];
    assert.ok(shortcut, "registers the primary-agent cycle shortcut");
    assert.doesNotMatch(shortcut.description ?? shortcut.options?.description ?? "", /disabled/);
    const branch = [];
    pi.appendEntry = (customType, data) => branch.push({ type: "custom", customType, data });
    const { ctx, notifications } = createCommandContext(branch, { cwd: fixture.cwd });
    await applySessionStart(ctx);
    const handler = shortcut.handler ?? shortcut.options?.handler;
    for (let i = 0; i < 5; i += 1) {
      await handler(ctx);
    }
    const labels = notifications
      .map((entry) => /switched TLH primary agent to (\S+) for/.exec(entry.message)?.[1])
      .filter(Boolean);
    assert.deepEqual(labels, ["rush", "product", "bug-hunter", "architect", "rush"]);
  });
});
