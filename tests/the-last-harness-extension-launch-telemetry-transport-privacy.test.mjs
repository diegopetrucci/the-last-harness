import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  EXISTING_INSTALL_ID,
  telemetryStatePath,
  writeTelemetryState,
} from "./support/the-last-harness-extension-launch-telemetry-fixtures.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_LAUNCH_TELEMETRY_EVENT_TYPE, TLH_NAME } = await jiti.import(
  "../extensions/the-last-harness/constants.ts",
);
const { CI_FAILURE_INVESTIGATION_FEATURE, DELTA_FOLLOW_UP_REVIEWS_FEATURE } = await jiti.import(
  "../extensions/the-last-harness/experimental.ts",
);
const { THINKING_LEVELS } = await jiti.import("../extensions/the-last-harness/constants.ts");
const {
  privacySafeTlhTelemetryProviderId,
  privacySafeTlhTelemetryThinkingLevel,
  privacySafeTlhTelemetryModelId,
  sendTlhLaunchTelemetry,
} = await jiti.import("../extensions/the-last-harness/launch-telemetry.ts");

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
