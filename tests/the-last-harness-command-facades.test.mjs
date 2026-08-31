import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { registerToggleTlhGitAttributionCommand } = await jiti.import(
  "../extensions/the-last-harness/attribution.ts",
);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");
const { registerExperimentalCommand, DELTA_FOLLOW_UP_REVIEWS_FEATURE } = await jiti.import(
  "../extensions/the-last-harness/experimental.ts",
);
const { registerUsageCommand } = await jiti.import(
  "../extensions/the-last-harness/usage-limits.ts",
);

function createPiHarness() {
  const commands = new Map();
  return {
    commands,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "medium",
    setThinkingLevel() {},
    events: { emit() {} },
  };
}

test("attribution facade registers the toggle-tlh-git-attribution command", () => {
  const pi = createPiHarness();
  registerToggleTlhGitAttributionCommand(pi);
  const command = pi.commands.get("toggle-tlh-git-attribution");
  assert.equal(typeof command?.handler, "function");
  assert.equal(command?.description, "Toggle TLH git commit attribution");
});

test("effort facade registers only the alias with native level completions", () => {
  const pi = createPiHarness();
  const nativeThinkingCommand = { native: true };
  pi.commands.set("thinking", nativeThinkingCommand);
  registerEffortCommand(pi, { activePrimaryAgentPrompt: () => undefined });

  assert.ok(pi.commands.has("effort"), "effort command must be registered");
  assert.equal(
    pi.commands.get("thinking"),
    nativeThinkingCommand,
    "native thinking must remain untouched",
  );

  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.deepEqual(
    completions.map((item) => item.value),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "completions must expose all native thinking levels",
  );
});

test("experimental facade registers experimental command with correct completions", () => {
  const pi = createPiHarness();
  registerExperimentalCommand(pi);
  const command = pi.commands.get("experimental");
  assert.equal(typeof command?.handler, "function");
  assert.ok(
    command
      .getArgumentCompletions(`toggle ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`)
      ?.some((item) => item.value === `toggle ${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`),
    "completions must include toggle for the delta-follow-up-reviews feature",
  );
});

test("usage facade registers usage command with correct completions", () => {
  const pi = createPiHarness();
  registerUsageCommand(pi);
  const command = pi.commands.get("usage");
  assert.equal(typeof command?.handler, "function");
  assert.ok(
    command.getArgumentCompletions("weekly")?.some((item) => item.value === "weekly toggle"),
    "completions must include weekly toggle",
  );
});
