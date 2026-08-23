import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  computeModelEffortDrift,
  readReconcileState,
  writeReconcileState,
  updateReconcileAcknowledgedSnapshot,
  tlhReconcileStatePath,
} = await jiti.import("../extensions/the-last-harness/model-effort-reconcile.ts");
const { selectProviderAwareAgentDefaults, parseProviderModelReference, splitKnownThinkingSuffix } =
  await jiti.import("../extensions/the-last-harness/model-defaults.ts");

/**
 * Mirrors the module's provider-filtered packaged catalog so the parity test can
 * call the production selector with the same restricted candidate set that
 * `resolvePackagedDefaults` uses internally.
 *
 * Filters to exact provider equality (not family). When `provider` is `undefined`
 * the result is always empty, matching the no-provider behaviour in the module.
 */
function packagedCandidateModelsForProvider(agent, provider) {
  if (provider === undefined) {
    return [];
  }
  const seen = new Map();
  for (const raw of [
    agent.model,
    ...(agent.tlhOpenaiModels ?? []),
    ...(agent.tlhAnthropicModels ?? []),
  ]) {
    const parsed = parseProviderModelReference(splitKnownThinkingSuffix(raw).baseModel);
    if (!parsed) continue;
    if (parsed.provider !== provider) continue;
    const key = `${parsed.provider}/${parsed.id}`;
    if (!seen.has(key)) seen.set(key, parsed);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Shared agent fixtures (production types — drift is caught if shapes change)
// ---------------------------------------------------------------------------

/** @type {import("../extensions/the-last-harness/types.ts").AgentPrompt} */
const architectAgent = {
  name: "architect",
  description: "Primary architect agent",
  model: "anthropic/claude-opus-5",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  tlhAnthropicThinking: "high",
  tlhOpenaiThinking: "high",
  tools: [],
  systemPrompt: "",
  filePath: "/fake/agents/primary/architect.md",
};

/** @type {import("../extensions/the-last-harness/types.ts").AgentPrompt} */
const rushAgent = {
  name: "rush",
  description: "Rush primary agent",
  model: "anthropic/claude-sonnet-4-6",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  thinking: "low",
  tools: [],
  systemPrompt: "",
  filePath: "/fake/agents/primary/rush.md",
};

/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
const developerSubagent = {
  name: "developer",
  description: "Developer subagent",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  tlhAnthropicThinking: "medium",
  tlhOpenaiThinking: "max",
};

/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
const codeReviewerSubagent = {
  name: "code-reviewer",
  description: "Code reviewer subagent",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  preferOppositeProvider: true,
};

/**
 * Mirrors agents/primary/rush.md, which sets preferCurrentOpenaiModel alongside an
 * anthropic `model`. Kept separate from rushAgent so the plain fallback tests stay
 * focused on generic thinking resolution.
 * @type {import("../extensions/the-last-harness/types.ts").AgentPrompt}
 */
const rushOpenaiAgent = {
  name: "rush-openai",
  description: "Rush primary agent with preferCurrentOpenaiModel",
  model: "anthropic/claude-sonnet-4-6",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  preferCurrentOpenaiModel: true,
  thinking: "low",
  tools: [],
  systemPrompt: "",
  filePath: "/fake/agents/primary/rush-openai.md",
};

const primaryAgents = new Map([
  ["architect", architectAgent],
  ["rush", rushAgent],
  ["rush-openai", rushOpenaiAgent],
]);

const subagentMetadata = [developerSubagent, codeReviewerSubagent];

// ---------------------------------------------------------------------------
// computeModelEffortDrift
// ---------------------------------------------------------------------------

test("no overrides → empty drift", () => {
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, {});
  assert.deepEqual(result, []);
});

test("empty agentOverrides object → empty drift", () => {
  const settings = { subagents: { agentOverrides: {} } };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
  assert.deepEqual(result, []);
});

test("subagent override with no model or thinking fields → skipped", () => {
  const settings = { subagents: { agentOverrides: { developer: {} } } };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
  assert.deepEqual(result, []);
});

// --- Primary agent overrides ---

test("primary override drift — model override with anthropic provider", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.role, "primary");
  assert.equal(entry.name, "architect");
  assert.deepEqual(entry.override, { model: "anthropic/claude-sonnet-4-6" });
  assert.equal(entry.packaged.model, "anthropic/claude-opus-5");
  assert.equal(entry.packaged.thinking, "high");
  assert.equal(entry.packagedDefaultsChanged, false);
});

