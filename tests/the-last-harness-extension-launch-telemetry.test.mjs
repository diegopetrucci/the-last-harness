import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_LAUNCH_TELEMETRY_EVENT_TYPE, TLH_NAME, TLH_TELEMETRY_STATE_SCHEMA_VERSION } =
  await jiti.import("../extensions/the-last-harness/constants.ts");
const { CI_FAILURE_INVESTIGATION_FEATURE, DELTA_FOLLOW_UP_REVIEWS_FEATURE } = await jiti.import(
  "../extensions/the-last-harness/experimental.ts",
);
const { THINKING_LEVELS } = await jiti.import("../extensions/the-last-harness/constants.ts");
const {
  privacySafeTlhTelemetryProviderId,
  privacySafeTlhTelemetryThinkingLevel,
  privacySafeTlhTelemetryModelId,
  scheduleTlhLaunchTelemetry,
  sendTlhLaunchTelemetry,
} = await jiti.import("../extensions/the-last-harness/launch-telemetry.ts");

const EXISTING_INSTALL_ID = "11111111-1111-4111-8111-111111111111";

function telemetryStatePath(fixture) {
  return join(fixture.agent, "tlh", "telemetry-state.json");
}

function writeTelemetryState(fixture, installId = EXISTING_INSTALL_ID) {
  mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
  const stateContent = `${JSON.stringify({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }, null, 2)}\n`;
  writeFileSync(telemetryStatePath(fixture), stateContent);
  return stateContent;
}

test("launch telemetry sends allowlisted experimental feature states and reuses the existing install ID", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
  const originalState = writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        tlh: {
          experimental: {
            enabledFeatures: [" delta-follow-up-reviews ", "embedded-subagents", "legacy-flag"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace/",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "openai-codex",
          modelId: "openai-codex/gpt-4o",
          primaryAgentName: "architect",
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  assert.equal(request.url, "https://telemetry.example.test/namespace/test-namespace/");
  assert.equal(request.options?.method, "POST");
  assert.equal(request.options?.headers?.["User-Agent"], `${TLH_NAME}/1.2.3`);

  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.equal(event.appID, "test-app-id");
  assert.equal(event.type, TLH_LAUNCH_TELEMETRY_EVENT_TYPE);
  assert.equal(event.clientUser, createHash("sha256").update(EXISTING_INSTALL_ID).digest("hex"));
  assert.equal(event.payload["Tlh.App.version"], "1.2.3");
  assert.equal(event.payload["Tlh.Runtime.provider"], "openai-codex");
  // modelId "openai-codex/gpt-4o" → last segment "gpt-4o" (public); no thinkingLevel → "unknown"
  assert.equal(event.payload["Tlh.Runtime.modelEffort"], "gpt-4o:unknown");
  assert.equal(event.payload["Tlh.PrimaryAgent.name"], "architect");
  assert.equal(event.payload[`Tlh.Experimental.${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`], "on");
  assert.equal(event.payload[`Tlh.Experimental.${CI_FAILURE_INVESTIGATION_FEATURE}`], "off");
  assert.equal(Object.hasOwn(event.payload, "Tlh.Experimental.embedded-subagents"), false);
  assert.equal(Object.hasOwn(event.payload, "Tlh.Experimental.legacy-flag"), false);
  assert.equal(readFileSync(telemetryStatePath(fixture), "utf8"), originalState);

  // Regression: no key ending in ".thinking" must appear in the payload.
  const thinkingKeys = Object.keys(event.payload).filter((k) => k.endsWith(".thinking"));
  assert.deepEqual(thinkingKeys, [], "no emitted payload key should end in '.thinking'");
});

test("launch telemetry allowlists current public runtime provider IDs and rejects stale aliases", () => {
  assert.equal(privacySafeTlhTelemetryProviderId("amazon-bedrock"), "amazon-bedrock");
  assert.equal(
    privacySafeTlhTelemetryProviderId("azure-openai-responses"),
    "azure-openai-responses",
  );
  assert.equal(privacySafeTlhTelemetryProviderId("github-copilot"), "github-copilot");
  assert.equal(privacySafeTlhTelemetryProviderId("google-vertex"), "google-vertex");
  assert.equal(privacySafeTlhTelemetryProviderId("radius"), "radius");
  assert.equal(privacySafeTlhTelemetryProviderId("llama.cpp"), "llama.cpp");
  assert.equal(privacySafeTlhTelemetryProviderId("azure-openai"), "custom");
  assert.equal(privacySafeTlhTelemetryProviderId("bedrock"), "custom");
});

test("launch telemetry maps unknown provider and primary-agent identifiers to custom", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
  writeTelemetryState(fixture);

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
      },
      async () => {
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "acme-internal",
          modelId: "acme-internal/super-secret-model",
          primaryAgentName: "skunkworks",
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.equal(event.payload["Tlh.Runtime.provider"], "custom");
  // "super-secret-model" is not on the allowlist → "custom"; no thinkingLevel → "unknown"
  assert.equal(event.payload["Tlh.Runtime.modelEffort"], "custom:unknown");
  assert.equal(event.payload["Tlh.PrimaryAgent.name"], "custom");
});

test("launch telemetry skips when the isolated profile has telemetry opt-out enabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
  writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { telemetry: { enabled: false }, experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
  );

  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetchCalls, 0);
});

test("launch telemetry skips when telemetry settings are malformed", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
  writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { telemetry: { enabled: "nope" }, experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
  );

  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetchCalls, 0);
});

// ── Environment opt-out tests ─────────────────────────────────────────────────
//
// Each row exercises one independent opt-out path. The truthy flags use isTruthyEnvFlag
// ("1", "true", "yes" are the accepted values). PI_TELEMETRY uses isFalseyEnvFlag ("0",
// "false", "no" suppress telemetry; a truthy value like "1" must NOT suppress it).
//
// The table format keeps coverage compact and makes the semantics obvious at a glance.
//
// Existing tlh.telemetry.enabled:false coverage stays in the test above; this table
// covers only the environment-variable paths.

