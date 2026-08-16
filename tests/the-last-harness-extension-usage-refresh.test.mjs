import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");

const theme = {
  fg: (_color, text) => text,
};

const footerData = {
  getGitBranch: () => undefined,
  getAvailableProviderCount: () => 1,
  getExtensionStatuses: () => new Map(),
};

function createPi() {
  const handlers = new Map();
  let activeTools = ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"];
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerShortcut() {},
    appendEntry() {},
    getAllTools: () => activeTools.map((name) => ({ name })),
    getActiveTools: () => activeTools,
    setActiveTools(tools) {
      activeTools = [...tools];
    },
    getThinkingLevel: () => "medium",
    setThinkingLevel() {},
    setModel: async () => true,
  };
}

function createCtx(options) {
  const provider = options.provider ?? "anthropic";
  return {
    hasUI: true,
    cwd: options.cwd,
    model: {
      provider,
      id:
        options.modelId ??
        (provider === "anthropic" ? "claude-sonnet-4-20250514" : `${provider}-model`),
      contextWindow: 200000,
    },
    modelRegistry: {
      isUsingOAuth: (model) => options.isUsingOAuth?.(model) ?? model?.provider === "anthropic",
      getApiKeyForProvider: async (targetProvider) =>
        targetProvider === provider ? options.currentAccessToken?.() : undefined,
      find: () => undefined,
      authStorage: options.authStorage,
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => options.cwd,
      getSessionName: () => undefined,
      getBranch: () => undefined,
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 12.3 }),
    ui: {
      addAutocompleteProvider() {},
      setFooter(factory) {
        factory({ requestRender: options.requestRender }, theme, footerData);
      },
      setHeader() {},
      notify() {},
      getEditorText: () => "",
    },
    isIdle: () => true,
  };
}

async function eventually(predicate, message, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  assert.ok(predicate(), message);
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// Fire all registered handlers for an event, mirroring the Pi runtime which
// calls every registered handler in registration order (not just the first).
async function fireAll(pi, event, eventArg, ctx) {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(eventArg, ctx);
  }
}

function writeFakeCommand(fakebin, name, body) {
  mkdirSync(fakebin, { recursive: true });
  const commandPath = join(fakebin, name);
  writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(commandPath, 0o755);
}