test("primary override drift — openai-codex session reports the openai packaged default", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.6-luna" } } },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
  );
  assert.equal(entry.role, "primary");
  assert.equal(entry.name, "architect");
  // resolvePackagedDefaults filters candidates to provider "openai-codex" only, so the
  // top-level `model: anthropic/claude-opus-5` is excluded and the selector picks the
  // openai-codex packaged model instead. This is the fix for the bug where an
  // openai-codex session reported the Anthropic model as the packaged default.
  assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-sol");
  // Effort follows the resolved model's provider.
  assert.equal(entry.packaged.thinking, "high");
});

test("primary override drift — unknown agent name produces entry with empty packaged", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { "product-unknown": "anthropic/claude-opus-5" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.role, "primary");
  assert.equal(entry.name, "product-unknown");
  assert.equal(entry.packaged.model, undefined);
  assert.equal(entry.packaged.thinking, undefined);
});

test("primary override drift — empty or invalid override values are skipped", () => {
  // Only non-empty string values are valid primary overrides
  const settings = {
    tlh: {
      primaryAgent: {
        modelOverrides: {
          architect: "",
          rush: "anthropic/claude-opus-5",
        },
      },
    },
  };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "rush");
});

// --- Subagent overrides ---

test("subagent model-only drift with anthropic provider", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.role, "subagent");
  assert.equal(entry.name, "developer");
  assert.deepEqual(entry.override, { model: "anthropic/claude-opus-5" });
  assert.equal(entry.packaged.model, "anthropic/claude-sonnet-4-6");
  assert.equal(entry.packaged.thinking, "medium");
  assert.equal(entry.packagedDefaultsChanged, false);
});

test("subagent thinking-only drift with anthropic provider", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { thinking: "high" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.role, "subagent");
  assert.equal(entry.name, "developer");
  assert.deepEqual(entry.override, { thinking: "high" });
  assert.equal(entry.packaged.model, "anthropic/claude-sonnet-4-6");
  assert.equal(entry.packaged.thinking, "medium");
});

test("subagent model-only drift with openai provider", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
  );
  assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-luna");
  assert.equal(entry.packaged.thinking, "max");
});

test("subagent model=false override is included in drift", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: false } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.role, "subagent");
  assert.deepEqual(entry.override, { model: false });
});

test("subagent thinking=false override is included in drift", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { thinking: false } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
  assert.deepEqual(entry.override, { thinking: false });
});