const ENV_OPT_OUT_CASES = [
  // [description, envOverride, expectedFetchCalls]
  [
    "PI_OFFLINE=1 (truthy flag) suppresses send",
    {
      PI_OFFLINE: "1",
      TLH_SKIP_TELEMETRY: undefined,
      TLH_TELEMETRY_DISABLED: undefined,
      PI_TELEMETRY: undefined,
    },
    0,
  ],
  [
    "TLH_SKIP_TELEMETRY=true (truthy flag) suppresses send",
    {
      PI_OFFLINE: undefined,
      TLH_SKIP_TELEMETRY: "true",
      TLH_TELEMETRY_DISABLED: undefined,
      PI_TELEMETRY: undefined,
    },
    0,
  ],
  [
    "TLH_TELEMETRY_DISABLED=yes (truthy flag) suppresses send",
    {
      PI_OFFLINE: undefined,
      TLH_SKIP_TELEMETRY: undefined,
      TLH_TELEMETRY_DISABLED: "yes",
      PI_TELEMETRY: undefined,
    },
    0,
  ],
  [
    "PI_TELEMETRY=0 (falsey flag) suppresses send",
    {
      PI_OFFLINE: undefined,
      TLH_SKIP_TELEMETRY: undefined,
      TLH_TELEMETRY_DISABLED: undefined,
      PI_TELEMETRY: "0",
    },
    0,
  ],
  [
    "PI_TELEMETRY=1 (truthy value) does NOT suppress send",
    {
      PI_OFFLINE: undefined,
      TLH_SKIP_TELEMETRY: undefined,
      TLH_TELEMETRY_DISABLED: undefined,
      PI_TELEMETRY: "1",
    },
    1,
  ],
];

for (const [description, envOverride, expectedFetchCalls] of ENV_OPT_OUT_CASES) {
  test(`launch telemetry env opt-out: ${description}`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-env-optout-", { test: t });
    writeTelemetryState(fixture);

    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, statusText: "OK" };
    };

    try {
      await withEnv(
        {
          HOME: fixture.home,
          PI_CODING_AGENT_DIR: fixture.agent,
          TLH_TELEMETRY_NAMESPACE: "test-namespace",
          TLH_TELEMETRY_APP_ID: "test-app-id",
          TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
          ...envOverride,
        },
        async () => {
          await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(fetchCalls, expectedFetchCalls, description);
  });
}

// ── privacySafeTlhTelemetryThinkingLevel tests ───────────────────────────────

test("privacySafeTlhTelemetryThinkingLevel maps all seven THINKING_LEVELS allowlist values to themselves", () => {
  for (const level of THINKING_LEVELS) {
    assert.equal(
      privacySafeTlhTelemetryThinkingLevel(level),
      level,
      `expected allowlisted value for "${level}"`,
    );
  }
});

test("privacySafeTlhTelemetryThinkingLevel maps missing/empty/non-string to unknown", () => {
  assert.equal(privacySafeTlhTelemetryThinkingLevel(undefined), "unknown");
  assert.equal(privacySafeTlhTelemetryThinkingLevel(""), "unknown");
  assert.equal(privacySafeTlhTelemetryThinkingLevel("   "), "unknown");
});

test("privacySafeTlhTelemetryThinkingLevel maps unrecognised values to custom", () => {
  assert.equal(privacySafeTlhTelemetryThinkingLevel("ultra"), "custom");
  assert.equal(privacySafeTlhTelemetryThinkingLevel("MEDIUM"), "custom");
  assert.equal(privacySafeTlhTelemetryThinkingLevel("turbo"), "custom");
});

// ── privacySafeTlhTelemetryModelId tests ─────────────────────────────────────

