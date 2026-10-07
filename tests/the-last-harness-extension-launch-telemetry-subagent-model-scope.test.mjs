import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import { writeTelemetryState } from "./support/the-last-harness-extension-launch-telemetry-fixtures.mjs";

const jiti = createJiti(import.meta.url);
const { scheduleTlhLaunchTelemetry, sendTlhLaunchTelemetry } = await jiti.import(
  "../extensions/the-last-harness/launch-telemetry.ts",
);

const { CONFIG_DIR_NAME: PI_CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");

/**
 * `projectSettings` semantics:
 *   - undefined → no project config dir
 *   - null → project config dir exists but contains no settings.json
 *   - string → written verbatim
 *   - object → JSON-stringified
 */
async function captureSubagentPayload(
  t,
  {
    userSettings,
    projectSettings,
    snapshot = {},
    frontmatter,
    agent = "developer",
    isolateProjectRoot = true,
  } = {},
) {
  const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-precedence-", {
    test: t,
    cwd: isolateProjectRoot,
  });
  writeTelemetryState(fixture);

  if (frontmatter !== undefined) {
    const subagentsDir = join(fixture.agent, "tlh", "agents", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `${agent}.md`), frontmatter);
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
          ...(isolateProjectRoot ? { cwd: fixture.cwd } : {}),
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

const developerProviderDefaults = `---
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
`;

test("launch telemetry emits all nine bundled subagent keys with unknown:unknown when no config present", async (t) => {
  const payload = await captureSubagentPayload(t, { isolateProjectRoot: false });
  const bundledNames = [
    "code-reviewer",
    "contrarian",
    "developer",
    "diff-summarizer",
    "librarian",
    "oracle",
    "repo-scout",
    "test-runner",
    "web-scout",
  ];
  for (const name of bundledNames) {
    assert.equal(
      payload[`Tlh.Subagent.${name}.modelEffort`],
      "unknown:unknown",
      `expected unknown:unknown modelEffort for ${name}`,
    );
  }
  const thinkingKeys = Object.keys(payload).filter((key) => key.endsWith(".thinking"));
  assert.deepEqual(thinkingKeys, [], "no emitted payload key should end in '.thinking'");
});

test("launch telemetry reflects settings agentOverrides thinking change", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    userSettings: {
      subagents: {
        agentOverrides: { developer: { thinking: "high", model: "claude-opus-4-5" } },
      },
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-opus-4-5:high");
  assert.equal(payload["Tlh.Subagent.librarian.modelEffort"], "unknown:unknown");
});

test("launch telemetry reflects hand-edited frontmatter thinking value", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "librarian",
    frontmatter:
      "---\nname: librarian\nthinking: medium\nmodel: claude-opus-4-5\n---\nPrompt body here.\n",
  });
  assert.equal(payload["Tlh.Subagent.librarian.modelEffort"], "claude-opus-4-5:medium");
});

test("launch telemetry: settings agentOverrides wins over frontmatter", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "oracle",
    frontmatter: "---\nname: oracle\nthinking: low\nmodel: gpt-4o\n---\nPrompt body.\n",
    userSettings: {
      subagents: { agentOverrides: { oracle: { thinking: "max", model: "claude-opus-4-5" } } },
    },
  });
  assert.equal(payload["Tlh.Subagent.oracle.modelEffort"], "claude-opus-4-5:max");
});

test("launch telemetry: disabled agentOverride is reported as 'disabled' (single token)", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    userSettings: { subagents: { agentOverrides: { "repo-scout": { disabled: true } } } },
  });
  assert.equal(payload["Tlh.Subagent.repo-scout.modelEffort"], "disabled");
});

test("launch telemetry never emits keys for agent names outside the bundled nine", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    userSettings: {
      subagents: { agentOverrides: { skunkworks: { thinking: "high", model: "secret-model" } } },
    },
  });
  const unbundledKeys = Object.keys(payload).filter(
    (key) => key.startsWith("Tlh.Subagent.") && key.includes("skunkworks"),
  );
  assert.equal(unbundledKeys.length, 0, "no telemetry key should exist for non-bundled agent name");
});

