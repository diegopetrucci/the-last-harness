/**
 * Tests for CLI launch-flag model/thinking precedence (tlh-nt2a).
 *
 * When `--model` or `--thinking` appear in process.argv at startup, TLH treats
 * the CLI-resolved values as session-only choices that win over persisted
 * primary-agent overrides and packaged defaults. The flag detection is kept
 * testable by injecting argv through options rather than mutating process.argv.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createPiHarness,
  registerTlhPrimaryAgentRuntime,
  rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Registers a runtime with the given argv and an architect primary agent that
 * has both applyModel and applyThinking enabled (rushLikePrimary).
 */
function registerCliPrecedenceHarness(argv, extraOptions = {}) {
  const pi = createPiHarness();
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    argv,
    primaryAgents,
    subagentMetadata: [],
    ...extraOptions,
  });
  return { pi, runtime };
}

/**
 * Minimal session context that includes a branch entry selecting "architect".
 */
function makeArchitectCtx(fixture, modelOverride, thinkingLevel) {
  const branch = [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ];
  return {
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => branch },
    ui: { notify() {} },
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "anthropic", id: "claude-opus-5" },
        { provider: "openai-codex", id: "gpt-5.6-luna" },
      ],
    },
    model: modelOverride,
    thinkingLevel,
  };
}

// ---------------------------------------------------------------------------
// Argument boundary regression tests
// ---------------------------------------------------------------------------

test("--model after -- (positional): does NOT activate model precedence on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-model-posarg-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // '--' ends flag parsing; '--model' here is a positional prompt, not a flag
    const argv = ["node", "pi", "--", "--model"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // Start on a non-default model; if --model were detected, it would be locked
    const startModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    pi.model = startModel;
    const ctx = makeArchitectCtx(fixture, startModel, "low");

    await runtime.applySessionStart(ctx, "startup");

    // Without a real --model flag, the bundled anthropic default should be applied
    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "'-- --model' (positional) must not activate model precedence",
    );
  });
});

test("--thinking as --append-system-prompt value: does NOT activate thinking precedence on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-think-asp-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // '--thinking' is the value of --append-system-prompt, not a flag itself
    const argv = ["node", "pi", "--append-system-prompt", "--thinking"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    const cliModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    // ctx.thinkingLevel is "xhigh" — if erroneously activated it would override bundled "low"
    const ctx = makeArchitectCtx(fixture, cliModel, "xhigh");

    await runtime.applySessionStart(ctx, "startup");

    // Without a real --thinking flag, the bundled anthropic effort "low" should apply
    assert.equal(
      pi.thinkingLevel,
      "low",
      "'--append-system-prompt --thinking' must not activate thinking precedence",
    );
  });
});

// ---------------------------------------------------------------------------
// --model flag: beats persisted primary-agent override
// ---------------------------------------------------------------------------

test("--model flag: CLI-resolved model wins over persisted primary-agent override on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-model-prec-", { cwd: true, test: t });

  // Persist a different model override in settings
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-opus-5" } } },
  };
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    const argv = ["node", "tlh", "--model", "anthropic/claude-sonnet-4-6"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // CLI resolved model: anthropic/claude-sonnet-4-6 (same as bundled preferred but different from persisted override)
    const cliModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    // Simulate Pi having resolved --model before session_start fires
    pi.model = cliModel;
    const ctx = makeArchitectCtx(fixture, cliModel, "low");

    await runtime.applySessionStart(ctx, "startup");

    // The CLI model must be kept, not replaced by the persisted override (claude-opus-5)
    assert.deepEqual(
      pi.model,
      cliModel,
      "--model flag should retain the CLI-resolved model, not apply the persisted override",
    );
  });
});

// ---------------------------------------------------------------------------
// --model flag: beats bundled packaged default
// ---------------------------------------------------------------------------

test("--model flag: CLI-resolved model wins over bundled packaged default on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-model-prec-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const argv = ["node", "tlh", "--model", "openai-codex/gpt-5.6-luna"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // CLI resolved model: openai-codex/gpt-5.6-luna (different from bundled anthropic/claude-sonnet-4-6)
    const cliModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    // Simulate Pi having resolved --model before session_start fires
    pi.model = cliModel;
    const ctx = makeArchitectCtx(fixture, cliModel, "medium");

    await runtime.applySessionStart(ctx, "startup");

    // The CLI model must be kept, not replaced by the bundled anthropic default
    assert.deepEqual(
      pi.model,
      cliModel,
      "--model flag should retain the CLI-resolved model, not replace it with the bundled default",
    );
  });
});