test("privacySafeTlhTelemetryModelId maps public model IDs to themselves (case-insensitive)", () => {
  // Public model IDs on the allowlist are reported as-is (lowercased last segment).
  assert.equal(privacySafeTlhTelemetryModelId("claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(privacySafeTlhTelemetryModelId("gpt-4o"), "gpt-4o");
  assert.equal(privacySafeTlhTelemetryModelId("gemini-pro"), "gemini-pro");
  assert.equal(privacySafeTlhTelemetryModelId("grok-1"), "grok-1");
  assert.equal(privacySafeTlhTelemetryModelId("deepseek-coder"), "deepseek-coder");
  // Provider-qualified IDs: last segment is used.
  assert.equal(privacySafeTlhTelemetryModelId("anthropic/claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(privacySafeTlhTelemetryModelId("openai/gpt-4o"), "gpt-4o");
});

test("privacySafeTlhTelemetryModelId maps missing/empty to unknown", () => {
  assert.equal(privacySafeTlhTelemetryModelId(undefined), "unknown");
  assert.equal(privacySafeTlhTelemetryModelId(""), "unknown");
  assert.equal(privacySafeTlhTelemetryModelId("   "), "unknown");
});

test("privacySafeTlhTelemetryModelId maps non-public model IDs to custom", () => {
  assert.equal(privacySafeTlhTelemetryModelId("super-secret-model"), "custom");
  assert.equal(privacySafeTlhTelemetryModelId("acme-internal/proprietary-model"), "custom");
  assert.equal(privacySafeTlhTelemetryModelId("/Users/someone/model.gguf"), "custom");
});

// ── Tlh.Runtime.modelEffort tests ────────────────────────────────────────────

test("launch telemetry emits Tlh.Runtime.modelEffort from snapshot.modelId and thinkingLevel", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-thinking-", { test: t });
  writeTelemetryState(fixture);

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          modelId: "claude-opus-4-5",
          thinkingLevel: "high",
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // "claude-opus-4-5" matches the claude-* pattern; "high" is a known thinking level.
  assert.equal(event.payload["Tlh.Runtime.modelEffort"], "claude-opus-4-5:high");
});

test("launch telemetry maps unknown thinkingLevel to unknown and uppercase value to custom (case-sensitivity check)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-thinking-", { test: t });
  writeTelemetryState(fixture);

  const previousFetch = globalThis.fetch;
  const results = {};
  globalThis.fetch = async (_url, options) => {
    const [event] = JSON.parse(options?.body ?? "[]");
    results[event.payload["Tlh.App.version"]] = event.payload["Tlh.Runtime.modelEffort"];
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "missing", thinkingLevel: undefined });
        await sendTlhLaunchTelemetry({ version: "uppercase", thinkingLevel: "High" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  // No modelId → model side is "unknown"; "High" is not in THINKING_LEVELS (case-sensitive) → "custom".
  assert.equal(
    results["missing"],
    "unknown:unknown",
    "undefined thinkingLevel should map to unknown:unknown",
  );
  assert.equal(
    results["uppercase"],
    "unknown:custom",
    "uppercase 'High' should map to unknown:custom (case-sensitive check)",
  );
});

// ── joinModelEffort degenerate combinations ───────────────────────────────────
//
// joinModelEffort is an internal helper; its behaviour is verified through the emitted
// Tlh.Runtime.modelEffort payload key. The three canonical degenerate combinations are:
//   "unknown:unknown" — no model ID, no thinking level
//   "custom:high"     — non-public model, known thinking level
//   "claude-opus-4-5:unknown" — known model, no thinking level

test("joinModelEffort degenerate combinations: unknown:unknown, custom:high, and known-model:unknown", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-join-", { test: t });
  writeTelemetryState(fixture);

  const previousFetch = globalThis.fetch;
  const results = {};
  globalThis.fetch = async (_url, options) => {
    const [event] = JSON.parse(options?.body ?? "[]");
    results[event.payload["Tlh.App.version"]] = event.payload["Tlh.Runtime.modelEffort"];
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // "unknown:unknown" — neither side provided
        await sendTlhLaunchTelemetry({ version: "both-unknown" });
        // "custom:high" — non-public model + known thinking level
        await sendTlhLaunchTelemetry({
          version: "custom-high",
          modelId: "acme-internal/proprietary-llm",
          thinkingLevel: "high",
        });
        // "claude-opus-4-5:unknown" — public model, no thinking level
        await sendTlhLaunchTelemetry({
          version: "model-known-effort-unknown",
          modelId: "claude-opus-4-5",
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(
    results["both-unknown"],
    "unknown:unknown",
    "no model and no thinking → unknown:unknown",
  );
  assert.equal(
    results["custom-high"],
    "custom:high",
    "non-public model + known thinking → custom:high",
  );
  assert.equal(
    results["model-known-effort-unknown"],
    "claude-opus-4-5:unknown",
    "known model + no thinking → model:unknown",
  );
});

// ── Tlh.Subagent.NAME.modelEffort tests ──────────────────────────────────────

test("launch telemetry emits all eight bundled subagent keys with unknown:unknown when no config present", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  const bundledNames = [
    "code-reviewer",
    "contrarian",
    "developer",
    "diff-summarizer",
    "librarian",
    "oracle",
    "repo-scout",
    "web-scout",
  ];
  for (const name of bundledNames) {
    assert.equal(
      event.payload[`Tlh.Subagent.${name}.modelEffort`],
      "unknown:unknown",
      `expected unknown:unknown modelEffort for ${name}`,
    );
  }

  // Regression: no key ending in ".thinking" must appear anywhere in the payload.
  const thinkingKeys = Object.keys(event.payload).filter((k) => k.endsWith(".thinking"));
  assert.deepEqual(thinkingKeys, [], "no emitted payload key should end in '.thinking'");
});

test("launch telemetry reflects settings agentOverrides thinking change", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        subagents: {
          agentOverrides: { developer: { thinking: "high", model: "claude-opus-4-5" } },
        },
      },
      null,
      2,
    )}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-opus-4-5:high",
    "settings override thinking and model should be reflected as combined modelEffort",
  );
  // Other agents should still be unknown:unknown
  assert.equal(event.payload["Tlh.Subagent.librarian.modelEffort"], "unknown:unknown");
});

test("launch telemetry reflects hand-edited frontmatter thinking value", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);

  // Simulate an installed subagent file with user-edited thinking field
  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "librarian.md"),
    "---\nname: librarian\nthinking: medium\nmodel: claude-opus-4-5\n---\nPrompt body here.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Bare model name "claude-opus-4-5" (no slash) is reported as-is; thinking "medium" from frontmatter.
  assert.equal(
    event.payload["Tlh.Subagent.librarian.modelEffort"],
    "claude-opus-4-5:medium",
    "frontmatter model and thinking should be reflected as combined modelEffort",
  );
});

test("launch telemetry: settings agentOverrides wins over frontmatter", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);

  // Frontmatter says "low"; settings override says "max"
  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "oracle.md"),
    "---\nname: oracle\nthinking: low\nmodel: gpt-4o\n---\nPrompt body.\n",
  );
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        subagents: { agentOverrides: { oracle: { thinking: "max", model: "claude-opus-4-5" } } },
      },
      null,
      2,
    )}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.equal(
    event.payload["Tlh.Subagent.oracle.modelEffort"],
    "claude-opus-4-5:max",
    "settings override should win over frontmatter, combined as modelEffort",
  );
});

