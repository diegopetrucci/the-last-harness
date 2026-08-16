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

test("effort facade registers effort and thinking commands with correct completions", () => {
  const pi = createPiHarness();
  const runtime = {
    activePrimaryAgentPrompt: () => ({ name: "architect", minThinking: "medium" }),
  };
  registerEffortCommand(pi, runtime);

  assert.ok(pi.commands.has("effort"), "effort command must be registered");
  assert.ok(pi.commands.has("thinking"), "thinking command must be registered");

  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.ok(Array.isArray(completions), "completions must be an array");
  assert.ok(
    completions.some((item) => item.value === "medium"),
    "completions must include medium",
  );
  assert.deepEqual(
    completions.map((item) => item.value),
    ["medium", "high", "xhigh", "max"],
    "completions must respect minThinking filter",
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
