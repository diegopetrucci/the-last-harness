import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { createSessionMirrorObserverFacade } = await jiti.import(
  "../extensions/the-last-harness/session-mirror-observer-facade.ts",
);
const { createSessionMirrorObserverProbe } = await jiti.import(
  "../extensions/the-last-harness/session-mirror-observer-probe.ts",
);

function makeFixture(t, enabled) {
  const root = mkdtempSync(join("/tmp", "tlh-f-"));
  const agent = join(root, "agent");
  const companion = join(root, "companion");
  const cwd = join(root, "workspace");
  mkdirSync(agent);
  mkdirSync(companion);
  mkdirSync(cwd);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify(
      enabled ? { tlh: { experimental: { enabledFeatures: ["session-mirror-observer"] } } } : {},
    ),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agent, companion, cwd, sessionFile: join(agent, "session.jsonl") };
}

function context(fixture) {
  return {
    cwd: fixture.cwd,
    sessionManager: { getSessionFile: () => fixture.sessionFile },
    ui: { notify() {} },
  };
}

test("resolves the attested sibling only after attestation and keeps it out of status", async (t) => {
  const fixture = makeFixture(t, true);
  const order = [];
  let captured;
  await withEnv(
    { HOME: fixture.root, USERPROFILE: undefined, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const facade = createSessionMirrorObserverFacade({
        attest: () => {
          order.push("attest");
          return { ok: true, phase: "session-file" };
        },
        resolveBridgeDirectory: () => {
          order.push("resolve");
          return fixture.companion;
        },
        loadProbe: async () => ({
          createSessionMirrorObserverProbe(options) {
            order.push("load");
            captured = options;
            return createSessionMirrorObserverProbe(options);
          },
        }),
      });
      await facade.sessionStart(context(fixture));
      assert.deepEqual(order.slice(0, 3), ["attest", "resolve", "load"]);
      assert.equal(captured.bridgeDirectory, fixture.companion);
      assert.doesNotMatch(JSON.stringify(facade.getStatus(context(fixture))), /companion|tlh-f-/);
    },
  );
});

test("keeps the attested observer when the resolver fails", async (t) => {
  const fixture = makeFixture(t, true);
  let loadCalls = 0;
  let resolverCalls = 0;
  let captured;
  await withEnv(
    { HOME: fixture.root, USERPROFILE: undefined, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const facade = createSessionMirrorObserverFacade({
        attest: () => ({ ok: true, phase: "session-file" }),
        resolveBridgeDirectory: () => {
          resolverCalls += 1;
          throw new Error("SENTINEL_PATH_ERROR");
        },
        loadProbe: async () => ({
          createSessionMirrorObserverProbe(options) {
            loadCalls += 1;
            captured = options;
            return createSessionMirrorObserverProbe(options);
          },
        }),
      });
      await facade.sessionStart(context(fixture));
      await new Promise((resolve) => setImmediate(resolve));
      const status = facade.getStatus(context(fixture));
      assert.equal(resolverCalls, 1);
      assert.equal(loadCalls, 1);
      assert.equal(captured.bridgeDirectory, undefined);
      assert.equal(status.sessionConfigured, true);
      assert.equal(status.attestation, "attested");
      assert.notEqual(status.active, "disabled");
      assert.doesNotMatch(JSON.stringify(status), /SENTINEL_PATH_ERROR|companion|tlh-f-/);
    },
  );
});

test("uses the default companion when present and omits it when absent", async (t) => {
  const present = makeFixture(t, true);
  const absent = makeFixture(t, true);
  rmSync(absent.companion, { recursive: true, force: true });
  await withEnv(
    { HOME: present.root, USERPROFILE: undefined, PI_CODING_AGENT_DIR: present.agent },
    async () => {
      let captured;
      const facade = createSessionMirrorObserverFacade({
        attest: () => ({ ok: true, phase: "session-file" }),
        loadProbe: async () => ({
          createSessionMirrorObserverProbe(options) {
            captured = options;
            return createSessionMirrorObserverProbe(options);
          },
        }),
      });
      await facade.sessionStart(context(present));
      assert.equal(captured.bridgeDirectory, realpathSync(present.companion));
    },
  );
  await withEnv(
    { HOME: absent.root, USERPROFILE: undefined, PI_CODING_AGENT_DIR: absent.agent },
    async () => {
      let captured;
      const facade = createSessionMirrorObserverFacade({
        attest: () => ({ ok: true, phase: "session-file" }),
        loadProbe: async () => ({
          createSessionMirrorObserverProbe(options) {
            captured = options;
            return createSessionMirrorObserverProbe(options);
          },
        }),
      });
      await facade.sessionStart(context(absent));
      await new Promise((resolve) => setImmediate(resolve));
      const status = facade.getStatus(context(absent));
      assert.equal(captured.bridgeDirectory, undefined);
      assert.equal(status.sessionConfigured, true);
      assert.equal(status.attestation, "attested");
    },
  );
});

test("disabled mode never resolves the bridge or loads the probe", async (t) => {
  const fixture = makeFixture(t, false);
  let resolverCalls = 0;
  let loadCalls = 0;
  await withEnv(
    { HOME: fixture.root, USERPROFILE: undefined, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const facade = createSessionMirrorObserverFacade({
        resolveBridgeDirectory: () => {
          resolverCalls += 1;
          return fixture.companion;
        },
        loadProbe: async () => {
          loadCalls += 1;
          return { createSessionMirrorObserverProbe };
        },
      });
      await facade.sessionStart(context(fixture));
      assert.equal(resolverCalls, 0);
      assert.equal(loadCalls, 0);
    },
  );
});
