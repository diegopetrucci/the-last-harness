import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  SESSION_MIRROR_OBSERVER_COMMAND,
  createSessionMirrorObserverFacade,
  registerSessionMirrorObserverFacade,
} = await jiti.import("../extensions/the-last-harness/session-mirror-observer-facade.ts");
const { createSessionMirrorObserverProbe } = await jiti.import(
  "../extensions/the-last-harness/session-mirror-observer-probe.ts",
);
const { attestSessionMirrorSession } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/profile-attestation.ts",
);
const { default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");

function makeFixture(t, enabled = false) {
  const root = mkdtempSync(join(tmpdir(), "tlh-session-mirror-facade-"));
  const agent = join(root, "agent");
  const cwd = join(root, "workspace");
  const sessions = join(agent, "sessions");
  const sessionFile = join(sessions, "synthetic-session.jsonl");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, "synthetic session marker\n", "utf8");
  writeFileSync(
    join(agent, "settings.json"),
    `${JSON.stringify(
      enabled ? { tlh: { experimental: { enabledFeatures: ["session-mirror-observer"] } } } : {},
      null,
      2,
    )}\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agent, cwd, sessionFile };
}

function createContext(fixture, notifications = []) {
  return {
    cwd: fixture.cwd,
    sessionManager: {
      getSessionFile: () => fixture.sessionFile,
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

function createPi() {
  const commands = new Map();
  const handlers = new Map();
  const eventSubscriptions = [];
  return {
    commands,
    handlers,
    eventSubscriptions,
    events: {
      on(name, handler) {
        eventSubscriptions.push({ name, handler });
        return () => undefined;
      },
      emit() {},
    },
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
  };
}

function fire(pi, name, event, ctx) {
  return Promise.all((pi.handlers.get(name) ?? []).map((handler) => handler(event, ctx)));
}

function probeState(overrides = {}) {
  return {
    generation: 1,
    enabled: true,
    attestation: "attested",
    status: "idle",
    settled: true,
    dirty: false,
    snapshotRequired: false,
    publicationPending: false,
    queueDepth: 0,
    queueCapacity: 8,
    sinkInFlight: false,
    revision: 1,
    successfulPublications: 1,
    failedPublications: 0,
    coalescedMarkers: 0,
    droppedMarkers: 0,
    diagnostics: {
      queueOverflow: 0,
      staleGeneration: 0,
      schedulerFailure: 0,
      sessionUnavailable: 0,
      attestationFailure: 0,
      attestationNotReady: 0,
      projectionFailure: 0,
      sinkThrow: 0,
      sinkReject: 0,
    },
    lastDiagnostic: undefined,
    lastAttestationFailure: undefined,
    lastProjectionFailure: undefined,
    envelopeCategory: "mixed",
    entryCount: 3,
    rootCount: 1,
    maxDepth: 3,
    envelopeBytes: 512,
    timing: { attestation: "fast", projection: "moderate", sink: "fast" },
    runtimeFailures: 0,
    ...overrides,
  };
}

function createProbeFactory({ states = [], calls = [] } = {}) {
  let stateIndex = 0;
  return {
    createSessionMirrorObserverProbe(options) {
      calls.push({ type: "create", options });
      const probe = {
        sessionStart() {
          calls.push({ type: "sessionStart" });
        },
        agentStart() {
          calls.push({ type: "agentStart" });
        },
        messageEnd() {
          calls.push({ type: "messageEnd" });
        },
        turnEnd() {
          calls.push({ type: "turnEnd" });
        },
        agentSettled() {
          calls.push({ type: "agentSettled" });
        },
        sessionTree() {
          calls.push({ type: "sessionTree" });
        },
        sessionCompact() {
          calls.push({ type: "sessionCompact" });
        },
        sessionShutdown() {
          calls.push({ type: "sessionShutdown" });
        },
        requestSnapshot() {
          calls.push({ type: "requestSnapshot" });
        },
        getState() {
          return states[Math.min(stateIndex++, states.length - 1)] ?? probeState();
        },
      };
      return probe;
    },
  };
}

async function start(pi, ctx, reason = "startup") {
  await fire(pi, "session_start", { type: "session_start", reason }, ctx);
}

function drain(scheduled) {
  while (scheduled.length > 0) scheduled.shift()();
}

function writeFeatureSetting(fixture, enabled) {
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      enabled ? { tlh: { experimental: { enabledFeatures: ["session-mirror-observer"] } } } : {},
      null,
      2,
    )}\n`,
  );
}

async function withFixtureEnv(fixture, fn) {
  return withEnv(
    {
      HOME: fixture.root,
      USERPROFILE: undefined,
      PI_CODING_AGENT_DIR: fixture.agent,
    },
    fn,
  );
}