test("launch telemetry: disabled agentOverride is reported as 'disabled' (single token)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        subagents: { agentOverrides: { "repo-scout": { disabled: true } } },
      },
      null,
      2,
    )}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // A disabled agent emits the single token "disabled" — not "disabled:disabled".
  // "disabled" does not collide with any THINKING_LEVELS member.
  assert.equal(
    event.payload["Tlh.Subagent.repo-scout.modelEffort"],
    "disabled",
    "disabled agent must report single token 'disabled' as modelEffort",
  );
});

test("launch telemetry never emits keys for agent names outside the bundled eight", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        // "skunkworks" is not a bundled subagent name
        subagents: { agentOverrides: { skunkworks: { thinking: "high", model: "secret-model" } } },
      },
      null,
      2,
    )}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  const payloadKeys = Object.keys(event.payload);
  const unbundledKeys = payloadKeys.filter(
    (k) => k.startsWith("Tlh.Subagent.") && k.includes("skunkworks"),
  );
  assert.equal(unbundledKeys.length, 0, "no telemetry key should exist for non-bundled agent name");
});

test("launch telemetry: non-public model in frontmatter is reported as 'custom'", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "contrarian.md"),
    "---\nname: contrarian\nthinking: high\nmodel: acme-internal/super-secret-model\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // The model is provider-qualified so it must be in availableModels to be reported.
        // privacySafeTlhTelemetryModelId then redacts it as "custom" (not on allowlist).
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          availableModels: [{ provider: "acme-internal", id: "super-secret-model" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // "super-secret-model" is not on the public allowlist → "custom"; thinking "high" is valid.
  assert.equal(
    event.payload["Tlh.Subagent.contrarian.modelEffort"],
    "custom:high",
    "non-public model is redacted to 'custom'; combined as modelEffort",
  );
});

// ── provider-aware frontmatter tests ────────────────────────────────────────

test("launch telemetry reports provider-aware defaults for bundled agents (Anthropic active)", async (t) => {
  // developer.md: Anthropic effort=medium, OpenAI Codex effort=max
  //               Anthropic model=claude-sonnet-4-6, OpenAI Codex model=gpt-5.6-luna
  // Expected for Anthropic provider: modelEffort="claude-sonnet-4-6:medium"
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    `---
name: developer
tlhModelDefaults:
  - provider: openai-codex
    models: [gpt-5.6-luna]
    effort: max
  - provider: anthropic
    models: [claude-sonnet-4-6]
    effort: medium
---
Body.
`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Supply the real available-models list; only models present here can be reported.
        // This mirrors how scheduleTlhLaunchTelemetry captures the registry at schedule time.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Anthropic provider: normalized Anthropic effort=medium, model resolved as claude-sonnet-4-6.
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-sonnet-4-6:medium",
    "Anthropic: expected claude-sonnet-4-6:medium modelEffort",
  );
});

test("launch telemetry reports provider-aware defaults for bundled agents (OpenAI active)", async (t) => {
  // Same normalized frontmatter as above but with OpenAI Codex provider
  // Expected: modelEffort="gpt-5.6-luna:max"
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    `---
name: developer
tlhModelDefaults:
  - provider: openai-codex
    models: [gpt-5.6-luna]
    effort: max
  - provider: anthropic
    models: [claude-sonnet-4-6]
    effort: medium
---
Body.
`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Supply the real available-models list so resolver can find openai-codex model.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "openai-codex",
          availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // OpenAI-codex provider: normalized effort=max, model resolved as gpt-5.6-luna.
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "gpt-5.6-luna:max",
    "OpenAI: expected gpt-5.6-luna:max modelEffort",
  );
  // Verify they differ from Anthropic (developer is the canonical case where they diverge)
  assert.notEqual(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-sonnet-4-6:medium",
    "OpenAI modelEffort should differ from Anthropic modelEffort for developer",
  );
});

test("launch telemetry uses normalized provider entries and ignores generic compatibility fields in a present block", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-normalized-defaults-", {
    test: t,
  });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    `---
name: developer
model: anthropic/legacy-model
thinking: high
tlhModelDefaults:
  - provider: openai-codex
    models: [gpt-5.6-luna]
    effort: max
  - provider: anthropic
    models: [claude-sonnet-4-6]
    effort: medium
---
Body.
`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-sonnet-4-6:medium",
    "telemetry must use the matching normalized provider entry instead of generic thinking/model",
  );
});

test("launch telemetry handles quoted frontmatter model values", async (t) => {
  // tlhAnthropicModels value is quoted in YAML: 'anthropic/claude-haiku-4-5'
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "librarian.md"),
    "---\nname: librarian\ntlhAnthropicModels: 'anthropic/claude-haiku-4-5'\ntlhAnthropicThinking: \"high\"\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Supply the model as available so the registry-based resolver can select it.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Quoted frontmatter values must be unquoted correctly; model resolved against available list.
  assert.equal(
    event.payload["Tlh.Subagent.librarian.modelEffort"],
    "claude-haiku-4-5:high",
    "quoted frontmatter values should parse correctly into modelEffort",
  );
});

test("launch telemetry handles list-valued model fields (comma-separated tlhOpenaiModels)", async (t) => {
  // tlhOpenaiModels contains a comma-separated list; the first matching provider entry is used
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "oracle.md"),
    "---\nname: oracle\ntlhOpenaiModels: openai-codex/gpt-5.6-sol, openai/gpt-4o\ntlhAnthropicModels: anthropic/claude-opus-5\ntlhOpenaiThinking: high\ntlhAnthropicThinking: high\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Supply openai-codex/gpt-5.6-sol as available; the resolver must pick it first
        // over openai/gpt-4o since it matches the current provider more precisely.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "openai-codex",
          availableModels: [
            { provider: "openai-codex", id: "gpt-5.6-sol" },
            { provider: "openai", id: "gpt-4o" },
          ],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // First matching openai-codex entry from the comma-separated list is selected; thinking is high.
  assert.equal(
    event.payload["Tlh.Subagent.oracle.modelEffort"],
    "gpt-5.6-sol:high",
    "first matching openai-codex model from list should be selected, combined as modelEffort",
  );
});

