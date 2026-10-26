import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";

import { createInMemoryCredentialStore } from "./support/in-memory-credential-store.mjs";

// Load Pi and keep all runtime calls inside a task-owned profile. The poisoned
// values exercise the inherited-state boundary without pointing at real home
// credentials or provider keys.
const importRoot = mkdtempSync(join(tmpdir(), "tlh-pi-1-3-model-resolution-"));
const importAgent = join(importRoot, "agent");
const importHome = join(importRoot, "home");
const importXdgConfig = join(importRoot, "xdg-config");
const importXdgData = join(importRoot, "xdg-data");
const importXdgCache = join(importRoot, "xdg-cache");
const importXdgState = join(importRoot, "xdg-state");
const importTemp = join(importRoot, "tmp");
const ambientAgent = join(importRoot, "ambient-agent");
for (const directory of [
  importAgent,
  importHome,
  importXdgConfig,
  importXdgData,
  importXdgCache,
  importXdgState,
  importTemp,
]) {
  mkdirSync(directory, { recursive: true });
}

const originalEnv = new Map(Object.entries(process.env));
const poisonedInheritedEnv = {
  PI_CODING_AGENT_DIR: ambientAgent,
  PI_AUTH_PATH: join(ambientAgent, "auth.json"),
  PI_SUBAGENT: "poisoned-inherited-subagent",
  TLH_DISABLED_DEFAULT_EXTENSIONS: "poisoned-inherited-defaults",
  MCP_SERVER_CONFIG: join(ambientAgent, "mcp.json"),
  OPENAI_API_KEY: "poisoned-inherited-provider-key",
};
for (const [key, value] of Object.entries(poisonedInheritedEnv)) process.env[key] = value;

function isInheritedStateKey(key) {
  return (
    key.startsWith("PI_") ||
    key.startsWith("TLH_") ||
    key.startsWith("MCP_") ||
    /(?:API[_-]?KEY|APIKEY|ACCESS[_-]?(?:KEY|TOKEN)|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AWS_PROFILE)/iu.test(
      key,
    )
  );
}

for (const key of Object.keys(process.env)) {
  if (isInheritedStateKey(key)) delete process.env[key];
}
process.env.HOME = importHome;
process.env.USERPROFILE = importHome;
process.env.XDG_CONFIG_HOME = importXdgConfig;
process.env.XDG_DATA_HOME = importXdgData;
process.env.XDG_CACHE_HOME = importXdgCache;
process.env.XDG_STATE_HOME = importXdgState;
process.env.TMPDIR = importTemp;
process.env.TEMP = importTemp;
process.env.TMP = importTemp;
process.env.PI_CODING_AGENT_DIR = importAgent;
process.env.PI_OFFLINE = "1";

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!originalEnv.has(key)) delete process.env[key];
  }
  for (const [key, value] of originalEnv) process.env[key] = value;
}

let ModelRuntime;
let parseArgs;
let resolveCliModel;
let resolveSubagentModelOverride;
let buildPiArgs;
try {
  ({ ModelRuntime, parseArgs, resolveCliModel } = await import("@earendil-works/pi-coding-agent"));
  ({ resolveSubagentModelOverride } =
    await import("../extensions/subagents/src/runs/shared/model-fallback.js"));
  ({ buildPiArgs } = await import("../extensions/subagents/src/runs/shared/pi-args.js"));
} catch (error) {
  restoreEnvironment();
  rmSync(importRoot, { recursive: true, force: true });
  throw error;
}

after(() => {
  try {
    assert.equal(existsSync(ambientAgent), false, "poisoned ambient auth path must stay untouched");
  } finally {
    restoreEnvironment();
    rmSync(importRoot, { recursive: true, force: true });
  }
});

const SHARED_MODEL_ID = "tlh-pi-1-3-shared-fixture-model";
const PROVIDER_A = "tlh-pi-1-3-provider-a";
const PROVIDER_B = "tlh-pi-1-3-provider-b";

function fixtureModel(id = SHARED_MODEL_ID) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function createRuntime(configuredProviders) {
  assertIsolatedEnvironment();
  const runtime = await ModelRuntime.create({
    credentials: createInMemoryCredentialStore(),
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const provider of [PROVIDER_A, PROVIDER_B]) {
    runtime.registerProvider(provider, {
      baseUrl: `https://${provider}.example.invalid/v1`,
      api: "openai-completions",
      models: [fixtureModel()],
      ...(configuredProviders.includes(provider) ? { apiKey: "fixture-only" } : {}),
    });
  }
  assert.deepEqual(
    [PROVIDER_A, PROVIDER_B].map((provider) => runtime.hasConfiguredAuth(provider)),
    [configuredProviders.includes(PROVIDER_A), configuredProviders.includes(PROVIDER_B)],
  );
  return runtime;
}

function assertIsolatedEnvironment() {
  assert.equal(process.env.HOME, importHome);
  assert.equal(process.env.USERPROFILE, importHome);
  assert.equal(process.env.XDG_CONFIG_HOME, importXdgConfig);
  assert.equal(process.env.XDG_DATA_HOME, importXdgData);
  assert.equal(process.env.XDG_CACHE_HOME, importXdgCache);
  assert.equal(process.env.XDG_STATE_HOME, importXdgState);
  assert.equal(process.env.PI_CODING_AGENT_DIR, importAgent);
  for (const key of Object.keys(poisonedInheritedEnv)) {
    if (key !== "PI_CODING_AGENT_DIR") assert.equal(process.env[key], undefined);
  }
}

test("Pi 1.3.0 CLI resolver rejects a bare model with no configured matching provider", async () => {
  const runtime = await createRuntime([]);
  const resolved = resolveCliModel({ cliModel: SHARED_MODEL_ID, modelRuntime: runtime });

  assert.equal(resolved.model, undefined);
  assert.match(resolved.error ?? "", /ambiguous across providers/iu);
  assert.match(resolved.error ?? "", /No matching provider is authenticated/iu);
  assert.match(resolved.error ?? "", new RegExp(`${PROVIDER_A}/${SHARED_MODEL_ID}`));
  assert.match(resolved.error ?? "", new RegExp(`${PROVIDER_B}/${SHARED_MODEL_ID}`));
});

test("Pi 1.3.0 CLI resolver chooses the sole configured provider for a bare model", async () => {
  const runtime = await createRuntime([PROVIDER_B]);
  const resolved = resolveCliModel({ cliModel: SHARED_MODEL_ID, modelRuntime: runtime });

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.model?.provider, PROVIDER_B);
  assert.equal(resolved.model?.id, SHARED_MODEL_ID);
});