function runHostileActivationSnapshotChild(fixture, kind, reason = "startup") {
  const facadeUrl = new URL(
    "../extensions/the-last-harness/session-mirror-observer-facade.js",
    import.meta.url,
  ).href;
  const script = `
    const { createSessionMirrorObserverFacade } = await import(${JSON.stringify(facadeUrl)});
    const key = Symbol.for("the-last-harness.session-mirror-observer-activation-snapshot");
    let getterCalls = 0;
    let setterCalls = 0;
    const kind = ${JSON.stringify(kind)};
    let descriptor;
    if (kind === "accessor") {
      descriptor = {
        get() {
          getterCalls += 1;
          throw new Error("SENTINEL_GETTER");
        },
        set() {
          setterCalls += 1;
          throw new Error("SENTINEL_SETTER");
        },
        configurable: true,
      };
    } else if (kind === "malformed") {
      descriptor = {
        value: { sessionConfigured: "not-a-boolean", extra: "SENTINEL" },
        writable: true,
        configurable: true,
      };
    } else if (kind === "proxy") {
      descriptor = {
        value: new Proxy({}, {
          ownKeys() {
            throw new Error("SENTINEL_PROXY");
          },
        }),
        writable: true,
        configurable: true,
      };
    } else {
      descriptor = {
        value: Object.freeze({ sessionConfigured: true }),
        writable: false,
        configurable: false,
      };
    }
    Object.defineProperty(globalThis, key, descriptor);
    let loadCalls = 0;
    const ctx = {
      cwd: ${JSON.stringify(fixture.cwd)},
      sessionManager: { getSessionFile: () => ${JSON.stringify(fixture.sessionFile)} },
      ui: { notify() {} },
    };
    const facade = createSessionMirrorObserverFacade({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => {
        loadCalls += 1;
        throw new Error("SENTINEL_LAZY_LOAD");
      },
    });
    const pending = facade.sessionStart(ctx, ${JSON.stringify(reason)});
    if (!(pending instanceof Promise)) throw new Error("sessionStart must return a Promise");
    await pending;
    const status = facade.getStatus(ctx);
    console.log(JSON.stringify({
      getterCalls,
      setterCalls,
      loadCalls,
      active: status.active,
      sessionConfigured: status.sessionConfigured,
      load: status.load,
    }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: process.env,
    }),
  );
}

function runPendingContextRetentionChild(fixture) {
  const facadeUrl = new URL(
    "../extensions/the-last-harness/session-mirror-observer-facade.js",
    import.meta.url,
  ).href;
  const script = `
    (async () => {
      const { createSessionMirrorObserverFacade } = await import(${JSON.stringify(facadeUrl)});
      let resolveLoad;
      const pendingModule = new Promise((resolve) => {
        resolveLoad = resolve;
      });
      const manager = { getSessionFile: () => ${JSON.stringify(fixture.sessionFile)} };
      const facade = createSessionMirrorObserverFacade({
        attest: () => ({ ok: true, phase: "session-file" }),
        loadProbe: () => pendingModule,
      });
      function startWithEphemeralContext() {
        let context = {
          cwd: ${JSON.stringify(fixture.cwd)},
          sessionManager: manager,
          ui: { notify() {} },
          sentinel: "SENTINEL_CONTEXT_PAYLOAD",
        };
        const weak = new WeakRef(context);
        const pending = facade.sessionStart(context, "startup");
        if (!(pending instanceof Promise)) throw new Error("sessionStart must return a Promise");
        context = null;
        return weak;
      }
      const weakContext = startWithEphemeralContext();
      function collect(attempt) {
        if (attempt >= 20) {
          console.log(JSON.stringify({ collected: weakContext.deref() === undefined }));
          return;
        }
        global.gc();
        setTimeout(() => collect(attempt + 1), 10);
      }
      collect(0);
      void resolveLoad;
    })();
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      encoding: "utf8",
      env: process.env,
    }),
  );
}

test("the main TLH extension does not register observer controls in a minor-agent child", async (t) => {
  const fixture = makeFixture(t, false);
  await withFixtureEnv(fixture, async () => {
    await withEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "developer" }, async () => {
      const pi = createPi();
      theLastHarness(pi);
      assert.equal(pi.commands.has(SESSION_MIRROR_OBSERVER_COMMAND), false);
      assert.equal(pi.handlers.has("message_end"), false);
      assert.equal(pi.handlers.has("session_tree"), false);
      assert.equal(pi.handlers.has("agent_settled"), false);
      assert.equal(pi.handlers.has("message_update"), false);
    });
  });
});