test("launch telemetry: model: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-clearing-", { test: t });
  writeTelemetryState(fixture);

  // Install frontmatter with a real model value
  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );
  // Settings override clears the model explicitly
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ subagents: { agentOverrides: { developer: { model: false } } } }, null, 2)}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // model: false → "cleared" on the model side; thinking from frontmatter → "medium".
  // Combined: "cleared:medium".
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "cleared:medium",
    "model: false must report 'cleared' on the model side; thinking still comes from frontmatter",
  );
});

test("launch telemetry: thinking: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-clearing-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: false } } } }, null, 2)}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Provide the model as available so the registry-based resolver can find it
        // and the test demonstrates that only thinking is cleared, not model.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // thinking: false → "cleared" on the thinking side; model from frontmatter → "claude-sonnet-4-6".
  // Combined: "claude-sonnet-4-6:cleared".
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-sonnet-4-6:cleared",
    "thinking: false must report 'cleared' on the thinking side; model still comes from frontmatter",
  );
});

test("launch telemetry: settings override wins over provider-aware frontmatter", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-override-wins-", { test: t });
  writeTelemetryState(fixture);

  // Frontmatter has provider-aware keys
  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );
  // Settings override should win over frontmatter values
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high", model: "anthropic/claude-opus-5" } } } }, null, 2)}\n`,
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // model "anthropic/claude-opus-5" → last segment "claude-opus-5" → matches claude-* pattern.
  // thinking "high" from override. Combined: "claude-opus-5:high".
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "claude-opus-5:high",
    "settings override should win over provider-aware frontmatter, combined as modelEffort",
  );
});

// ── registry-accurate resolution tests ──────────────────────────────────────

test("registry-accurate: provider-aware candidate NOT available is reported as 'unknown'", async (t) => {
  // When availableModels does NOT include the frontmatter-declared model, the resolver
  // cannot select it, so the model side must be "unknown" rather than the frontmatter value.
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // availableModels does NOT include anthropic/claude-sonnet-4-6.
        // The resolver cannot select it, so model side must be "unknown".
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }], // different model
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Model NOT in available list → "unknown"; thinking still resolves from provider key → "medium".
  assert.equal(
    event.payload["Tlh.Subagent.developer.modelEffort"],
    "unknown:medium",
    "unavailable model must resolve to unknown; thinking still resolves from provider key",
  );
});

test("registry-accurate: empty availableModels yields 'unknown' for provider-qualified model fields", async (t) => {
  // When the registry was not captured (empty availableModels), provider-qualified model
  // references cannot be verified and must not be guessed — report 'unknown'.
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "librarian.md"),
    "---\nname: librarian\ntlhAnthropicModels: anthropic/claude-haiku-4-5\ntlhAnthropicThinking: low\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // No availableModels in snapshot (defaults to []). Provider-qualified model
        // references cannot be found → model side must report 'unknown'.
        await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Empty registry → "unknown" on model side; thinking from provider key → "low".
  assert.equal(
    event.payload["Tlh.Subagent.librarian.modelEffort"],
    "unknown:low",
    "empty registry must yield unknown for provider-qualified models; thinking still resolves",
  );
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model IS available is reported", async (t) => {
  // When preferOppositeProvider is true and the opposite-provider model is in availableModels,
  // it is selected and reported (this is the correct runtime behaviour).
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "contrarian.md"),
    "---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Provider is anthropic; preferOppositeProvider → looks for openai-codex model.
        // openai-codex/gpt-5.6-luna IS available here, so it must be selected.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // preferOppositeProvider + anthropic provider → openai-codex model selected → "gpt-5.6-luna:max".
  assert.equal(
    event.payload["Tlh.Subagent.contrarian.modelEffort"],
    "gpt-5.6-luna:max",
    "preferOppositeProvider with available opposite-provider model → gpt-5.6-luna:max",
  );
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model NOT available yields same-provider fallback", async (t) => {
  // Old code (synthetic list) incorrectly reported the opposite-provider model even when it
  // was not in the real registry. With the real registry, if the opposite-provider model is
  // unavailable the resolver falls through to the standard same-provider selection.
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "contrarian.md"),
    "---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Provider is anthropic; preferOppositeProvider → looks for openai-codex model.
        // openai-codex/gpt-5.6-luna is NOT available, so the opposite-provider selection
        // fails and the resolver falls back to the standard same-provider selection.
        // anthropic/claude-sonnet-4-6 IS available, so it is reported as the fallback.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // Old synthetic code would have wrongly reported gpt-5.6-luna here.
  // New registry-accurate code correctly reports the same-provider fallback → "claude-sonnet-4-6:medium".
  assert.notEqual(
    event.payload["Tlh.Subagent.contrarian.modelEffort"],
    "gpt-5.6-luna:max",
    "unavailable opposite-provider model must not be reported",
  );
  assert.equal(
    event.payload["Tlh.Subagent.contrarian.modelEffort"],
    "claude-sonnet-4-6:medium",
    "same-provider fallback selected when opposite-provider model unavailable",
  );
});