test("subagent model+thinking override includes both fields", () => {
  const settings = {
    subagents: {
      agentOverrides: { developer: { model: "anthropic/claude-opus-5", thinking: "high" } },
    },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.deepEqual(entry.override, { model: "anthropic/claude-opus-5", thinking: "high" });
});

test("subagent with no matching metadata produces entry with empty packaged", () => {
  const settings = {
    subagents: { agentOverrides: { "unknown-agent": { model: "anthropic/claude-opus-5" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(entry.name, "unknown-agent");
  assert.equal(entry.packaged.model, undefined);
  assert.equal(entry.packaged.thinking, undefined);
});

test("multiple overrides produce one entry per overridden role", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
    subagents: {
      agentOverrides: {
        developer: { thinking: "high" },
        "code-reviewer": { model: "anthropic/claude-sonnet-4-6" },
      },
    },
  };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.equal(result.length, 3);
  const roles = result.map((e) => `${e.role}:${e.name}`);
  assert.ok(roles.includes("primary:architect"));
  assert.ok(roles.includes("subagent:developer"));
  assert.ok(roles.includes("subagent:code-reviewer"));
});

// --- Provider-aware defaults: no provider → empty packaged, comparison deferred ---

test("subagent packaged defaults with no provider return undefined model", () => {
  // When no session provider is given, resolvePackagedDefaults filters candidates to
  // exact provider `undefined`, which always yields an empty list. No model can be
  // selected from an empty list, so both model and thinking are undefined.
  // Startup and /reconcile defer all comparison when no provider is known (ts-7w6o).
  const settings = {
    subagents: { agentOverrides: { developer: { thinking: "high" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
  assert.equal(entry.packaged.model, undefined);
  assert.equal(entry.packaged.thinking, undefined);
});

// --- Regression guards: packaged defaults must honour the frontmatter selection
// flags. A private re-implementation of the selector previously ignored these and
// reported (and would have Reset to) the wrong model. ---

test("preferOppositeProvider subagent resolves to same-provider fallback in provider-P-only hypothetical", () => {
  // Irreducible limitation: resolvePackagedDefaults filters candidates to exactly
  // provider P. With only provider-P models in the list, selectOppositeProviderPreferredAgentModel
  // cannot find the opposite-provider model, so it returns undefined and the standard
  // selector falls back to the same-provider model. This means the displayed packaged
  // default for preferOppositeProvider roles (code-reviewer, contrarian, oracle) may
  // differ from what a real dual-provider Reset produces in a live session where the
  // opposite-provider model is actually available. Consulting the live registry would
  // introduce spurious drift notices on availability changes, so this tradeoff is accepted.
  const settings = {
    subagents: { agentOverrides: { "code-reviewer": { thinking: "high" } } },
  };
  // On anthropic: only anthropic candidates → opposite-provider (openai-codex) not found → same-provider fallback.
  const [onAnthropic] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
  );
  assert.equal(onAnthropic.packaged.model, "anthropic/claude-opus-5");

  // On openai-codex: only openai-codex candidates → opposite-provider (anthropic) not found → same-provider fallback.
  const [onOpenai] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
  );
  assert.equal(onOpenai.packaged.model, "openai-codex/gpt-5.6-sol");
});

test("preferCurrentOpenaiModel primary reports the current-provider packaged default", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { "rush-openai": "anthropic/claude-opus-5" } } },
  };
  // rush-openai mirrors agents/primary/rush.md: preferCurrentOpenaiModel with an
  // anthropic `model`. On an openai session the openai candidate must win.
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
  );
  assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-luna");
});

test("packaged defaults agree with selectProviderAwareAgentDefaults across a fixture table", () => {
  // Pins this module to the production selector. If a private re-implementation is
  // ever reintroduced and diverges on any packaged agent × provider pair, this fails.
  //
  // The fixture uses the same provider-filtered candidate set that resolvePackagedDefaults
  // uses internally: only models whose provider is exactly P are offered to the selector.
  // For undefined provider the filtered list is empty, so no model is resolved.
  const providers = [undefined, "anthropic", "openai-codex", "openai", "unknown-provider"];
  const agents = [...primaryAgents.values(), ...subagentMetadata, rushOpenaiAgent];

  for (const agent of agents) {
    for (const provider of providers) {
      const candidates = packagedCandidateModelsForProvider(agent, provider);
      const expected = selectProviderAwareAgentDefaults(agent, candidates, provider);
      const settings = { subagents: { agentOverrides: { [agent.name]: { thinking: "high" } } } };
      const [entry] = computeModelEffortDrift(new Map(), [agent], settings, provider);
      const label = `${agent.name} @ ${provider ?? "no-provider"}`;
      assert.equal(
        entry.packaged.model,
        expected.model ? `${expected.model.provider}/${expected.model.id}` : undefined,
        `model mismatch for ${label}`,
      );
      assert.equal(entry.packaged.thinking, expected.thinking, `thinking mismatch for ${label}`);
    }
  }
});

test("rush primary agent falls back to generic thinking when provider is unknown", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { rush: "anthropic/claude-opus-5" } } },
  };
  // rush has generic thinking: "low" and no provider-specific thinking fields
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "unknown-provider",
  );
  assert.equal(entry.packaged.thinking, "low");
});

// --- packagedDefaultsChanged detection ---

test("no prior acknowledgment → packagedDefaultsChanged = false", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    {},
  );
  assert.equal(entry.packagedDefaultsChanged, false);
});