test("default-disabled startup registers only the facade and does not invoke lazy loading", async (t) => {
  const fixture = makeFixture(t, false);
  let loadCalls = 0;
  await withFixtureEnv(fixture, async () => {
    const pi = createPi();
    const facade = registerSessionMirrorObserverFacade(pi, {
      loadProbe: async () => {
        loadCalls += 1;
        throw new Error("SENTINEL_LAZY_LOAD");
      },
    });
    assert.equal(pi.commands.has(SESSION_MIRROR_OBSERVER_COMMAND), true);
    assert.deepEqual([...pi.handlers.keys()].sort(), [
      "agent_settled",
      "agent_start",
      "message_end",
      "session_compact",
      "session_shutdown",
      "session_start",
      "session_tree",
      "turn_end",
    ]);
    assert.equal(pi.handlers.has("message_update"), false);

    const notifications = [];
    const ctx = createContext(fixture, notifications);
    await start(pi, ctx);
    assert.equal(loadCalls, 0);
    assert.equal(facade.getStatus(ctx).active, "disabled");

    await pi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("status", ctx);
    await pi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("snapshot", ctx);
    assert.equal(notifications.length, 2);
    assert.doesNotMatch(notifications.map((item) => item.message).join("\n"), /SENTINEL/);
    assert.match(notifications[0].message, /load=not-loaded/);
    assert.match(notifications[0].message, /changes=next-session-only/);
  });
});

test("activation snapshot failures are closed without invoking hostile accessors", async (t) => {
  const fixture = makeFixture(t, true);
  await withFixtureEnv(fixture, async () => {
    for (const kind of ["accessor", "malformed", "proxy", "non-writable"]) {
      const result = runHostileActivationSnapshotChild(fixture, kind);
      assert.equal(result.active, "disabled", kind);
      assert.equal(result.sessionConfigured, false, kind);
      assert.equal(result.load, "not-loaded", kind);
      assert.equal(result.loadCalls, 0, kind);
      assert.equal(result.getterCalls, 0, kind);
      assert.equal(result.setterCalls, 0, kind);
    }
  });

  const disabledFixture = makeFixture(t, false);
  await withFixtureEnv(disabledFixture, async () => {
    const reload = runHostileActivationSnapshotChild(disabledFixture, "non-writable", "reload");
    assert.equal(reload.active, "disabled");
    assert.equal(reload.sessionConfigured, false);
    assert.equal(reload.load, "not-loaded");
    assert.equal(reload.loadCalls, 0);
  });
});

test("a hostile snapshot reflection trap cannot overwrite a newer disabled snapshot", async (t) => {
  const fixture = makeFixture(t, true);
  const snapshotKey = Symbol.for("the-last-harness.session-mirror-observer-activation-snapshot");
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, snapshotKey);
  let facade;
  let reentered = false;
  try {
    await withFixtureEnv(fixture, async () => {
      const ctx = createContext(fixture);
      const validSnapshot = Object.freeze({ sessionConfigured: true });
      const trapSnapshot = new Proxy(validSnapshot, {
        getPrototypeOf(target) {
          if (!reentered) {
            reentered = true;
            writeFeatureSetting(fixture, false);
            const replacement = facade.sessionStart(ctx, "new");
            assert.equal(replacement instanceof Promise, true);
          }
          return Reflect.getPrototypeOf(target);
        },
      });
      Object.defineProperty(globalThis, snapshotKey, {
        value: trapSnapshot,
        writable: true,
        configurable: true,
      });
      let loadCalls = 0;
      facade = createSessionMirrorObserverFacade({
        attest: () => ({ ok: true, phase: "session-file" }),
        loadProbe: async () => {
          loadCalls += 1;
          throw new Error("stale generation must not load");
        },
      });
      await facade.sessionStart(ctx, "startup");
      const disabled = facade.getStatus(ctx);
      assert.equal(loadCalls, 0);
      assert.equal(disabled.active, "disabled");
      assert.equal(disabled.load, "not-loaded");
      assert.equal(disabled.sessionConfigured, false);

      const currentDescriptor = Object.getOwnPropertyDescriptor(globalThis, snapshotKey);
      assert.equal(currentDescriptor?.writable, true);
      assert.equal(currentDescriptor?.configurable, true);
      assert.equal(
        Object.getOwnPropertyDescriptor(currentDescriptor?.value, "sessionConfigured")?.value,
        false,
      );

      await facade.sessionStart(ctx, "reload");
      const reloaded = facade.getStatus(ctx);
      assert.equal(reloaded.active, "disabled");
      assert.equal(reloaded.load, "not-loaded");
      assert.equal(reloaded.sessionConfigured, false);
    });
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, snapshotKey, originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, snapshotKey);
    }
  }
});