// ---------------------------------------------------------------------------
// --thinking flag: beats bundled packaged effort
// ---------------------------------------------------------------------------

test("--thinking flag: CLI thinking level wins over bundled packaged effort on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-think-prec-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // rushLikePrimary's bundled anthropic thinking is "low"; CLI requests "high"
    const argv = ["node", "tlh", "--thinking", "high"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    const cliModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    const ctx = makeArchitectCtx(fixture, cliModel, "high");

    await runtime.applySessionStart(ctx, "startup");

    // Bundled anthropic thinking is "low"; --thinking high should override it
    assert.equal(
      pi.thinkingLevel,
      "high",
      "--thinking flag should retain the CLI thinking level, not apply the bundled effort",
    );
  });
});

// ---------------------------------------------------------------------------
// No flags: default behavior is unchanged
// ---------------------------------------------------------------------------

test("no --model flag: bundled default is applied normally on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-no-flag-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // No --model in argv
    const argv = ["node", "tlh", "--mode", "rpc"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // Start on a different model so we can observe applyPrimaryModel switch
    const startModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const ctx = makeArchitectCtx(fixture, startModel, "low");

    await runtime.applySessionStart(ctx, "startup");

    // Without --model, the bundled anthropic preferred model should be applied
    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "without --model flag, bundled default should apply",
    );
  });
});

test("no --thinking flag: bundled effort is applied normally on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-no-think-flag-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // No --thinking in argv
    const argv = ["node", "tlh"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    const cliModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    // Start on a different thinking level to observe if it gets replaced
    const ctx = makeArchitectCtx(fixture, cliModel, "high");

    await runtime.applySessionStart(ctx, "startup");

    // Without --thinking, the bundled anthropic thinking "low" should apply
    assert.equal(
      pi.thinkingLevel,
      "low",
      "without --thinking flag, bundled effort default should apply",
    );
  });
});

// ---------------------------------------------------------------------------
// Non-startup reason: CLI flags are ignored
// ---------------------------------------------------------------------------

test("--model flag on non-startup session_start (/new): does NOT preserve CLI model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-new-sess-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const argv = ["node", "tlh", "--model", "openai-codex/gpt-5.6-luna"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // First session start: startup → CLI model is preserved
    const cliModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    // Simulate Pi having resolved --model before session_start fires
    pi.model = cliModel;
    const ctx1 = makeArchitectCtx(fixture, cliModel, "medium");
    await runtime.applySessionStart(ctx1, "startup");
    assert.deepEqual(pi.model, cliModel, "startup: CLI model retained");

    // Second session start: new → defaults should be reapplied
    const ctx2 = makeArchitectCtx(fixture, cliModel, "medium");
    await runtime.applySessionStart(ctx2, "new");

    // After /new, the bundled anthropic default should be applied (not the CLI model)
    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "after /new session, bundled default should be reapplied, not CLI model",
    );
  });
});

test("--model flag on non-startup session_start (reload): does NOT preserve CLI model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-reload-sess-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const argv = ["node", "tlh", "--model", "openai-codex/gpt-5.6-luna"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    // Startup
    const cliModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    // Simulate Pi having resolved --model before session_start fires
    pi.model = cliModel;
    const ctx1 = makeArchitectCtx(fixture, cliModel, "medium");
    await runtime.applySessionStart(ctx1, "startup");
    assert.deepEqual(pi.model, cliModel, "startup: CLI model retained");

    // Reload → defaults should be reapplied; CLI model not re-locked
    const ctx2 = makeArchitectCtx(fixture, cliModel, "medium");
    await runtime.applySessionStart(ctx2, "reload");

    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "after reload, bundled default should be reapplied",
    );
  });
});

// ---------------------------------------------------------------------------
// Both flags: model and thinking together
// ---------------------------------------------------------------------------

test("--model and --thinking flags together: both are retained on startup", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cli-both-flags-", { cwd: true, test: t });

  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-opus-5" } } },
  };
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    const argv = ["node", "tlh", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "xhigh"];
    const { pi, runtime } = registerCliPrecedenceHarness(argv);
    assert.ok(runtime);

    const cliModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
    // Simulate Pi having resolved --model before session_start fires
    pi.model = cliModel;
    const ctx = makeArchitectCtx(fixture, cliModel, "xhigh");

    await runtime.applySessionStart(ctx, "startup");

    assert.deepEqual(pi.model, cliModel, "--model flag should retain the CLI-resolved model");
    assert.equal(pi.thinkingLevel, "xhigh", "--thinking flag should retain the CLI thinking level");
  });
});
