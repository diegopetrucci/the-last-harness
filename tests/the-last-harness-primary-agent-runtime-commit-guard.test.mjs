import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createToolCallContext,
  registerRuntimeHarness,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const unattributedCommit = 'git commit -m "ship it"';

test("tool_call blocks an unattributed git commit when attribution is enabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    const blocked = await toolCall(
      { toolName: "bash", input: { command: unattributedCommit } },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /TLH attribution footer/);
  });
});

test("tool_call allows an unattributed git commit when attribution is disabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: unattributedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
  });
});