test("a pending old load cannot mutate a disabled replacement generation", async (t) => {
  const fixture = makeFixture(t, true);
  const managerA = { getSessionFile: () => fixture.sessionFile };
  const managerB = { getSessionFile: () => fixture.sessionFile };
  let resolveLoad;
  let createCalls = 0;
  const pendingLoad = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  await withFixtureEnv(fixture, async () => {
    const facade = createSessionMirrorObserverFacade({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: () => pendingLoad,
    });
    assert.notEqual(facade.sessionStart.constructor.name, "AsyncFunction");
    const contextA = { cwd: fixture.cwd, sessionManager: managerA, ui: { notify() {} } };
    const contextB = { cwd: fixture.cwd, sessionManager: managerB, ui: { notify() {} } };
    const firstStart = facade.sessionStart(contextA, "startup");
    assert.equal(firstStart instanceof Promise, true);
    assert.equal(facade.getStatus(contextA).load, "loading");

    writeFeatureSetting(fixture, false);
    const replacementStart = facade.sessionStart(contextB, "new");
    assert.equal(replacementStart instanceof Promise, true);
    const beforeOldLoad = facade.getStatus(contextB);
    assert.equal(beforeOldLoad.active, "disabled");
    assert.equal(beforeOldLoad.load, "not-loaded");
    assert.equal(beforeOldLoad.timing.load, "unknown");

    resolveLoad({
      createSessionMirrorObserverProbe() {
        createCalls += 1;
        throw new Error("stale generation must not create a probe");
      },
    });
    await Promise.all([firstStart, replacementStart]);
    const afterOldLoad = facade.getStatus(contextB);
    assert.equal(createCalls, 0);
    assert.equal(afterOldLoad.active, "disabled");
    assert.equal(afterOldLoad.load, "not-loaded");
    assert.deepEqual(afterOldLoad.timing, beforeOldLoad.timing);
  });
});

test("shutdown commits replacement state before an old probe can re-enter", async (t) => {
  const fixture = makeFixture(t, true);
  const calls = [];
  let facade;
  await withFixtureEnv(fixture, async () => {
    const ctx = createContext(fixture);
    const probe = {
      sessionStart() {
        calls.push("start");
      },
      sessionShutdown() {
        calls.push("shutdown");
        writeFeatureSetting(fixture, false);
        const replacement = facade.sessionStart(ctx, "new");
        assert.equal(replacement instanceof Promise, true);
      },
      getState() {
        return probeState();
      },
    };
    facade = createSessionMirrorObserverFacade({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => ({
        createSessionMirrorObserverProbe() {
          return probe;
        },
      }),
    });
    await facade.sessionStart(ctx, "startup");
    assert.equal(facade.getStatus(ctx).active, "enabled");

    facade.sessionShutdown();
    const status = facade.getStatus(ctx);
    assert.equal(status.active, "disabled");
    assert.equal(status.load, "not-loaded");
    assert.equal(calls.filter((call) => call === "shutdown").length, 1);
  });
});

test("a reentrant probe factory cannot install or start an old manager probe", async (t) => {
  const fixture = makeFixture(t, true);
  const managerA = { getSessionFile: () => fixture.sessionFile };
  const managerB = { getSessionFile: () => fixture.sessionFile };
  const calls = [];
  let facade;
  await withFixtureEnv(fixture, async () => {
    const contextA = { cwd: fixture.cwd, sessionManager: managerA, ui: { notify() {} } };
    const contextB = { cwd: fixture.cwd, sessionManager: managerB, ui: { notify() {} } };
    const probe = {
      sessionStart() {
        calls.push("start");
      },
      sessionShutdown() {
        calls.push("shutdown");
      },
      getState() {
        return probeState();
      },
    };
    const factory = {
      createSessionMirrorObserverProbe(options) {
        calls.push(["create", options.getSessionManager()]);
        writeFeatureSetting(fixture, false);
        const replacement = facade.sessionStart(contextB, "new");
        assert.equal(replacement instanceof Promise, true);
        return probe;
      },
    };
    facade = createSessionMirrorObserverFacade({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => factory,
    });

    const firstStart = facade.sessionStart(contextA, "startup");
    await firstStart;
    const status = facade.getStatus(contextB);
    assert.equal(status.active, "disabled");
    assert.equal(status.load, "not-loaded");
    assert.equal(status.timing.load, "unknown");
    assert.equal(calls.filter((call) => call === "start").length, 0);
    assert.equal(calls.filter((call) => call === "shutdown").length, 1);
    assert.equal(calls.find((call) => Array.isArray(call))?.[1], managerA);
  });
});

