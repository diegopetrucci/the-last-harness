import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import {
  createRedirectedTempProfileFixture,
  createIsolatedProfileFixture,
  withEnv,
} from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  writeGuardedTlhStateFile,
  tlhStartupStatePath,
  updateTlhStartupState,
  readTlhStartupState,
  withLockedTlhSettingsWrite,
  __testing,
} = await jiti.import("../extensions/the-last-harness/profile-state.ts");

// ---------------------------------------------------------------------------
// writeGuardedTlhStateFile — independent containment enforcement
// ---------------------------------------------------------------------------

test("writeGuardedTlhStateFile rejects a path outside the managed TLH state dir", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // A path directly in the agent root — not inside the tlh/ sub-directory.
    const outsidePath = join(fixture.agent, "outside.json");
    // The caller provides a resolver that returns the same path (would pass the old
    // caller-honesty check), but the independent containment check must still reject it.
    const result = writeGuardedTlhStateFile(outsidePath, '{"outside":true}\n', () => outsidePath);
    assert.equal(
      result,
      false,
      "path outside managed TLH state dir must be rejected even with a matching resolver",
    );
    assert.equal(existsSync(outsidePath), false, "rejected write must not create the file");
  });
});

test("writeGuardedTlhStateFile rejects a path in a completely different directory", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // A path in the fixture root — entirely outside the agent dir.
    const outsidePath = join(fixture.dir, "totally-outside.json");
    const result = writeGuardedTlhStateFile(outsidePath, '{"outside":true}\n', () => outsidePath);
    assert.equal(result, false, "path outside the managed dir must be rejected");
    assert.equal(existsSync(outsidePath), false, "rejected write must not create the file");
  });
});

test("writeGuardedTlhStateFile accepts a path inside the managed TLH state dir", async (t) => {
  // Verifies that the containment check does not break legitimate writes.
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Create the tlh/ directory first (normally done by the caller's mkdirSync guard).
    mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
    const insidePath = join(fixture.agent, "tlh", "test-state.json");
    const result = writeGuardedTlhStateFile(insidePath, '{"inside":true}\n', () => insidePath);
    assert.equal(result, true, "path inside managed dir must be accepted");
    assert.equal(existsSync(insidePath), true, "accepted write must create the file");
  });
});

test("writeGuardedTlhStateFile returns false when outside isolated profile (PI_CODING_AGENT_DIR unset)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    // tlhStateDir() returns undefined when outside isolated profile, so the
    // containment check must reject the write.
    const statePath = join(fixture.agent, "tlh", "test-state.json");
    const result = writeGuardedTlhStateFile(statePath, '{"x":1}\n', () => statePath);
    assert.equal(result, false, "must return false when not in isolated profile");
  });
});

// ---------------------------------------------------------------------------
// Settings writes — test-process isolation
// ---------------------------------------------------------------------------

test("withLockedTlhSettingsWrite rejects non-temporary profiles during Node tests", async (t) => {
  const fixture = createRedirectedTempProfileFixture("tlh-profile-state-test-", { test: t });
  const agent = fixture.agent;
  const settingsPath = join(agent, "settings.json");
  const initialSettings = '{"tlh":{"attribution":{"commit":false}}}\n';
  writeFileSync(settingsPath, initialSettings);
  let updateCalls = 0;

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: agent,
      NODE_TEST_CONTEXT: "child-v8",
      TMPDIR: fixture.redirectedTemp,
      TEMP: fixture.redirectedTemp,
      TMP: fixture.redirectedTemp,
    },
    () => {
      assert.throws(
        () =>
          withLockedTlhSettingsWrite(fixture.dir, "outside profile", () => {
            updateCalls += 1;
            return { changed: true, nextContent: '{"changed":true}\n' };
          }),
        /operating system temporary directory/i,
      );
    },
  );

  assert.equal(updateCalls, 0, "the update callback must not run for a rejected profile");
  assert.equal(readFileSync(settingsPath, "utf8"), initialSettings);
  assert.deepEqual(
    readdirSync(agent).filter((entry) => entry.startsWith("settings.json.bak-")),
    [],
    "rejected settings write must not create a backup",
  );
});

test("withLockedTlhSettingsWrite preserves non-test writes outside the temporary directory", async (t) => {
  const fixture = createRedirectedTempProfileFixture("tlh-profile-state-test-", { test: t });
  const agent = fixture.agent;
  const settingsPath = join(agent, "settings.json");
  const initialSettings = '{"before":true}\n';
  const nextSettings = '{"after":true}\n';
  writeFileSync(settingsPath, initialSettings);

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: agent,
      NODE_TEST_CONTEXT: undefined,
      TMPDIR: fixture.redirectedTemp,
      TEMP: fixture.redirectedTemp,
      TMP: fixture.redirectedTemp,
    },
    () => {
      const result = withLockedTlhSettingsWrite(fixture.dir, "outside profile", () => ({
        changed: true,
        nextContent: nextSettings,
      }));
      assert.equal(result.changed, true);
      assert.ok(result.backupPath, "an existing settings file should receive a backup");
    },
  );

  assert.equal(readFileSync(settingsPath, "utf8"), nextSettings);
  const backups = readdirSync(agent).filter((entry) => entry.startsWith("settings.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(agent, backups[0]), "utf8"), initialSettings);
});

// ---------------------------------------------------------------------------
// Startup-state write — existing behaviour preserved after adding containment check
// ---------------------------------------------------------------------------

test("updateTlhStartupState still writes inside the managed dir", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Must not throw and the read-back must match.
    updateTlhStartupState({ reconciledAt: "2026-01-01T00:00:00.000Z" });
    const statePath = tlhStartupStatePath();
    assert.ok(statePath, "startup state path must be defined inside isolated profile");
    assert.equal(existsSync(statePath), true, "startup state file must exist after write");
    const read = readTlhStartupState();
    assert.equal(read.reconciledAt, "2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// O_NOFOLLOW unavailable — fail-closed path must report failure, not success
// ---------------------------------------------------------------------------

test("writeTlhStateFileAtomicallyCore returns false when O_NOFOLLOW is 0 (unavailable)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
    const statePath = join(fixture.agent, "tlh", "nofollow-test.json");
    // Simulate a platform where O_NOFOLLOW is unavailable (value 0).
    // The fail-closed stance must return false rather than void (which would
    // let a caller falsely report success when nothing was persisted).
    const result = __testing.writeTlhStateFileAtomicallyCore(statePath, '{"x":1}\n', 0);
    assert.equal(result, false, "must return false when O_NOFOLLOW flag is 0");
    assert.equal(existsSync(statePath), false, "must not write when O_NOFOLLOW is unavailable");
  });
});

test("writeTlhStateFileAtomicallyCore returns false when O_NOFOLLOW is undefined", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-profile-state-test-", { test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
    const statePath = join(fixture.agent, "tlh", "nofollow-undef-test.json");
    const result = __testing.writeTlhStateFileAtomicallyCore(statePath, '{"x":1}\n', undefined);
    assert.equal(result, false, "must return false when O_NOFOLLOW flag is undefined");
    assert.equal(existsSync(statePath), false, "must not write when O_NOFOLLOW is undefined");
  });
});