test("acknowledged snapshot matches current packaged for active provider → packagedDefaultsChanged = false", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  // byProvider-keyed snapshot matching the current packaged defaults.
  const acknowledgedSnapshot = {
    developer: {
      byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(entry.packagedDefaultsChanged, false);
});

test("acknowledged snapshot differs from current packaged for active provider → packagedDefaultsChanged = true", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  // Snapshot says packaged model was claude-opus-5 (old default), but current packaged is claude-sonnet-4-6.
  const acknowledgedSnapshot = {
    developer: {
      byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "medium" } },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(entry.packagedDefaultsChanged, true);
});

test("acknowledged snapshot thinking differs for active provider → packagedDefaultsChanged = true", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { thinking: "high" } } },
  };
  // Snapshot says packaged thinking was "high", but current packaged is "medium".
  const acknowledgedSnapshot = {
    developer: {
      byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "high" } },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(entry.packagedDefaultsChanged, true);
});

test("primary agent: snapshot differs for active provider → packagedDefaultsChanged = true", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
  };
  // Snapshot says packaged model was claude-sonnet-4-6, but current packaged is claude-opus-5.
  const acknowledgedSnapshot = {
    architect: {
      byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "high" } },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(entry.packagedDefaultsChanged, true);
});

test("primary agent: snapshot matches current packaged for active provider → packagedDefaultsChanged = false", () => {
  const settings = {
    tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
  };
  const acknowledgedSnapshot = {
    architect: {
      byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(entry.packagedDefaultsChanged, false);
});

// --- Cross-provider regression: acknowledging under one provider must not fire a
// notice when the session switches to another provider ---

test("cross-provider: acknowledged under anthropic, no prior entry for openai → packagedDefaultsChanged = false", () => {
  // Regression guard: switching provider must never misreport a packaged-default change.
  const settings = {
    subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
  };
  // User acknowledged under anthropic; there is no entry for openai-codex yet.
  const acknowledgedSnapshot = {
    developer: {
      byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
    },
  };
  // Launch under openai-codex: no prior acknowledgment for that provider → false.
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
    acknowledgedSnapshot,
  );
  assert.equal(
    entry.packagedDefaultsChanged,
    false,
    "provider switch must not fire a false notice",
  );
});

test("cross-provider: acknowledged under openai, genuine packaged-default change for anthropic → packagedDefaultsChanged = false (different provider)", () => {
  // Regression guard: a change to a provider the user never uses must not fire a notice
  // on a session running a different provider.
  const settings = {
    subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
  };
  // There is an anthropic acknowledgment with a stale model, but the active session
  // is openai-codex which has no acknowledgment entry.
  const acknowledgedSnapshot = {
    developer: { byProvider: { anthropic: { model: "anthropic/old-model", thinking: "low" } } },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "openai-codex",
    acknowledgedSnapshot,
  );
  assert.equal(
    entry.packagedDefaultsChanged,
    false,
    "stale acknowledgment for another provider must not fire",
  );
});

test("cross-provider: acknowledged under both providers, genuine change for active provider → packagedDefaultsChanged = true", () => {
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  // Both providers have acknowledgments; active is anthropic, whose entry is now stale.
  const acknowledgedSnapshot = {
    developer: {
      byProvider: {
        anthropic: { model: "anthropic/stale-model", thinking: "medium" },
        "openai-codex": { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
      },
    },
  };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    acknowledgedSnapshot,
  );
  assert.equal(
    entry.packagedDefaultsChanged,
    true,
    "stale acknowledgment for the active provider must fire",
  );
});

// --- Entries without byProvider are dropped, not compared ---

test("snapshot entry without byProvider → packagedDefaultsChanged = false, no crash", () => {
  // Entries that have no byProvider field are ignored by the sanitizer and never
  // reach the comparator, so they cannot produce a spurious drift notice.
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  // Entry has no byProvider — sanitizer drops it; no comparison is made.
  const noByProviderSnapshot = { developer: {} };
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    "anthropic",
    noByProviderSnapshot,
  );
  assert.equal(
    entry.packagedDefaultsChanged,
    false,
    "entry without byProvider must not fire a notice",
  );
});

// --- Unknown provider: comparison is deferred, spurious defaults-changed is unreachable ---