test("pending activation retains only the pinned manager, not the ExtensionContext", async (t) => {
  const fixture = makeFixture(t, true);
  await withFixtureEnv(fixture, async () => {
    const result = runPendingContextRetentionChild(fixture);
    assert.equal(result.collected, true);
  });
});

test("normal, default, ephemeral, and unsafe sessions are attested before import and never activate", async (t) => {
  const reasons = [
    "default-or-normal-profile",
    "ephemeral-session",
    "unsafe-profile-metadata",
    "session-escape",
  ];
  for (const reason of reasons) {
    const fixture = makeFixture(t, true);
    let loadCalls = 0;
    const sessionFile = reason === "ephemeral-session" ? undefined : fixture.sessionFile;
    const ctx = createContext(fixture);
    ctx.sessionManager.getSessionFile = () => sessionFile;
    await withFixtureEnv(fixture, async () => {
      const pi = createPi();
      const facade = registerSessionMirrorObserverFacade(pi, {
        attest: () => ({ ok: false, reason }),
        loadProbe: async () => {
          loadCalls += 1;
          return createProbeFactory();
        },
      });
      await start(pi, ctx);
      assert.equal(loadCalls, 0, reason);
      const status = facade.getStatus(ctx);
      assert.equal(status.active, "disabled");
      assert.equal(status.load, "not-loaded");
      assert.equal(status.attestation, "failed");
      assert.equal(status.attestationReason, reason);
    });
  }
});

test("directory-only persisted sessions activate provisionally and publish after the first assistant", async (t) => {
  const fixture = makeFixture(t, true);
  rmSync(fixture.sessionFile, { force: true });
  await withFixtureEnv(fixture, async () => {
    const ephemeral = SessionManager.inMemory(fixture.cwd);
    let ephemeralLoadCalls = 0;
    const ephemeralFacade = createSessionMirrorObserverFacade({
      attest: attestSessionMirrorSession,
      loadProbe: async () => {
        ephemeralLoadCalls += 1;
        throw new Error("ephemeral sessions must not load");
      },
    });
    const ephemeralContext = { cwd: fixture.cwd, sessionManager: ephemeral, ui: { notify() {} } };
    await ephemeralFacade.sessionStart(ephemeralContext, "startup");
    assert.equal(ephemeralLoadCalls, 0);
    assert.equal(
      ephemeralFacade.getStatus(ephemeralContext).attestationReason,
      "ephemeral-session",
    );

    const session = SessionManager.create(fixture.cwd, join(fixture.agent, "sessions"));
    const sessionFile = session.getSessionFile();
    assert.equal(typeof sessionFile, "string");
    assert.equal(existsSync(sessionFile), false, "a new persisted manager delays JSONL creation");

    const scheduled = [];
    const notifications = [];
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: session,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    };
    let probeOptions;
    const facade = createSessionMirrorObserverFacade({
      attest: attestSessionMirrorSession,
      loadProbe: async () => ({
        createSessionMirrorObserverProbe(options) {
          probeOptions = options;
          return createSessionMirrorObserverProbe({
            ...options,
            scheduler: (task) => scheduled.push(task),
          });
        },
      }),
    });

    await facade.sessionStart(ctx, "startup");
    assert.equal(facade.getStatus(ctx).sessionConfigured, true);
    assert.equal(facade.getStatus(ctx).load, "loaded");
    assert.equal(facade.getStatus(ctx).active, "pending");
    assert.equal(probeOptions.getSessionManager(), session);
    assert.equal(Object.hasOwn(probeOptions, "ctx"), false);
    ctx.sessionManager = { getSessionFile: () => fixture.sessionFile };
    assert.equal(probeOptions.getSessionManager(), session);
    ctx.sessionManager = session;

    drain(scheduled);
    const provisional = facade.getStatus(ctx);
    assert.equal(provisional.active, "enabled");
    assert.equal(provisional.attestation, "directory-only");
    assert.equal(provisional.snapshotRequired, true);
    assert.equal(existsSync(sessionFile), false);

    const userId = session.appendMessage({
      role: "user",
      content: "SENTINEL_PRIVATE_USER",
      timestamp: 1,
    });
    assert.equal(existsSync(sessionFile), false);
    const assistantId = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "SENTINEL_PRIVATE_ASSISTANT" }],
      api: "synthetic-api",
      provider: "synthetic-provider",
      model: "synthetic-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    assert.equal(existsSync(sessionFile), true);

    facade.agentSettled();
    drain(scheduled);
    const published = facade.getStatus(ctx);
    assert.equal(published.active, "enabled");
    assert.equal(published.attestation, "attested");
    assert.equal(published.snapshotRequired, false);
    assert.equal(published.envelopeCategory, "text");
    assert.equal(published.entryCount, 2);
    assert.equal(published.rootCount, 1);
    assert.equal(published.maxDepth, 2);
    const serialized = JSON.stringify(published);
    for (const privateValue of [sessionFile, session.getSessionId(), userId, assistantId]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
    assert.doesNotMatch(serialized, /SENTINEL_PRIVATE/);

    await facade.handleStatus("status", ctx);
    assert.doesNotMatch(notifications.at(-1).message, /SENTINEL_PRIVATE/);
    assert.doesNotMatch(notifications.at(-1).message, /synthetic-session/);
  });
});

