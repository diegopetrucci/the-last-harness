import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { LEGACY_THEME_NAME, LEGACY_THEME_NOTICE, maybeNotifyLegacyThemeNotice } = await jiti.import(
  "../extensions/the-last-harness/legacy-theme-notice.ts",
);

function createContext({ notifications, themeName, mode = "tui", hasUI = true, notify } = {}) {
  return {
    mode,
    hasUI,
    ui: {
      theme: themeName === undefined ? {} : { name: themeName },
      notify(message, type) {
        if (notify) {
          notify(message, type);
          return;
        }
        notifications.push({ message, type });
      },
    },
  };
}

function profileEnv(fixture, child = false) {
  return {
    HOME: fixture.home,
    PI_CODING_AGENT_DIR: fixture.agent,
    PI_SUBAGENT_CHILD: child ? "1" : undefined,
  };
}

function startupStatePath(fixture) {
  return join(fixture.agent, "tlh", "startup-state.json");
}

function readStartupState(fixture) {
  return JSON.parse(readFileSync(startupStatePath(fixture), "utf8"));
}

test("legacy theme notice uses exact wording, info severity, and persists only after display", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-theme-notice-test-", { test: t });
  const notifications = [];

  await withEnv(profileEnv(fixture), () => {
    const context = createContext({
      notifications,
      themeName: LEGACY_THEME_NAME,
    });

    maybeNotifyLegacyThemeNotice(context, "startup");

    assert.deepEqual(notifications, [{ message: LEGACY_THEME_NOTICE, type: "info" }]);
    assert.equal(context.ui.theme.name, LEGACY_THEME_NAME, "the selected theme must not change");
    assert.equal(readStartupState(fixture).legacyThemeNoticeDisplayed, true);
  });
});

test("persisted marker suppresses later launches and reloads", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-theme-notice-dedupe-", { test: t });
  const notifications = [];
  const context = createContext({ notifications, themeName: LEGACY_THEME_NAME });

  await withEnv(profileEnv(fixture), () => {
    maybeNotifyLegacyThemeNotice(context, "startup");
    maybeNotifyLegacyThemeNotice(context, "startup");
    maybeNotifyLegacyThemeNotice(context, "reload");
  });

  assert.equal(notifications.length, 1);
});

test("other or missing themes, noninteractive modes, and child launches stay silent", async (t) => {
  const cases = [
    { name: "system theme", themeName: "system" },
    { name: "custom theme", themeName: "another-theme" },
    { name: "missing theme", themeName: undefined },
    { name: "headless context", themeName: LEGACY_THEME_NAME, hasUI: false },
    { name: "RPC context", themeName: LEGACY_THEME_NAME, mode: "rpc" },
    { name: "new session", themeName: LEGACY_THEME_NAME, reason: "new" },
    { name: "resumed session", themeName: LEGACY_THEME_NAME, reason: "resume" },
    { name: "forked session", themeName: LEGACY_THEME_NAME, reason: "fork" },
  ];

  for (const entry of cases) {
    const fixture = createIsolatedProfileFixture("tlh-theme-notice-silent-", { test: t });
    const notifications = [];
    await withEnv(profileEnv(fixture), () => {
      maybeNotifyLegacyThemeNotice(
        createContext({
          notifications,
          themeName: entry.themeName,
          mode: entry.mode,
          hasUI: entry.hasUI,
        }),
        entry.reason ?? "startup",
      );
    });
    assert.deepEqual(notifications, [], `${entry.name} must not notify`);
  }

  const childFixture = createIsolatedProfileFixture("tlh-theme-notice-child-", { test: t });
  const childNotifications = [];
  await withEnv(profileEnv(childFixture, true), () => {
    maybeNotifyLegacyThemeNotice(
      createContext({
        childNotifications,
        notifications: childNotifications,
        themeName: LEGACY_THEME_NAME,
      }),
      "startup",
    );
  });
  assert.deepEqual(childNotifications, [], "child launch must not notify");
});

test("legacy theme markers are independent between isolated profiles", async (t) => {
  const first = createIsolatedProfileFixture("tlh-theme-notice-profile-a-", { test: t });
  const second = createIsolatedProfileFixture("tlh-theme-notice-profile-b-", { test: t });
  const firstNotifications = [];
  const secondNotifications = [];

  await withEnv(profileEnv(first), () => {
    maybeNotifyLegacyThemeNotice(
      createContext({ notifications: firstNotifications, themeName: LEGACY_THEME_NAME }),
      "startup",
    );
  });
  await withEnv(profileEnv(second), () => {
    maybeNotifyLegacyThemeNotice(
      createContext({ notifications: secondNotifications, themeName: LEGACY_THEME_NAME }),
      "startup",
    );
  });

  assert.equal(firstNotifications.length, 1);
  assert.equal(secondNotifications.length, 1);
  assert.equal(readStartupState(first).legacyThemeNoticeDisplayed, true);
  assert.equal(readStartupState(second).legacyThemeNoticeDisplayed, true);
});

test("state read and write failures are nonfatal and do not falsely mark the notice", async (t) => {
  const readFailure = createIsolatedProfileFixture("tlh-theme-notice-read-error-", { test: t });
  const readNotifications = [];
  mkdirSync(join(readFailure.agent, "tlh"), { recursive: true });
  mkdirSync(startupStatePath(readFailure));

  await withEnv(profileEnv(readFailure), () => {
    assert.doesNotThrow(() => {
      maybeNotifyLegacyThemeNotice(
        createContext({ notifications: readNotifications, themeName: LEGACY_THEME_NAME }),
        "startup",
      );
    });
  });
  assert.equal(readNotifications.length, 1, "a state read error must not hide the notice");
  assert.equal(lstatSync(startupStatePath(readFailure)).isDirectory(), true);

  const writeFailure = createIsolatedProfileFixture("tlh-theme-notice-write-error-", { test: t });
  const writeNotifications = [];
  mkdirSync(join(writeFailure.agent, "tlh"), { recursive: true });
  const target = join(writeFailure.agent, "tlh", "other-state.json");
  writeFileSync(target, "{}\n", "utf8");
  symlinkSync(target, startupStatePath(writeFailure));

  await withEnv(profileEnv(writeFailure), () => {
    assert.doesNotThrow(() => {
      maybeNotifyLegacyThemeNotice(
        createContext({ notifications: writeNotifications, themeName: LEGACY_THEME_NAME }),
        "startup",
      );
    });
  });
  assert.equal(writeNotifications.length, 1, "a state write error must not block the notice");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {});

  const notifyFailure = createIsolatedProfileFixture("tlh-theme-notice-notify-error-", { test: t });
  mkdirSync(join(notifyFailure.agent, "tlh"), { recursive: true });
  await withEnv(profileEnv(notifyFailure), () => {
    assert.doesNotThrow(() => {
      maybeNotifyLegacyThemeNotice(
        createContext({
          notifications: [],
          themeName: LEGACY_THEME_NAME,
          notify() {
            throw new Error("UI unavailable");
          },
        }),
        "startup",
      );
    });
  });
  assert.equal(
    lstatSync(join(notifyFailure.agent, "tlh")).isDirectory(),
    true,
    "a failed display must not create a marker",
  );
  assert.equal(
    (() => {
      try {
        return readStartupState(notifyFailure).legacyThemeNoticeDisplayed;
      } catch {
        return undefined;
      }
    })(),
    undefined,
  );
});