test("registry-accurate: hand-edited generic model: field wins when provider-aware models unavailable", async (t) => {
  // When tlhAnthropicModels / tlhOpenaiModels are all absent from availableModels but the
  // generic model: field IS in the registry, the generic field wins. This is the same
  // precedence as selectStandardProviderAwareAgentModel which checks agent.model first.
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
  writeTelemetryState(fixture);

  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "oracle.md"),
    // model: is provider-qualified; tlhAnthropicModels is a different model that
    // is NOT in availableModels. The generic model: field must win here.
    "---\nname: oracle\nmodel: anthropic/claude-opus-5\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: high\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // availableModels contains only the generic model: field's model.
        // tlhAnthropicModels refers to claude-sonnet-4-6 which is NOT available.
        // selectStandardProviderAwareAgentModel checks agent.model first, so claude-opus-5 wins.
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          providerId: "anthropic",
          availableModels: [{ provider: "anthropic", id: "claude-opus-5" }],
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  // The generic model: field IS available and is checked first → "claude-opus-5:high".
  assert.equal(
    event.payload["Tlh.Subagent.oracle.modelEffort"],
    "claude-opus-5:high",
    "generic model: field wins when it is the only available model, combined as modelEffort",
  );
});

// ── project-vs-user agentOverrides precedence tests ───────────────────────────
//
// TLH's eight subagents are installed under the fixed `tlh/agents/subagents` path and reach the
// runtime as canonical USER-scope roles via applyCustomAgentOverrides (extensions/subagents/src/agents/agents.ts).
// That gives a two-rule precedence: project `agentOverrides[name]`, else user
// `agentOverrides[name]`, else unmodified. `disableBuiltins` and `disableThinking` have been
// removed from the extension, so only the two-rule custom override precedence above applies.