test("launch telemetry: non-public model in frontmatter is reported as 'custom'", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "contrarian",
    frontmatter:
      "---\nname: contrarian\nthinking: high\nmodel: acme-internal/super-secret-model\n---\nBody.\n",
    snapshot: {
      availableModels: [{ provider: "acme-internal", id: "super-secret-model" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.contrarian.modelEffort"], "custom:high");
});

test("launch telemetry reports provider-aware defaults for bundled agents (Anthropic active)", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter: developerProviderDefaults,
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-sonnet-4-6:medium");
});

test("launch telemetry reports provider-aware defaults for bundled agents (OpenAI active)", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter: developerProviderDefaults,
    snapshot: {
      providerId: "openai-codex",
      availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "gpt-5.6-luna:max");
  assert.notEqual(payload["Tlh.Subagent.developer.modelEffort"], "claude-sonnet-4-6:medium");
});

test("launch telemetry uses normalized provider entries and ignores generic compatibility fields in a present block", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter: `---
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
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-sonnet-4-6:medium");
});

test("launch telemetry handles quoted frontmatter model values", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "librarian",
    frontmatter:
      "---\nname: librarian\ntlhAnthropicModels: 'anthropic/claude-haiku-4-5'\ntlhAnthropicThinking: \"high\"\n---\nBody.\n",
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.librarian.modelEffort"], "claude-haiku-4-5:high");
});

test("launch telemetry handles list-valued model fields (comma-separated tlhOpenaiModels)", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "oracle",
    frontmatter:
      "---\nname: oracle\ntlhOpenaiModels: openai-codex/gpt-5.6-sol, openai/gpt-4o\ntlhAnthropicModels: anthropic/claude-opus-5\ntlhOpenaiThinking: high\ntlhAnthropicThinking: high\n---\nBody.\n",
    snapshot: {
      providerId: "openai-codex",
      availableModels: [
        { provider: "openai-codex", id: "gpt-5.6-sol" },
        { provider: "openai", id: "gpt-4o" },
      ],
    },
  });
  assert.equal(payload["Tlh.Subagent.oracle.modelEffort"], "gpt-5.6-sol:high");
});

test("launch telemetry: model: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter:
      "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
    userSettings: { subagents: { agentOverrides: { developer: { model: false } } } },
    snapshot: { providerId: "anthropic" },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "cleared:medium");
});

test("launch telemetry: thinking: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter:
      "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
    userSettings: { subagents: { agentOverrides: { developer: { thinking: false } } } },
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-sonnet-4-6:cleared");
});

test("launch telemetry: settings override wins over provider-aware frontmatter", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter:
      "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
    userSettings: {
      subagents: {
        agentOverrides: { developer: { thinking: "high", model: "anthropic/claude-opus-5" } },
      },
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "claude-opus-5:high");
});

test("registry-accurate: provider-aware candidate NOT available is reported as 'unknown'", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    frontmatter:
      "---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.developer.modelEffort"], "unknown:medium");
});

test("registry-accurate: empty availableModels yields 'unknown' for provider-qualified model fields", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "librarian",
    frontmatter:
      "---\nname: librarian\ntlhAnthropicModels: anthropic/claude-haiku-4-5\ntlhAnthropicThinking: low\n---\nBody.\n",
    snapshot: { providerId: "anthropic" },
  });
  assert.equal(payload["Tlh.Subagent.librarian.modelEffort"], "unknown:low");
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model IS available is reported", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "contrarian",
    frontmatter:
      "---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.contrarian.modelEffort"], "gpt-5.6-luna:max");
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model NOT available yields same-provider fallback", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "contrarian",
    frontmatter:
      "---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
    },
  });
  assert.notEqual(payload["Tlh.Subagent.contrarian.modelEffort"], "gpt-5.6-luna:max");
  assert.equal(payload["Tlh.Subagent.contrarian.modelEffort"], "claude-sonnet-4-6:medium");
});

test("registry-accurate: hand-edited generic model: field wins when provider-aware models unavailable", async (t) => {
  const payload = await captureSubagentPayload(t, {
    isolateProjectRoot: false,
    agent: "oracle",
    frontmatter:
      "---\nname: oracle\nmodel: anthropic/claude-opus-5\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: high\n---\nBody.\n",
    snapshot: {
      providerId: "anthropic",
      availableModels: [{ provider: "anthropic", id: "claude-opus-5" }],
    },
  });
  assert.equal(payload["Tlh.Subagent.oracle.modelEffort"], "claude-opus-5:high");
});

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
  // File-swap stands in for a readFileSync spy: jiti's node:fs namespace is immutable.
  // SETTINGS_B is written synchronously after schedule and must be what the deferred read observes.
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