test("unknown provider with existing snapshot → packagedDefaultsChanged = false (comparison deferred)", () => {
  // Pins the hazard ts-7w6o closes: when provider is unknown, resolvePackagedDefaults
  // returns no model (empty candidate list). Without defer semantics, a snapshot entry
  // whose model differs from undefined would fire packagedDefaultsChanged = true spuriously.
  // With defer semantics the comparison is skipped entirely, making the hazard unreachable.
  const settings = {
    subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
  };
  // Snapshot has a non-undefined model value that would mismatch the empty packaged
  // defaults returned for an unknown provider if the comparison were ever reached.
  const snapshot = {
    developer: {
      byProvider: { "some-provider": { model: "anthropic/some-old-model", thinking: "high" } },
    },
  };
  // Pass undefined provider — comparison must be deferred, not executed.
  const [entry] = computeModelEffortDrift(
    primaryAgents,
    subagentMetadata,
    settings,
    undefined,
    snapshot,
  );
  assert.equal(
    entry.packagedDefaultsChanged,
    false,
    "comparison must be deferred with unknown provider",
  );
  // Packaged defaults are also empty with no provider — confirm no confusion.
  assert.equal(entry.packaged.model, undefined);
  assert.equal(entry.packaged.thinking, undefined);
});

// ---------------------------------------------------------------------------
// Reconcile state round-trip
// ---------------------------------------------------------------------------

test("readReconcileState returns empty object when outside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  // No PI_CODING_AGENT_DIR set → tlhReconcileStatePath returns undefined
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    const state = readReconcileState();
    assert.deepEqual(state, {});
  });
});

test("writeReconcileState is a no-op when outside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    // Should not throw; just silently skips.
    writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
    const statePath = tlhReconcileStatePath();
    assert.equal(statePath, undefined);
  });
});

test("writeReconcileState and readReconcileState round-trip inside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const state = {
      acknowledgedSnapshot: {
        architect: {
          byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } },
        },
        developer: {
          byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
        },
      },
      lastDecisionAt: "2026-08-10T16:31:00.000Z",
    };
    writeReconcileState(state);

    const statePath = tlhReconcileStatePath();
    assert.ok(statePath, "state path should be defined inside isolated profile");
    assert.ok(existsSync(statePath), "state file should exist after write");

    const read = readReconcileState();
    assert.deepEqual(read, state);
  });
});

test("readReconcileState returns empty object for invalid JSON", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, "not-json", { encoding: "utf8", mode: 0o600 });
    const read = readReconcileState();
    assert.deepEqual(read, {});
  });
});

test("readReconcileState returns empty object for non-object JSON", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, '"just a string"', { encoding: "utf8", mode: 0o600 });
    const read = readReconcileState();
    assert.deepEqual(read, {});
  });
});

test("writeReconcileState stores file with mode 600", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
    const statePath = tlhReconcileStatePath();
    const { lstatSync } = await import("node:fs");
    const stat = lstatSync(statePath);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

// ---------------------------------------------------------------------------
// updateReconcileAcknowledgedSnapshot
// ---------------------------------------------------------------------------

test("updateReconcileAcknowledgedSnapshot merges into existing state", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Write initial state with one byProvider entry.
    writeReconcileState({
      acknowledgedSnapshot: {
        architect: {
          byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } },
        },
      },
    });

    // Update with a second entry and a lastDecisionAt.
    updateReconcileAcknowledgedSnapshot(
      {
        developer: {
          byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
        },
      },
      "2026-08-10T16:31:00.000Z",
    );

    const state = readReconcileState();
    assert.deepEqual(state.acknowledgedSnapshot?.architect, {
      byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } },
    });
    assert.deepEqual(state.acknowledgedSnapshot?.developer, {
      byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
    });
    assert.equal(state.lastDecisionAt, "2026-08-10T16:31:00.000Z");
  });
});

test("updateReconcileAcknowledgedSnapshot overwrites existing snapshot for same role", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeReconcileState({
      acknowledgedSnapshot: {
        architect: {
          byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } },
        },
      },
    });

    updateReconcileAcknowledgedSnapshot({
      architect: {
        byProvider: { "openai-codex": { model: "openai-codex/gpt-5.6-sol", thinking: "high" } },
      },
    });

    const state = readReconcileState();
    // deep-merge: both provider entries should be present
    assert.ok(
      state.acknowledgedSnapshot?.architect?.byProvider?.anthropic,
      "prior anthropic entry must be preserved",
    );
    assert.equal(
      state.acknowledgedSnapshot?.architect?.byProvider?.["openai-codex"]?.model,
      "openai-codex/gpt-5.6-sol",
    );
  });
});