test("Pi 1.3.0 CLI resolver rejects a bare model when multiple providers are configured", async () => {
  const runtime = await createRuntime([PROVIDER_A, PROVIDER_B]);
  const resolved = resolveCliModel({ cliModel: SHARED_MODEL_ID, modelRuntime: runtime });

  assert.equal(resolved.model, undefined);
  assert.match(resolved.error ?? "", /ambiguous across providers/iu);
  assert.match(resolved.error ?? "", /More than one matching provider is authenticated/iu);
});

test("provider-qualified Pi and TLH child selections stay deterministic and preserve explicit thinking", async () => {
  const runtime = await createRuntime([PROVIDER_A, PROVIDER_B]);
  const qualified = `${PROVIDER_B}/${SHARED_MODEL_ID}`;

  const piResolved = resolveCliModel({
    cliProvider: PROVIDER_B,
    cliModel: SHARED_MODEL_ID,
    cliThinking: "high",
    modelRuntime: runtime,
  });
  assert.equal(piResolved.error, undefined);
  assert.equal(piResolved.model?.provider, PROVIDER_B);
  assert.equal(piResolved.model?.id, SHARED_MODEL_ID);

  const childParent = { provider: PROVIDER_A, id: SHARED_MODEL_ID };
  // The simplified runtime forwards explicit model strings unchanged (no catalog
  // qualification), so a bare shared ID stays ambiguous and a qualified one is kept.
  const bareChildOverride = resolveSubagentModelOverride(SHARED_MODEL_ID, childParent);
  assert.equal(bareChildOverride, SHARED_MODEL_ID);
  const childResolved = resolveSubagentModelOverride(qualified, childParent);
  assert.equal(childResolved, qualified);

  function parseBuiltModel(args) {
    const parsed = parseArgs(args);
    assert.deepEqual(parsed.diagnostics, []);
    return parsed;
  }

  function resolveBuiltModel(args) {
    const parsed = parseBuiltModel(args);
    const resolved = resolveCliModel({
      cliProvider: parsed.provider,
      cliModel: parsed.model,
      cliThinking: parsed.thinking,
      modelRuntime: runtime,
    });
    assert.equal(resolved.error, undefined);
    return { parsed, resolved };
  }

  const ambiguousChildArgs = buildPiArgs({
    baseArgs: ["--mode", "json", "-p"],
    task: "ambiguous child model fixture",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
    model: bareChildOverride,
    tools: [],
  });
  const ambiguousChildParsed = parseBuiltModel(ambiguousChildArgs.args);
  assert.equal(ambiguousChildParsed.provider, undefined);
  assert.equal(ambiguousChildParsed.model, SHARED_MODEL_ID);
  const ambiguousChildResolved = resolveCliModel({
    cliProvider: ambiguousChildParsed.provider,
    cliModel: ambiguousChildParsed.model,
    cliThinking: ambiguousChildParsed.thinking,
    modelRuntime: runtime,
  });
  assert.equal(ambiguousChildResolved.model, undefined);
  assert.match(ambiguousChildResolved.error ?? "", /ambiguous across providers/iu);
  assert.match(
    ambiguousChildResolved.error ?? "",
    /More than one matching provider is authenticated/iu,
  );

  const inheritedThinkingArgs = buildPiArgs({
    baseArgs: ["--mode", "json", "-p"],
    task: "model resolution fixture",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
    model: childResolved,
    thinking: "high",
    tools: [],
  });
  const inherited = resolveBuiltModel(inheritedThinkingArgs.args);
  assert.equal(inherited.parsed.model, `${qualified}:high`);
  assert.equal(inherited.resolved.model?.provider, PROVIDER_B);
  assert.equal(inherited.resolved.model?.id, SHARED_MODEL_ID);
  assert.equal(inherited.resolved.thinkingLevel, "high");

  const explicitThinkingArgs = buildPiArgs({
    baseArgs: ["--mode", "json", "-p"],
    task: "model resolution fixture",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
    model: `${qualified}:low`,
    thinking: "high",
    tools: [],
  });
  const explicit = resolveBuiltModel(explicitThinkingArgs.args);
  assert.equal(explicit.parsed.model, `${qualified}:low`);
  assert.equal(explicit.resolved.model?.provider, PROVIDER_B);
  assert.equal(explicit.resolved.model?.id, SHARED_MODEL_ID);
  assert.equal(explicit.resolved.thinkingLevel, "low");
});