test("git cache refresh requests a footer render without unrelated UI activity", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-git-footer-refresh-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const fakebin = join(tempDir, "fakebin");
  const previousEnv = {
    PATH: process.env.PATH,
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };

  let renderRequests = 0;
  const authStorage = {
    runtimeOverrides: new Map(),
    get: () => undefined,
  };

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    process.env.PATH = `${fakebin}:${previousEnv.PATH ?? ""}`;
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );
    writeFakeCommand(
      fakebin,
      "git",
      `cat <<'EOF'
# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head (detached)
EOF`,
    );
    writeFakeCommand(fakebin, "gh", "exit 1");

    const pi = createPi();
    theLastHarness(pi);
    const ctx = createCtx({
      cwd,
      provider: "example-provider",
      authStorage,
      isUsingOAuth: () => false,
      requestRender: () => {
        renderRequests += 1;
      },
    });

    await fireAll(pi, "session_start", { reason: "restore" }, ctx);
    await eventually(
      () => renderRequests === 1,
      "initial git cache refresh should request one footer render",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      renderRequests,
      1,
      "git cache refresh should be the only render trigger in this scenario",
    );
  } finally {
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session start refreshes weekly visibility once and repeated footer renders use the cached value", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-weekly-cache-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const originalCreate = SettingsManager.create;

  let footer;
  let settingsReads = 0;

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { usageLimits: { showWeekly: true }, primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );

    SettingsManager.create = (...args) => {
      settingsReads += 1;
      return originalCreate(...args);
    };

    const pi = createPi();
    theLastHarness(pi);
    const ctx = createCtx({
      cwd,
      provider: "openai-codex",
      authStorage: { runtimeOverrides: new Map(), get: () => undefined },
      isUsingOAuth: () => false,
    });
    ctx.ui.setFooter = (factory) => {
      footer = factory({ requestRender() {} }, theme, footerData);
    };

    await fireAll(pi, "session_start", { reason: "restore" }, ctx);
    const readsAfterSessionStart = settingsReads;
    assert.ok(
      readsAfterSessionStart >= 1,
      "session start should refresh the weekly-visibility cache",
    );
    assert.ok(footer, "session start should install a footer");
    footer.render(100);
    footer.render(100);
    assert.equal(settingsReads, readsAfterSessionStart, "footer renders must not reread settings");
  } finally {
    SettingsManager.create = originalCreate;
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("subscription usage footer first render stays synchronous before the lazy service loads", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-first-render-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const previousFetch = globalThis.fetch;

  let fetchCalls = 0;
  let renderRequests = 0;
  let firstRenderLines;
  const credential = { type: "oauth", access: "oauth-access-token" };
  const authStorage = {
    runtimeOverrides: new Map(),
    get: (provider) => (provider === "anthropic" ? credential : undefined),
  };

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "tlh"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );
    writeFileSync(
      join(agentDir, "tlh", "install-state.json"),
      `${JSON.stringify({ repo: "diegopetrucci/the-last-harness", track: "latest-release", ref: "v1.0.0", packageSource: "npm:@diegopetrucci/the-last-harness@1.0.0", packageSourceIsDefault: true }, null, 2)}\n`,
    );

    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 4, limit: 10 } }),
      };
    };

    const pi = createPi();
    theLastHarness(pi);
    const ctx = createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        renderRequests += 1;
      },
    });
    ctx.ui.setFooter = (factory) => {
      const footer = factory(
        {
          requestRender: () => {
            renderRequests += 1;
          },
        },
        theme,
        footerData,
      );
      firstRenderLines = footer.render(100);
      assert.equal(fetchCalls, 0, "first footer render must not wait for or trigger usage loading");
    };

    await fireAll(pi, "session_start", { reason: "restore" }, ctx);
    assert.ok(Array.isArray(firstRenderLines), "first footer render should complete synchronously");
    assert.equal(
      firstRenderLines[2] ?? "",
      "",
      "first footer render should tolerate the empty lazy-load snapshot",
    );
    await eventually(
      () => fetchCalls === 1 && renderRequests === 1,
      "lazy refresh should load usage and request one rerender",
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("subscription usage refresh requests a footer render when a runtime override clears active usage", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-refresh-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const previousFetch = globalThis.fetch;

  let fetchCalls = 0;
  let renderRequests = 0;
  let returnedAccessToken = "oauth-access-token";
  const credential = { type: "oauth", access: "oauth-access-token" };
  const authStorage = {
    runtimeOverrides: new Map(),
    get: (provider) => (provider === "anthropic" ? credential : undefined),
  };

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "tlh"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );
    writeFileSync(
      join(agentDir, "tlh", "install-state.json"),
      `${JSON.stringify({ repo: "diegopetrucci/the-last-harness", track: "latest-release", ref: "v1.0.0", packageSource: "npm:@diegopetrucci/the-last-harness@1.0.0", packageSourceIsDefault: true }, null, 2)}\n`,
    );

    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 4, limit: 10 } }),
      };
    };

    const pi = createPi();
    theLastHarness(pi);
    const ctxOptions = {
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        renderRequests += 1;
      },
    };
    const ctx = createCtx(ctxOptions);

    await fireAll(pi, "session_start", { reason: "restore" }, ctx);
    await eventually(
      () => fetchCalls === 1 && renderRequests === 1,
      "initial usage fetch should request one footer render",
    );

    renderRequests = 0;
    returnedAccessToken = "runtime-api-key";
    authStorage.runtimeOverrides.set("anthropic", "runtime-api-key");

    void fireAll(pi, "model_select", {}, ctx);
    await eventually(
      () => renderRequests === 1,
      "clearing active usage should request a footer render",
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("subscription usage refresh renders only the footer for the refreshed context", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-context-scope-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const previousFetch = globalThis.fetch;

  let fetchCalls = 0;
  let contextARenderRequests = 0;
  let contextBRenderRequests = 0;
  let returnedAccessToken = "oauth-access-token";
  const credential = { type: "oauth", access: "oauth-access-token" };
  const authStorage = {
    runtimeOverrides: new Map(),
    get: (provider) => (provider === "anthropic" ? credential : undefined),
  };

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );

    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 4, limit: 10 } }),
      };
    };

    const pi = createPi();
    theLastHarness(pi);
    assert.ok(
      (pi.handlers.get("session_start")?.length ?? 0) >= 1,
      "session_start handler must be registered by the extension",
    );
    const ctxA = createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        contextARenderRequests += 1;
      },
    });
    const ctxB = createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        contextBRenderRequests += 1;
      },
    });

    await fireAll(pi, "session_start", { reason: "restore" }, ctxA);
    await eventually(
      () => fetchCalls === 1 && contextARenderRequests === 1,
      "initial usage fetch should request a render for the first context",
    );
    await fireAll(pi, "session_start", { reason: "restore" }, ctxB);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      contextBRenderRequests,
      0,
      "registering a second context should not render when usage is unchanged",
    );

    contextARenderRequests = 0;
    contextBRenderRequests = 0;
    returnedAccessToken = "runtime-api-key";
    authStorage.runtimeOverrides.set("anthropic", "runtime-api-key");

    void fireAll(pi, "model_select", {}, ctxA);
    await eventually(
      () => contextARenderRequests + contextBRenderRequests === 1,
      "refreshing the first context should request exactly one footer render",
    );

    assert.equal(
      contextARenderRequests,
      1,
      "refreshing context A should render context A's footer",
    );
    assert.equal(
      contextBRenderRequests,
      0,
      "refreshing context A must not render context B's footer",
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rapid turn_end burst collapses to a single fetch and no extra renders when the snapshot is unchanged", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-burst-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const previousFetch = globalThis.fetch;

  let fetchCalls = 0;
  let renderRequests = 0;
  const credential = { type: "oauth", access: "oauth-access-token" };
  const authStorage = {
    runtimeOverrides: new Map(),
    get: (provider) => (provider === "anthropic" ? credential : undefined),
  };

  try {
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TLH_SKIP_UPDATE_CHECK = "1";
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
    );

    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 4, limit: 10 } }),
      };
    };

    const pi = createPi();
    theLastHarness(pi);
    const ctx = createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        renderRequests += 1;
      },
    });

    // session_start primes the snapshot and the throttle bookkeeping so the
    // subsequent turn_end burst exercises the steady-state path the user
    // actually triggers between turns.
    await fireAll(pi, "session_start", { reason: "restore" }, ctx);
    await eventually(
      () => fetchCalls === 1 && renderRequests === 1,
      "initial usage fetch should populate the snapshot before the burst",
    );

    // Reset render bookkeeping so we can prove the burst itself emits zero
    // renders. fetchCalls intentionally stays at 1 so the final assertion
    // captures the total network call count across the whole lifecycle.
    renderRequests = 0;

    assert.ok(
      (pi.handlers.get("turn_end")?.length ?? 0) > 0,
      "turn_end handler must be registered by the extension",
    );

    // Production wiring registers turn_end as a synchronous handler that
    // fires refreshSubscriptionUsage() without awaiting, so we mirror that
    // by invoking it 20 times in a tight loop without yielding between
    // calls. This is the worst-case shape of a real burst.
    for (let i = 0; i < 20; i += 1) {
      void fireAll(pi, "turn_end", {}, ctx);
    }

    // Drain microtasks once. Node flushes the entire microtask queue
    // before running setImmediate, so every queued refresh() promise chain
    // resolves before we assert.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      fetchCalls,
      1,
      "a rapid turn_end burst must not produce additional fetches (throttle + in-flight dedupe collapse the storm)",
    );
    assert.equal(
      renderRequests,
      0,
      "a rapid turn_end burst must not request renders when the snapshot and eligibility are unchanged",
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