test("enabled isolated sessions snapshot the flag and apply changes only on the next session", async (t) => {
  const fixture = makeFixture(t, true);
  const calls = [];
  let loadCalls = 0;
  await withFixtureEnv(fixture, async () => {
    const pi = createPi();
    const factory = createProbeFactory({ calls });
    const facade = registerSessionMirrorObserverFacade(pi, {
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => {
        loadCalls += 1;
        return factory;
      },
    });
    const ctx = createContext(fixture);
    await start(pi, ctx);
    assert.equal(loadCalls, 1);
    assert.equal(
      calls.some((call) => call.type === "sessionStart"),
      true,
    );

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
    );
    await fire(pi, "agent_start", { type: "agent_start" }, ctx);
    const activeStatus = facade.getStatus(ctx);
    assert.equal(activeStatus.configured, false);
    assert.equal(activeStatus.sessionConfigured, true);
    assert.equal(activeStatus.nextSessionConfigured, false);
    assert.equal(activeStatus.active, "enabled");
    assert.equal(
      calls.some((call) => call.type === "agentStart"),
      true,
    );
    assert.equal(
      pi.eventSubscriptions.length,
      0,
      "feature-change events must not rebind activation",
    );

    await fire(pi, "session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
    assert.equal(
      calls.some((call) => call.type === "sessionShutdown"),
      true,
    );
    await start(pi, ctx);
    assert.equal(facade.getStatus(ctx).active, "disabled");
    assert.equal(facade.getStatus(ctx).sessionConfigured, false);

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["session-mirror-observer"] } } }, null, 2)}\n`,
    );
    await start(pi, ctx);
    assert.equal(loadCalls, 1, "the cached lazy module is reused after the first successful load");
    assert.equal(
      calls.filter((call) => call.type === "create").length,
      2,
      "enable applies at the following session_start",
    );
    assert.equal(facade.getStatus(ctx).sessionConfigured, true);
  });
});

test("reload fails closed when its activation snapshot is removed or invalidated after a settings change", async (t) => {
  const fixture = makeFixture(t, false);
  const snapshotKey = Symbol.for("the-last-harness.session-mirror-observer-activation-snapshot");
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, snapshotKey);
  const originalSettingsCreate = SettingsManager.create;
  let settingsReads = 0;
  SettingsManager.create = (...args) => {
    settingsReads += 1;
    return originalSettingsCreate.apply(SettingsManager, args);
  };

  try {
    await withFixtureEnv(fixture, async () => {
      const ctx = createContext(fixture);
      for (const invalidation of ["deleted", "malformed"]) {
        assert.equal(Reflect.deleteProperty(globalThis, snapshotKey), true, invalidation);
        writeFeatureSetting(fixture, false);
        const baseline = createSessionMirrorObserverFacade();
        await baseline.sessionStart(ctx, "new");
        assert.equal(baseline.getStatus(ctx).sessionConfigured, false, invalidation);

        writeFeatureSetting(fixture, true);
        let invalidSnapshot;
        if (invalidation === "deleted") {
          assert.equal(Reflect.deleteProperty(globalThis, snapshotKey), true);
        } else {
          invalidSnapshot = Object.freeze({ sessionConfigured: "invalid" });
          Object.defineProperty(globalThis, snapshotKey, {
            value: invalidSnapshot,
            writable: true,
            configurable: true,
          });
        }

        let loadCalls = 0;
        let attestationCalls = 0;
        const reloaded = createSessionMirrorObserverFacade({
          attest: () => {
            attestationCalls += 1;
            return { ok: true, phase: "session-file" };
          },
          loadProbe: async () => {
            loadCalls += 1;
            return createProbeFactory();
          },
        });
        const settingsReadsBeforeReload = settingsReads;
        await reloaded.sessionStart(ctx, "reload");
        assert.equal(
          settingsReads,
          settingsReadsBeforeReload,
          `${invalidation} reload settings read`,
        );
        const status = reloaded.getStatus(ctx);
        assert.equal(status.configured, true, invalidation);
        assert.equal(status.nextSessionConfigured, true, invalidation);
        assert.equal(status.sessionConfigured, false, invalidation);
        assert.equal(status.active, "disabled", invalidation);
        assert.equal(status.load, "not-loaded", invalidation);
        assert.equal(loadCalls, 0, invalidation);
        assert.equal(attestationCalls, 0, invalidation);

        const descriptor = Object.getOwnPropertyDescriptor(globalThis, snapshotKey);
        if (invalidation === "deleted") {
          assert.equal(descriptor, undefined);
        } else {
          assert.equal(descriptor?.value, invalidSnapshot);
        }
      }
    });
  } finally {
    SettingsManager.create = originalSettingsCreate;
    if (originalDescriptor) {
      Object.defineProperty(globalThis, snapshotKey, originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, snapshotKey);
    }
  }
});

test("fresh facade instances preserve activation across reload but recapture new conversation sessions", async (t) => {
  const fixture = makeFixture(t, true);
  const calls = [];
  await withFixtureEnv(fixture, async () => {
    const ctx = createContext(fixture);
    const factory = createProbeFactory({ calls });
    const makeOptions = () => ({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => factory,
    });
    const makeRegisteredFacade = async () => {
      const freshJiti = createJiti(import.meta.url, { moduleCache: false });
      const { registerSessionMirrorObserverFacade: registerFreshFacade } = await freshJiti.import(
        "../extensions/the-last-harness/session-mirror-observer-facade.ts",
      );
      const pi = createPi();
      return { facade: registerFreshFacade(pi, makeOptions()), pi };
    };

    const initialRuntime = await makeRegisteredFacade();
    await start(initialRuntime.pi, ctx, "startup");
    assert.equal(initialRuntime.facade.getStatus(ctx).sessionConfigured, true);

    writeFeatureSetting(fixture, false);
    await fire(
      initialRuntime.pi,
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
    const reloadedRuntime = await makeRegisteredFacade();
    await start(reloadedRuntime.pi, ctx, "reload");
    const reloaded = reloadedRuntime.facade;
    const reloadStatus = reloaded.getStatus(ctx);
    assert.equal(reloadStatus.configured, false);
    assert.equal(reloadStatus.sessionConfigured, true);
    assert.equal(reloadStatus.active, "enabled");

    reloaded.sessionShutdown();
    const newConversation = await makeRegisteredFacade();
    await start(newConversation.pi, ctx, "new");
    assert.equal(newConversation.facade.getStatus(ctx).sessionConfigured, false);
    assert.equal(newConversation.facade.getStatus(ctx).active, "disabled");

    writeFeatureSetting(fixture, true);
    const resumedConversation = await makeRegisteredFacade();
    await start(resumedConversation.pi, ctx, "resume");
    assert.equal(resumedConversation.facade.getStatus(ctx).sessionConfigured, true);
    assert.equal(resumedConversation.facade.getStatus(ctx).active, "enabled");

    writeFeatureSetting(fixture, false);
    const forkedConversation = await makeRegisteredFacade();
    await start(forkedConversation.pi, ctx, "fork");
    assert.equal(forkedConversation.facade.getStatus(ctx).sessionConfigured, false);
    assert.equal(forkedConversation.facade.getStatus(ctx).active, "disabled");

    writeFeatureSetting(fixture, false);
    const disabledBaseline = await makeRegisteredFacade();
    await start(disabledBaseline.pi, ctx, "new");
    writeFeatureSetting(fixture, true);
    await fire(
      disabledBaseline.pi,
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
    const enabledSettingReload = await makeRegisteredFacade();
    await start(enabledSettingReload.pi, ctx, "reload");
    const disabledReloadStatus = enabledSettingReload.facade.getStatus(ctx);
    assert.equal(disabledReloadStatus.configured, true);
    assert.equal(disabledReloadStatus.sessionConfigured, false);
    assert.equal(disabledReloadStatus.active, "disabled");

    writeFeatureSetting(fixture, true);
    const restartedConversation = await makeRegisteredFacade();
    await start(restartedConversation.pi, ctx, "startup");
    assert.equal(restartedConversation.facade.getStatus(ctx).sessionConfigured, true);
    assert.equal(restartedConversation.facade.getStatus(ctx).active, "enabled");

    assert.equal(
      calls.filter((call) => call.type === "create").length,
      4,
      "startup, reload, resume, and restarted startup activate; new, fork, and reload recapture disabled activation",
    );
    assert.deepEqual(
      globalThis[Symbol.for("the-last-harness.session-mirror-observer-activation-snapshot")],
      { sessionConfigured: true },
      "reload state retains only the bounded session-configured boolean",
    );
  });
});

test("module, attestor, and projection-facing state errors stay closed and notification-safe", async (t) => {
  const fixture = makeFixture(t, true);
  await withFixtureEnv(fixture, async () => {
    const moduleNotifications = [];
    const modulePi = createPi();
    const moduleCtx = createContext(fixture, moduleNotifications);
    const moduleFacade = registerSessionMirrorObserverFacade(modulePi, {
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => {
        throw new Error("SENTINEL_MODULE_ERROR");
      },
    });
    await start(modulePi, moduleCtx);
    await modulePi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("status", moduleCtx);
    assert.equal(moduleFacade.getStatus(moduleCtx).load, "failed");
    assert.doesNotMatch(moduleNotifications[0].message, /SENTINEL/);

    const attestationNotifications = [];
    const attestationPi = createPi();
    const attestationCtx = createContext(fixture, attestationNotifications);
    const attestationFacade = registerSessionMirrorObserverFacade(attestationPi, {
      attest: () => {
        throw new Error("SENTINEL_ATTESTATION_ERROR");
      },
      loadProbe: async () => {
        throw new Error("must not load");
      },
    });
    await start(attestationPi, attestationCtx);
    await attestationPi.commands
      .get(SESSION_MIRROR_OBSERVER_COMMAND)
      .handler("status", attestationCtx);
    assert.equal(
      attestationFacade.getStatus(attestationCtx).attestationReason,
      "unsafe-profile-metadata",
    );
    assert.doesNotMatch(attestationNotifications[0].message, /SENTINEL/);

    const projectionNotifications = [];
    const projectionPi = createPi();
    const calls = [];
    const projectionCtx = createContext(fixture, projectionNotifications);
    const factory = createProbeFactory({
      calls,
      states: [
        probeState({
          envelopeCategory: "SENTINEL_ENVELOPE",
          diagnostics: { privateContent: "SENTINEL_DIAGNOSTIC", sinkThrow: "SENTINEL" },
          timing: { projection: "SENTINEL_TIMING" },
          lastProjectionFailure: "SENTINEL_PROJECTION",
        }),
      ],
    });
    const projectionFacade = registerSessionMirrorObserverFacade(projectionPi, {
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => factory,
    });
    await start(projectionPi, projectionCtx);
    await projectionPi.commands
      .get(SESSION_MIRROR_OBSERVER_COMMAND)
      .handler("status", projectionCtx);
    assert.equal(projectionFacade.getStatus(projectionCtx).envelopeCategory, "none");
    assert.doesNotMatch(projectionNotifications[0].message, /SENTINEL/);
    assert.doesNotMatch(JSON.stringify(projectionFacade.getStatus(projectionCtx)), /SENTINEL/);
  });
});

test("status and explicit snapshot requests remain safe before and after activation", async (t) => {
  const fixture = makeFixture(t, true);
  const calls = [];
  await withFixtureEnv(fixture, async () => {
    const pi = createPi();
    const factory = createProbeFactory({ calls, states: [probeState()] });
    const facade = registerSessionMirrorObserverFacade(pi, {
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => factory,
    });
    const notifications = [];
    const ctx = createContext(fixture, notifications);
    await pi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("snapshot", ctx);
    assert.equal(
      calls.some((call) => call.type === "requestSnapshot"),
      false,
    );

    await start(pi, ctx);
    const before = notifications.length;
    const request = pi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("snapshot", ctx);
    assert.equal(request instanceof Promise, true);
    await request;
    assert.equal(
      calls.some((call) => call.type === "requestSnapshot"),
      true,
    );
    assert.match(notifications.at(-1).message, /deferred and nonblocking/);
    assert.equal(notifications.length, before + 1);

    await fire(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await pi.commands.get(SESSION_MIRROR_OBSERVER_COMMAND).handler("status", ctx);
    assert.match(notifications.at(-1).message, /attestation=shutdown/);
    assert.equal(facade.getStatus(ctx).active, "disabled");
  });
});

test("retryable facade loader can recover on a later enabled session", async (t) => {
  const fixture = makeFixture(t, true);
  let attempts = 0;
  const calls = [];
  await withFixtureEnv(fixture, async () => {
    const factory = createProbeFactory({ calls });
    const facade = createSessionMirrorObserverFacade({
      attest: () => ({ ok: true, phase: "session-file" }),
      loadProbe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("SENTINEL_RETRYABLE");
        return factory;
      },
    });
    const ctx = createContext(fixture);
    await facade.sessionStart(ctx);
    assert.equal(facade.getStatus(ctx).load, "failed");
    await facade.sessionShutdown();
    await facade.sessionStart(ctx);
    assert.equal(attempts, 2);
    assert.equal(facade.getStatus(ctx).load, "loaded");
    assert.doesNotMatch(JSON.stringify(facade.getStatus(ctx)), /SENTINEL/);
  });
});