test("updateReconcileAcknowledgedSnapshot without lastDecisionAt preserves existing one", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
    updateReconcileAcknowledgedSnapshot({
      developer: { byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    const state = readReconcileState();
    assert.equal(state.lastDecisionAt, "2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Boundary validation: malformed subagent override values
// ---------------------------------------------------------------------------

test("malformed subagent override: model=null is treated as absent and entry is skipped", () => {
  // null is not a valid override value — the entry should be omitted, not displayed.
  const settings = { subagents: { agentOverrides: { developer: { model: null } } } };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.deepEqual(result, [], "null model must not produce a drift entry");
});

test("malformed subagent override: model=42 is stripped, valid thinking is preserved", () => {
  // A number model is invalid; if thinking is also provided and valid, it should still show.
  const settings = {
    subagents: { agentOverrides: { developer: { model: 42, thinking: "high" } } },
  };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.ok(entry, "entry with valid thinking must be produced even when model is invalid");
  assert.equal(entry.override.model, undefined, "invalid model must be stripped from override");
  assert.equal(entry.override.thinking, "high", "valid thinking must survive");
});

test("malformed subagent override: thinking=null is treated as absent and entry is skipped when model is also absent", () => {
  const settings = { subagents: { agentOverrides: { developer: { thinking: null } } } };
  const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.deepEqual(result, [], "null thinking with no other override must produce no drift entry");
});

test("malformed subagent override: model=false still counts as a valid override", () => {
  // false is a legitimate disable value for subagent model overrides.
  const settings = { subagents: { agentOverrides: { developer: { model: false } } } };
  const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
  assert.ok(entry, "model=false must produce a drift entry");
  assert.deepEqual(entry.override, { model: false });
});

// ---------------------------------------------------------------------------
// Boundary validation: malformed reconcile-state entries
// ---------------------------------------------------------------------------

test("readReconcileState: null acknowledgedSnapshot entry is silently dropped", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    // Manually write a state file with a null snapshot entry.
    writeFileSync(
      statePath,
      JSON.stringify({
        acknowledgedSnapshot: {
          developer: null,
          architect: { byProvider: { anthropic: { model: "m", thinking: "high" } } },
        },
        lastDecisionAt: "2026-01-01T00:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const state = readReconcileState();
    // null entry must be dropped; the valid entry must survive.
    assert.equal(state.acknowledgedSnapshot?.developer, undefined, "null entry must be dropped");
    assert.ok(state.acknowledgedSnapshot?.architect, "valid entry must survive");
    assert.equal(
      state.lastDecisionAt,
      "2026-01-01T00:00:00.000Z",
      "other top-level fields preserved",
    );
  });
});

test("readReconcileState: null byProvider entry is dropped to prevent downstream crash", async (t) => {
  // Regression: providerEntry.model would throw TypeError if providerEntry were null.
  // Verifies the sanitizer prevents that crash path.
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        acknowledgedSnapshot: {
          developer: { byProvider: { anthropic: null, "openai-codex": { model: "m" } } },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const state = readReconcileState();
    // The null provider entry must be gone; the valid one must remain.
    assert.equal(
      state.acknowledgedSnapshot?.developer?.byProvider?.anthropic,
      undefined,
      "null byProvider entry must be dropped",
    );
    assert.ok(
      state.acknowledgedSnapshot?.developer?.byProvider?.["openai-codex"],
      "valid byProvider entry must survive",
    );
    // Accessing .model on the sanitized state must not throw.
    const entry = state.acknowledgedSnapshot?.developer?.byProvider?.["openai-codex"];
    assert.equal(entry?.model, "m");
  });
});

test("readReconcileState: invalid model/thinking types in byProvider are stripped", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        acknowledgedSnapshot: {
          developer: {
            byProvider: { anthropic: { model: 42, thinking: null, extra: "preserved" } },
          },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const state = readReconcileState();
    const ack = state.acknowledgedSnapshot?.developer?.byProvider?.anthropic;
    assert.ok(ack, "ack entry must exist");
    assert.equal(ack.model, undefined, "invalid model type must be stripped");
    assert.equal(ack.thinking, undefined, "invalid thinking type must be stripped");
    // Unknown extra fields within the entry must be preserved.
    assert.equal(ack.extra, "preserved", "unknown fields must be preserved");
  });
});

test("readReconcileState: malformed state does not crash computeModelEffortDrift", async (t) => {
  // End-to-end guard: a state file with null byProvider entries must not throw
  // when passed to the drift comparator (which accesses providerEntry.model).
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const statePath = tlhReconcileStatePath();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        acknowledgedSnapshot: {
          developer: { byProvider: { anthropic: null } },
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const state = readReconcileState();
    const settings = {
      subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
    };
    // Must not throw.
    assert.doesNotThrow(() => {
      computeModelEffortDrift(
        primaryAgents,
        subagentMetadata,
        settings,
        "anthropic",
        state.acknowledgedSnapshot,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence outcome: writeReconcileState and updateReconcileAcknowledgedSnapshot
// ---------------------------------------------------------------------------

test("writeReconcileState returns false when outside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    const result = writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(result, false, "writeReconcileState must return false outside isolated profile");
  });
});

test("writeReconcileState returns true when inside isolated profile and write succeeds", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const result = writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(result, true, "writeReconcileState must return true on successful write");
  });
});

test("updateReconcileAcknowledgedSnapshot returns false when outside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    const result = updateReconcileAcknowledgedSnapshot({
      developer: { byProvider: { anthropic: { model: "m" } } },
    });
    assert.equal(
      result,
      false,
      "updateReconcileAcknowledgedSnapshot must return false outside isolated profile",
    );
  });
});

