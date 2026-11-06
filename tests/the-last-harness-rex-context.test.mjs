import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createToolCallContext,
  makeStructuredPromptEvent,
  registerRuntimeHarness,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { __testing, getRexSessionContext } = await jiti.import(
  "../extensions/the-last-harness/rex-context.ts",
);

// The runtime resolves "./rex-context.js", which jiti may load as a separate instance from the .ts.
const { __testing: generatedTesting } = await jiti.import(
  "../extensions/the-last-harness/rex-context.js",
);

const EXPECTED_ARGS = ["__internal", "session-start", "--agent", "pi", "--autostart=false"];

test("rex context runs once with exact args and returns trimmed output", async (t) => {
  t.after(() => __testing.resetForTests());
  const calls = [];
  __testing.setRunnerForTests((command, args) => {
    calls.push({ command, args });
    return "\n  rex context  \n";
  });
  await withEnv({ REX_SESSION: "abc" }, () => {
    assert.equal(getRexSessionContext(), "rex context");
    assert.equal(getRexSessionContext(), "rex context");
  });
  assert.deepEqual(calls, [{ command: "rex", args: EXPECTED_ARGS }]);
});

test("rex context never runs when REX_SESSION is unset or empty", async (t) => {
  t.after(() => __testing.resetForTests());
  let calls = 0;
  __testing.setRunnerForTests(() => {
    calls += 1;
    return "x";
  });
  await withEnv({ REX_SESSION: undefined }, () => assert.equal(getRexSessionContext(), undefined));
  await withEnv({ REX_SESSION: "" }, () => assert.equal(getRexSessionContext(), undefined));
  assert.equal(calls, 0);
});

test("rex context failure and empty output are silent and cached", async (t) => {
  t.after(() => __testing.resetForTests());
  for (const runner of [
    () => {
      throw new Error("ENOENT");
    },
    () => "  \n",
  ]) {
    let calls = 0;
    __testing.setRunnerForTests((...args) => {
      calls += 1;
      return runner(...args);
    });
    await withEnv({ REX_SESSION: "abc" }, () => {
      assert.equal(getRexSessionContext(), undefined);
      assert.equal(getRexSessionContext(), undefined);
    });
    assert.equal(calls, 1);
  }
});

const SENTINEL = "REX_SENTINEL_CONTEXT_7f3a";

test("rex context is appended to the primary prompt once and never to child prompts", async (t) => {
  t.after(() => {
    __testing.resetForTests();
    generatedTesting.resetForTests();
  });
  const fixture = createIsolatedProfileFixture("tlh-rex-prompt-", { cwd: true, test: t });
  let calls = 0;
  const runner = () => {
    calls += 1;
    return SENTINEL;
  };
  __testing.setRunnerForTests(runner);
  generatedTesting.setRunnerForTests(runner);
  const base = { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined };

  await withEnv({ ...base, REX_SESSION: "abc" }, async () => {
    const child = registerRuntimeHarness({
      env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "developer" },
    });
    const childEvent = await child.beforeAgentStart(
      makeStructuredPromptEvent("base prompt", fixture.cwd),
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(childEvent.systemPrompt.includes(SENTINEL), false);
    assert.equal(calls, 0);

    const primary = registerRuntimeHarness();
    const primaryEvent = await primary.beforeAgentStart(
      makeStructuredPromptEvent("base prompt", fixture.cwd),
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(primaryEvent.systemPrompt.split(SENTINEL).length - 1, 1);
    assert.equal(calls, 1);
  });
});