const { CONFIG_DIR_NAME: PI_CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");

/**
 * Run sendTlhLaunchTelemetry against a fixture with optional user/project settings and return
 * the decoded telemetry payload.
 *
 * `projectSettings` semantics:
 *   - undefined      → no project config dir at all
 *   - null           → project config dir exists but contains no settings.json
 *   - string         → written verbatim (used for malformed JSON)
 *   - object         → JSON-stringified
 */
async function captureSubagentPayload(
  t,
  { userSettings, projectSettings, snapshot = {}, frontmatter } = {},
) {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-precedence-", {
    test: t,
    cwd: true,
  });
  writeTelemetryState(fixture);

  if (frontmatter !== undefined) {
    const subagentsDir = join(fixture.agent, "tlh", "agents", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "developer.md"), frontmatter);
  }

  if (userSettings !== undefined) {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(userSettings, null, 2)}\n`,
    );
  }

  if (projectSettings !== undefined) {
    const projectConfigDir = join(fixture.cwd, PI_CONFIG_DIR_NAME);
    mkdirSync(projectConfigDir, { recursive: true });
    if (projectSettings !== null) {
      const content =
        typeof projectSettings === "string"
          ? projectSettings
          : `${JSON.stringify(projectSettings, null, 2)}\n`;
      writeFileSync(join(projectConfigDir, "settings.json"), content);
    }
  }

  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        await sendTlhLaunchTelemetry({
          version: "1.2.3",
          cwd: fixture.cwd,
          ...snapshot,
        });
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(request, "expected telemetry fetch call");
  const [event] = JSON.parse(request.options?.body ?? "[]");
  assert.ok(event, "expected a telemetry event");
  return event.payload;
}

test("launch telemetry follows a registry-missing OpenRouter session model and normalized effort", async (t) => {
  const payload = await captureSubagentPayload(t, {
    snapshot: {
      providerId: "openrouter",
      modelId: "anthropic/claude-sonnet-4-5",
      availableModels: [],
    },
    frontmatter: [
      "---",
      "name: developer",
      "description: Developer",
      "tlhModelDefaults:",
      "  - provider: openrouter",
      "    effort: high",
      "---",
      "Prompt",
      "",
    ].join("\n"),
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-sonnet-4-5:high");
});

test("launch telemetry ignores invalid tlhOpenrouterThinking", async (t) => {
  const payload = await captureSubagentPayload(t, {
    snapshot: { providerId: "openrouter", modelId: "gpt-5.6-luna", availableModels: [] },
    frontmatter: [
      "---",
      "name: developer",
      "description: Developer",
      "tlhOpenrouterThinking: invalid",
      "---",
      "Prompt",
      "",
    ].join("\n"),
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "gpt-5.6-luna:unknown");
});

test("launch telemetry reports project-scope agentOverrides in preference to user scope", async (t) => {
  const payload = await captureSubagentPayload(t, {
    userSettings: {
      subagents: { agentOverrides: { developer: { thinking: "low", model: "claude-haiku-4-5" } } },
    },
    projectSettings: {
      subagents: { agentOverrides: { developer: { thinking: "max", model: "claude-opus-4-5" } } },
    },
  });

  assert.equal(
    payload["Tlh.Subagent.developer.modelEffort"],
    "claude-opus-4-5:max",
    "project scope must outrank user scope, combined as modelEffort",
  );
});

test("launch telemetry applies the winning scope's override wholesale rather than merging scopes", async (t) => {
  // applyCustomAgentOverrides picks ONE scope's override object; it never merges fields across
  // scopes. A project entry that sets only `thinking` therefore discards the user entry's
  // `model`, which falls back to frontmatter (absent here → "unknown").
  const payload = await captureSubagentPayload(t, {
    userSettings: { subagents: { agentOverrides: { oracle: { model: "claude-opus-4-5" } } } },
    projectSettings: { subagents: { agentOverrides: { oracle: { thinking: "high" } } } },
  });

  // Project thinking wins wholesale; user model is NOT merged → model side is "unknown".
  assert.equal(
    payload["Tlh.Subagent.oracle.modelEffort"],
    "unknown:high",
    "project thinking wins wholesale; user model must NOT be merged when project override wins",
  );
});

test("launch telemetry falls back to user-scope agentOverrides when the project has none for that agent", async (t) => {
  // `librarian` is overridden only in project scope; `developer` only in user scope. Each must
  // be reported from whichever scope actually configures it.
  const payload = await captureSubagentPayload(t, {
    userSettings: {
      subagents: { agentOverrides: { developer: { thinking: "high", model: "claude-opus-4-5" } } },
    },
    projectSettings: { subagents: { agentOverrides: { librarian: { thinking: "low" } } } },
  });

  assert.equal(
    payload["Tlh.Subagent.developer.modelEffort"],
    "claude-opus-4-5:high",
    "user override applies with no project entry for developer",
  );
  // librarian: project override sets only thinking → model side is "unknown".
  assert.equal(
    payload["Tlh.Subagent.librarian.modelEffort"],
    "unknown:low",
    "project override applies for librarian; model side is unknown (no model in override)",
  );
  assert.equal(
    payload["Tlh.Subagent.contrarian.modelEffort"],
    "unknown:unknown",
    "unconfigured agents stay unknown:unknown",
  );
});

test("launch telemetry degrades quietly to user scope when project settings are missing or unreadable", async (t) => {
  const userSettings = {
    subagents: { agentOverrides: { developer: { thinking: "high", model: "claude-opus-4-5" } } },
  };

  const cases = [
    ["no project config dir at all", undefined],
    ["project config dir without settings.json", null],
    ["malformed project settings JSON", "{ not json"],
    ["project settings that are a JSON array", "[]"],
    ["empty project settings file", ""],
    ["project settings without a subagents section", { theme: "whatever" }],
  ];

  for (const [label, projectSettings] of cases) {
    const payload = await captureSubagentPayload(t, { userSettings, projectSettings });
    assert.equal(
      payload["Tlh.Subagent.developer.modelEffort"],
      "claude-opus-4-5:high",
      `${label}: should fall back to user scope modelEffort`,
    );
    // Degrading must not drop the event or the other bundled keys.
    assert.equal(
      payload["Tlh.Subagent.web-scout.modelEffort"],
      "unknown:unknown",
      `${label}: other agents still reported as unknown:unknown`,
    );
  }
});

test("launch telemetry never emits a project-scope override for a non-bundled agent name", async (t) => {
  const payload = await captureSubagentPayload(t, {
    projectSettings: {
      subagents: {
        agentOverrides: {
          "skunkworks-secret": { thinking: "high", model: "internal/secret-model" },
        },
      },
    },
  });

  const leaked = Object.keys(payload).filter((key) => key.includes("skunkworks"));
  assert.deepEqual(
    leaked,
    [],
    "non-bundled project override names must never become telemetry keys",
  );
  assert.equal(
    payload["Tlh.Subagent.developer.modelEffort"],
    "unknown:unknown",
    "unconfigured bundled agents still emit unknown:unknown",
  );
});

test("launch telemetry honours a project-scope disabled override", async (t) => {
  const payload = await captureSubagentPayload(t, {
    userSettings: { subagents: { agentOverrides: { "repo-scout": { thinking: "high" } } } },
    projectSettings: { subagents: { agentOverrides: { "repo-scout": { disabled: true } } } },
  });

  assert.equal(
    payload["Tlh.Subagent.repo-scout.modelEffort"],
    "disabled",
    "project-scope disabled override must emit single token 'disabled'",
  );
});

test("project settings are filtered when launch telemetry is sent", async (t) => {
  // No payload value may carry a path, project name, or other user string: the reported values
  // are the same privacy-filtered sentinels regardless of where the project root lives.
  const payload = await captureSubagentPayload(t, {
    projectSettings: {
      subagents: { agentOverrides: { developer: { model: "/Users/someone/private/model.gguf" } } },
    },
  });
  // "/Users/someone/private/model.gguf" → last segment "model.gguf" → not on allowlist → "custom".
  // No thinking override → "unknown". Combined: "custom:unknown".
  assert.equal(
    payload["Tlh.Subagent.developer.modelEffort"],
    "custom:unknown",
    "unrecognised model strings must be filtered to 'custom'; combined as modelEffort",
  );
  for (const value of Object.values(payload)) {
    assert.doesNotMatch(
      String(value),
      /[/\\]/,
      `telemetry value must not contain a path separator: ${value}`,
    );
  }
});

// ── deferral tests ───────────────────────────────────────────────────────────

test("scheduleTlhLaunchTelemetry defers subagent frontmatter reads: no fetch before timer fires, fetch occurs after (behavioural)", async (t) => {
  // This test proves the deferral property at runtime: no settings read, no subagent
  // frontmatter read, and no fetch call may occur before the deferred timer fires.
  //
  // Observation mechanism: file-swap / late-write technique. We write SETTINGS_A to
  // settings.json BEFORE calling scheduleTlhLaunchTelemetry, then IMMEDIATELY (in the
  // same synchronous turn of the event loop, before any await) write SETTINGS_B.
  // The key property of sendTlhLaunchTelemetry: its very first statement is a
  // synchronous `readTlhLaunchSettings()` call — BEFORE the first `await`. With
  // correct deferral, that call only happens inside the timer callback, AFTER the swap
  // (gets SETTINGS_B). With deferral removed the call happens synchronously INSIDE
  // scheduleTlhLaunchTelemetry, BEFORE the swap (gets SETTINGS_A). The telemetry
  // payload then proves which settings were used, making the assertion fail for the
  // non-deferred regression.
  //
  // Why it cannot pass vacuously:
  // - If no settings read occurs → payload uses default thinking=unknown → assertion fails.
  // - If settings are read with SETTINGS_A → payload thinking="low" → assertion fails.
  // - Only if settings are read with SETTINGS_B → payload thinking="high" → assertion passes.
  // There is no way for the assertion to pass without a REAL readTlhLaunchSettings call
  // that happens AFTER the swap (i.e., inside the deferred callback).
  //
  // Why direct readFileSync spy is not used: jiti resolves `node:fs` via a native ESM
  // namespace object that is separate from and not affected by patching
  // require("node:fs"). The namespace is immutable ([object Module]); there is no way
  // to intercept readFileSync calls from jiti-loaded modules from outside. The
  // file-swap approach bypasses this by observing the EFFECT of the read (settings
  // content reflected in payload) rather than the read mechanism itself.
  //
  // Note: scheduleTlhLaunchTelemetry has a module-level sentTlhLaunchTelemetry guard
  // (one-shot dedup). This is the only test that calls it so the guard does not
  // interfere.
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-deferral-behav-", { test: t });
  writeTelemetryState(fixture);

  // SETTINGS_A: active when scheduleTlhLaunchTelemetry is called. With deferral removed,
  // readTlhLaunchSettings runs synchronously inside the call and reads this content.
  // The settings structure follows the schema parsed by readTlhLaunchSettings:
  // { subagents: { agentOverrides: { <name>: { thinking, model } } } }
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "low" } } } }) + "\n",
  );

  // Write a subagent frontmatter file so that buildSubagentTelemetryPayload has
  // genuine file I/O to perform and the scenario is not trivially opt-out.
  // (With a settings override present, frontmatter is still read for other fields;
  // the file also ensures the scenario is non-trivial regardless of override logic.)
  const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, "developer.md"),
    "---\nname: developer\nthinking: medium\nmodel: claude-opus-4-5\n---\nBody.\n",
  );

  const previousFetch = globalThis.fetch;
  let fetchCallCount = 0;
  let capturedFetchBody = null;
  globalThis.fetch = async (_url, options) => {
    capturedFetchBody = options?.body ?? null;
    fetchCallCount++;
    return { ok: true, status: 200, statusText: "OK" };
  };

  try {
    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        TLH_TELEMETRY_NAMESPACE: "test-namespace",
        TLH_TELEMETRY_APP_ID: "test-app-id",
        TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace/",
        PI_OFFLINE: undefined,
        TLH_SKIP_TELEMETRY: undefined,
        TLH_TELEMETRY_DISABLED: undefined,
        PI_TELEMETRY: undefined,
      },
      async () => {
        // Hold the setTimeout so the deferred work cannot fire yet.
        // `now: Date.now()` is required: plain `enable(["setTimeout"])` mocks
        // Date.now() to return 0 (epoch). While the Date mock does not affect
        // sendTlhLaunchTelemetry directly, the pattern is made explicit here
        // for consistency and to guard against future logic that may use
        // Date.now() inside the deferred callback.
        t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });

        // Minimal ExtensionContext stub — only the fields scheduleTlhLaunchTelemetry reads.
        // modelRegistry: null is a valid input to getUnfilteredAvailableModels which
        // gracefully returns [] for falsy inputs (no I/O, just an in-memory guard).
        const mockCtx = {
          model: { provider: "anthropic", id: "claude-opus-4-5" },
          thinkingLevel: "medium",
          modelRegistry: null,
        };
        scheduleTlhLaunchTelemetry(mockCtx, "architect");

        // SETTINGS_B written SYNCHRONOUSLY (no await between here and the call above).
        // With correct deferral, readTlhLaunchSettings has not yet run (timer pending);
        // it will run inside the timer callback and will see SETTINGS_B (thinking=high).
        // With deferral removed, readTlhLaunchSettings already ran above (thinking=low);
        // this overwrite is too late to affect the captured launchSettings.
        writeFileSync(
          settingsPath,
          JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high" } } } }) +
            "\n",
        );

        // BEFORE the timer fires: no fetch call should have occurred.
        assert.equal(
          fetchCallCount,
          0,
          "no fetch calls should occur before the deferred timer fires",
        );

        // Fire the captured timer. sendTlhLaunchTelemetry starts running;
        // it reads settings (SETTINGS_B due to the swap above) and eventually calls fetch.
        t.mock.timers.tick(0);

        // Restore real timers before draining so that async operations
        // (getTlhOsMetadata spawns sw_vers, sendTlhTelemetry calls fetch)
        // can complete normally.
        t.mock.timers.reset();

        // Drain the async continuation deterministically: each setImmediate
        // yield gives the event loop one cycle to process pending I/O and
        // microtasks (including the sw_vers child-process exit and fetch).
        // The deadline guards against an infinite loop on unexpected failures.
        const drainDeadline = Date.now() + 5000;
        while (fetchCallCount === 0 && Date.now() < drainDeadline) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        // AFTER the timer fires: settings were read (SETTINGS_B) and fetch was called.
        assert.ok(
          fetchCallCount > 0,
          "fetch should have been called after the deferred timer fires",
        );

        // Primary deferral assertion: the telemetry payload must reflect SETTINGS_B
        // (thinking=high), not SETTINGS_A (thinking=low). This can only be true if
        // readTlhLaunchSettings ran AFTER the file swap — i.e., inside the deferred
        // timer callback, not synchronously inside scheduleTlhLaunchTelemetry.
        //
        // The frontmatter has model: claude-opus-4-5 (bare name, always resolves to
        // "claude-opus-4-5") and SETTINGS_B overrides thinking to "high" (no model
        // override). Combined modelEffort: "claude-opus-4-5:high".
        const events = JSON.parse(capturedFetchBody ?? "[]");
        const event = events[0];
        assert.ok(event, "fetch body must contain at least one telemetry event");
        assert.equal(
          event.payload["Tlh.Subagent.developer.modelEffort"],
          "claude-opus-4-5:high",
          "Tlh.Subagent.developer.modelEffort must be 'claude-opus-4-5:high' (from SETTINGS_B thinking=high + " +
            "frontmatter model=claude-opus-4-5), not 'claude-opus-4-5:low' (SETTINGS_A) or 'claude-opus-4-5:unknown' — " +
            "proving readTlhLaunchSettings ran inside the deferred timer callback, not synchronously before it",
        );
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    // Ensure mock timers are always restored (idempotent after reset()).
    try {
      t.mock.timers.reset();
    } catch {
      /* already reset */
    }
  }
});
