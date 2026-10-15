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
  const footerComponents = [];
  let disposed = false;
  const trackFooter = (component) => {
    if (disposed) {
      component?.dispose?.();
    } else {
      footerComponents.push(component);
    }
    return component;
  };
  const disposeFooters = () => {
    disposed = true;
    let firstError;
    for (const component of footerComponents.splice(0).reverse()) {
      try {
        component?.dispose?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
  const ctx = {
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
        trackFooter(factory({ requestRender: options.requestRender }, theme, footerData));
      },
      setHeader() {},
      notify() {},
      getEditorText: () => "",
    },
    isIdle: () => true,
    trackFooter,
    disposeFooters,
  };
  return ctx;
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

function createTestSession() {
  const pi = createPi();
  const contexts = [];
  return {
    pi,
    createCtx(options) {
      const ctx = createCtx(options);
      contexts.push(ctx);
      return ctx;
    },
    async dispose() {
      let firstError;
      for (const ctx of [...contexts].reverse()) {
        try {
          ctx.disposeFooters();
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        await fireAll(pi, "session_shutdown", {}, contexts.at(-1));
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) throw firstError;
    },
  };
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
  const session = createTestSession();

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

    const { pi } = session;
    theLastHarness(pi);
    const ctx = session.createCtx({
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
    try {
      await session.dispose();
    } finally {
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
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
  const session = createTestSession();

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

    const { pi } = session;
    theLastHarness(pi);
    const ctx = session.createCtx({
      cwd,
      provider: "openai-codex",
      authStorage: { runtimeOverrides: new Map(), get: () => undefined },
      isUsingOAuth: () => false,
    });
    ctx.ui.setFooter = (factory) => {
      footer = ctx.trackFooter(factory({ requestRender() {} }, theme, footerData));
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
    try {
      await session.dispose();
    } finally {
      SettingsManager.create = originalCreate;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
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
  const session = createTestSession();
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

    const { pi } = session;
    theLastHarness(pi);
    const ctx = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        renderRequests += 1;
      },
    });
    ctx.ui.setFooter = (factory) => {
      const footer = ctx.trackFooter(
        factory(
          {
            requestRender: () => {
              renderRequests += 1;
            },
          },
          theme,
          footerData,
        ),
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
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
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
  const session = createTestSession();
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

    const { pi } = session;
    theLastHarness(pi);
    const ctxOptions = {
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        renderRequests += 1;
      },
    };
    const ctx = session.createCtx(ctxOptions);

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
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("subscription usage refresh redraws the footer when the event context differs from the footer registration context", async () => {
  // Regression test for the cross-context redraw bug: Pi's ExtensionRunner
  // creates a fresh ExtensionContext for each dispatched event, so the ctx
  // passed to model_select or turn_end is a different object from the ctx
  // passed to session_start (where the footer factory runs and registers the
  // render callback). The facade must not use context identity to locate the
  // render callback; it must call the currently registered render callback
  // regardless of which event context triggered the refresh.
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-ctx-distinct-"));
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
  const session = createTestSession();
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

    const { pi } = session;
    theLastHarness(pi);

    // ctxSession is the context passed to session_start and used inside the
    // footer factory to register the render callback.
    const ctxSession = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        renderRequests += 1;
      },
    });

    await fireAll(pi, "session_start", { reason: "restore" }, ctxSession);
    await eventually(
      () => fetchCalls === 1 && renderRequests === 1,
      "initial usage fetch should request a render via the registration context",
    );

    renderRequests = 0;
    returnedAccessToken = "runtime-api-key";
    authStorage.runtimeOverrides.set("anthropic", "runtime-api-key");

    // ctxEvent is a DISTINCT context object, simulating the fresh context Pi
    // creates per event. It has the same provider/auth so the service uses the
    // same snapshot key, but it is not the same object as ctxSession.
    const ctxEvent = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        // This render callback belongs to ctxEvent, which never had its footer
        // factory called; the facade must NOT call this.
        throw new Error("ctxEvent render callback must not be invoked");
      },
    });

    // This is the key difference from the pre-fix code: the event fires with
    // ctxEvent, not ctxSession. The WeakMap lookup on ctxEvent returned
    // undefined, silently suppressing the footer redraw.
    void fireAll(pi, "model_select", {}, ctxEvent);
    await eventually(
      () => renderRequests === 1,
      "refresh triggered from a distinct event context must still redraw the registered footer",
    );
    assert.equal(fetchCalls, 1);
  } finally {
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("turn_end refresh with a context distinct from registration redraws the footer when the snapshot changes", async () => {
  // Companion regression test to the model_select variant: turn_end events
  // also arrive with a fresh context that is different from the session_start
  // context used when the footer registered its render callback.
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-turnend-distinct-"));
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
  const session = createTestSession();
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

    const { pi } = session;
    theLastHarness(pi);

    // ctxSession is used for session_start; the footer factory registers the
    // render callback against this session.
    const ctxSession = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        renderRequests += 1;
      },
    });

    await fireAll(pi, "session_start", { reason: "restore" }, ctxSession);
    await eventually(
      () => fetchCalls === 1 && renderRequests === 1,
      "initial usage fetch should request a render via the registration context",
    );

    renderRequests = 0;
    returnedAccessToken = "runtime-api-key";
    authStorage.runtimeOverrides.set("anthropic", "runtime-api-key");

    // ctxTurnEnd is a DISTINCT object, as Pi creates per event. It must not
    // prevent the registered footer callback from firing.
    const ctxTurnEnd = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => returnedAccessToken,
      requestRender: () => {
        throw new Error("ctxTurnEnd render callback must not be invoked directly");
      },
    });

    void fireAll(pi, "turn_end", {}, ctxTurnEnd);
    await eventually(
      () => renderRequests === 1,
      "turn_end refresh from a distinct context must still redraw the registered footer",
    );
    assert.equal(fetchCalls, 1);
  } finally {
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("pending refresh before session_shutdown does not redraw the old footer", async () => {
  // Tests AC #3 (shutdown): a refresh that STARTS before session_shutdown must
  // not redraw when it resolves after shutdown. The session-token guard and
  // clearFooterRenderRequest() together prevent the stale render.
  //
  // The initial session_start refresh is used as the "pending" refresh: all
  // fetches are deferred so that session_shutdown fires while the initial
  // refresh is still in flight.
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-pending-shutdown-"));
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
  const session = createTestSession();
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

    // All fetches are deferred so the session_start refresh is in flight when
    // session_shutdown fires.
    const pendingFetches = [];
    globalThis.fetch = () => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        pendingFetches.push(resolve);
      });
    };
    const resolveNextFetch = (used) => {
      pendingFetches.shift()?.({
        ok: true,
        json: async () => ({ five_hour: { used, limit: 10 } }),
      });
    };

    const { pi } = session;
    theLastHarness(pi);
    const ctx = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        renderRequests += 1;
      },
    });

    // session_start registers callback_A and immediately queues the initial
    // refresh. The fetch is deferred, so the refresh is in flight.
    void fireAll(pi, "session_start", { reason: "restore" }, ctx);
    await eventually(
      () => pendingFetches.length >= 1,
      "session_start initial refresh must queue a fetch before session_shutdown fires",
    );
    assert.equal(renderRequests, 0, "no render before fetch resolves");

    // session_shutdown fires while the refresh is in flight.
    await fireAll(pi, "session_shutdown", {}, ctx);

    // Resolve the deferred fetch with a snapshot that would otherwise trigger a
    // render. The session-token guard on callback_A and clearFooterRenderRequest()
    // must both prevent any redraw.
    resolveNextFetch(1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(
      renderRequests,
      0,
      "pending refresh must not redraw the old footer after session_shutdown",
    );
  } finally {
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("pending refresh before session switch redraws the new session's footer when it settles, not the old session's footer", async () => {
  // Tests AC #1 (session switch): a refresh that starts during session A must
  // redraw session B's footer (not A's) when it settles after the switch.
  //
  // Mechanism: session_start A queues an initial refresh with fetch deferred.
  // session_start B invalidates A's token and overwrites the registered
  // callback with callback_B. Resolving A's deferred fetch causes the facade
  // to call this.currentFooterRender (now callback_B). callback_B passes its
  // own token guard and redraws B's footer exactly once. A's footer is never
  // touched.
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-pending-switch-"));
  const agentDir = join(tempDir, "agent");
  const cwd = join(tempDir, "workspace");
  const previousEnv = {
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
  };
  const previousFetch = globalThis.fetch;

  let fetchCalls = 0;
  let ctxARenders = 0;
  let ctxBRenders = 0;
  const session = createTestSession();
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

    // All fetches are deferred so session_start A's initial refresh is in
    // flight when session_start B fires. Session A and B share the same OAuth
    // credential (same cache key), so session B's own refresh is throttled and
    // only one fetch is ever in flight.
    const pendingFetches = [];
    globalThis.fetch = () => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        pendingFetches.push(resolve);
      });
    };
    const resolveNextFetch = (used) => {
      pendingFetches.shift()?.({
        ok: true,
        json: async () => ({ five_hour: { used, limit: 10 } }),
      });
    };

    const { pi } = session;
    theLastHarness(pi);

    // ctxA and ctxB share the same authStorage so they resolve to the same
    // subscription cache key. The session-token guard distinguishes them.
    const ctxA = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        ctxARenders += 1;
      },
    });
    const ctxB = session.createCtx({
      cwd,
      authStorage,
      currentAccessToken: () => "oauth-access-token",
      requestRender: () => {
        ctxBRenders += 1;
      },
    });

    // --- Session A ---
    // session_start A registers callback_A and queues the initial refresh.
    // The fetch is deferred, so the refresh remains in flight.
    void fireAll(pi, "session_start", { reason: "restore" }, ctxA);
    await eventually(
      () => pendingFetches.length >= 1,
      "session A initial refresh must queue a fetch before session B starts",
    );

    // --- Session B ---
    // session_start B invalidates session A's token and registers callback_B.
    // B's own refresh is throttled (same cache key, lastAttempts just set by
    // A), so pendingFetches stays at 1.
    await fireAll(pi, "session_start", { reason: "restore" }, ctxB);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pendingFetches.length,
      1,
      "session B's throttled refresh must not add a second fetch",
    );

    // Resolve session A's deferred fetch. The snapshot changes from undefined
    // to a real value. The facade calls this.currentFooterRender, which is now
    // callback_B (registered by session_start B). callback_B passes its own
    // token guard and redraws B's footer exactly once. A's footer is never
    // called.
    resolveNextFetch(1);
    await eventually(
      () => ctxBRenders === 1,
      "session A's pending refresh settling must redraw B's footer via the facade's current callback",
    );
    assert.equal(
      ctxARenders,
      0,
      "session A's stale pending refresh must not redraw A's footer after session switch",
    );
  } finally {
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
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
  const session = createTestSession();
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

    const { pi } = session;
    theLastHarness(pi);
    const ctx = session.createCtx({
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
    try {
      await session.dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(previousEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