test("updateReconcileAcknowledgedSnapshot returns true when inside isolated profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const result = updateReconcileAcknowledgedSnapshot(
      { developer: { byProvider: { anthropic: { model: "m" } } } },
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(result, true, "updateReconcileAcknowledgedSnapshot must return true on success");
  });
});

// ---------------------------------------------------------------------------
// Gap 1: Empty-string provider key is dropped by sanitize (ts-8k8z)
// ---------------------------------------------------------------------------

test("sanitize: empty-string provider key in byProvider is dropped and does not produce drift", async (t) => {
  // Regression guard: a byProvider[""] entry written by a user-edited settings.json
  // must be dropped by sanitizeAcknowledgedSnapshot so computeModelEffortDrift never
  // compares against it. Before the fix, the empty-string entry would survive
  // sanitization and could be compared, producing a spurious drift notice.
  const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, () => {
    // Write a reconcile-state with an empty-string provider key alongside a real one.
    writeReconcileState({
      acknowledgedSnapshot: {
        architect: {
          byProvider: {
            "": { model: "anthropic/claude-opus-4-5", thinking: "high" },
            anthropic: { model: "anthropic/claude-opus-5", thinking: "high" },
          },
        },
      },
    });

    const state = readReconcileState();

    // The empty-string key must be absent after sanitize.
    const byProvider = state.acknowledgedSnapshot?.architect?.byProvider;
    assert.ok(byProvider !== undefined, "byProvider must be present after sanitize");
    assert.equal(
      byProvider[""],
      undefined,
      "empty-string provider key must be dropped by sanitize (ts-7w6o applied consistently)",
    );

    // The real provider key must be preserved.
    assert.ok(
      byProvider.anthropic !== undefined,
      "real provider key must be preserved by sanitize",
    );

    // Drift for the architect with anthropic provider must not use the empty-key entry.
    const drift = computeModelEffortDrift(
      new Map([
        [
          "architect",
          {
            name: "architect",
            model: "anthropic/claude-opus-5",
            tlhAnthropicModels: ["anthropic/claude-opus-5"],
            tlhAnthropicThinking: "high",
            tools: [],
            systemPrompt: "",
            filePath: "/fake/architect.md",
          },
        ],
      ]),
      [],
      { tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } } },
      "",
      state.acknowledgedSnapshot,
    );

    // With empty-string provider, drift comparison is deferred: packagedDefaultsChanged must be false.
    assert.equal(
      drift.length > 0 && drift[0].packagedDefaultsChanged,
      false,
      "drift comparison must be deferred for empty-string provider, not produce a change",
    );
  });
});
