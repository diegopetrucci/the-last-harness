import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const RETIRED_RUN_TESTS_LAST_FEATURE = "run-tests-last";
const RETIRED_DELTA_FOLLOW_UP_REVIEWS_FEATURE = "delta-follow-up-reviews";
const RETIRED_CI_FAILURE_INVESTIGATION_FEATURE = "ci-failure-investigation";
const RETIRED_EXPERIMENTAL_FEATURES = [
  RETIRED_DELTA_FOLLOW_UP_REVIEWS_FEATURE,
  RETIRED_CI_FAILURE_INVESTIGATION_FEATURE,
];
const LEGACY_UNKNOWN_FEATURE = "legacy-flag";
const SERIAL_TEST = { concurrency: false };
const jiti = createJiti(import.meta.url);
const {
  SESSION_MIRROR_OBSERVER_FEATURE,
  buildPrimaryExperimentalPrompt,
  getTlhExperimentalConfig,
  isTlhExperimentalFeatureEnabled,
  registerExperimentalCommand,
} = await jiti.import("../extensions/the-last-harness/experimental.ts");

function createPiHarness() {
  const commands = new Map();
  const emittedEvents = [];
  return {
    commands,
    emittedEvents,
    events: {
      emit(name, payload) {
        emittedEvents.push({ name, payload });
      },
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

function createCommandContext(cwd, { mode = "print", hasUI = false, selectResponses = [] } = {}) {
  const notifications = [];
  const selectCalls = [];
  const pendingSelections = [...selectResponses];
  return {
    notifications,
    selectCalls,
    ctx: {
      cwd,
      mode,
      hasUI,
      ui: {
        notify(message, type = "info") {
          notifications.push({ message, type });
        },
        async select(prompt, options) {
          selectCalls.push({ prompt, options });
          if (pendingSelections.length === 0) {
            return null;
          }
          const nextSelection = pendingSelections.shift();
          return typeof nextSelection === "function" ? nextSelection(options) : nextSelection;
        },
      },
    },
  };
}

function registeredExperimentalCommand() {
  const pi = createPiHarness();
  registerExperimentalCommand(pi);
  const command = pi.commands.get("experimental");
  assert.ok(command, "registers /experimental");
  return command;
}

test(
  "experimental command exposes the companion mirroring feature as a default-off picker entry",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      assert.equal(existsSync(settingsPath), false, "fresh profiles do not auto-add feature flags");
      const command = registeredExperimentalCommand();
      assert.deepEqual(
        (await command.getArgumentCompletions("enable ")).map((completion) => completion.value),
        [`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`],
      );
      assert.deepEqual(
        (await command.getArgumentCompletions("status ")).map((completion) => completion.value),
        ["status", `status ${SESSION_MIRROR_OBSERVER_FEATURE}`],
      );
      assert.equal(await command.getArgumentCompletions("unknown"), null);

      const { ctx, notifications } = createCommandContext(fixture.dir);
      await command.handler("list", ctx);

      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /delta-follow-up-reviews/);
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /ci-failure-investigation/);
      assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
      assert.match(notifications.at(-1)?.message ?? "", /iPhone companion session mirroring/i);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /paired companion can submit .*user-message replies/i,
      );
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /aggregate-only/i);
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /session-mirror-replies/);
      assert.match(notifications.at(-1)?.message ?? "", /next session/i);
      assert.equal(existsSync(settingsPath), false, "listing does not auto-add the feature flag");
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /embedded-subagents/);
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /run-tests-last/);

      const staleStatus = createCommandContext(fixture.dir);
      await command.handler("status embedded-subagents", staleStatus.ctx);
      assert.match(
        staleStatus.notifications.at(-1)?.message ?? "",
        /unknown tlh experimental feature/i,
      );
    });
  },
);

test(
  "session-mirror observer enable warns about paired replies and defers activation",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications } = createCommandContext(fixture.dir);
      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(
        notifications.at(-1)?.message ?? "",
        /paired companion can submit .*user-message replies/i,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /enabling takes effect on the next session/i,
      );
      assert.match(notifications.at(-1)?.message ?? "", /current activation/i);

      await command.handler(`disable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /disabling takes effect on the next session/i,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /currently enabled session retains activation until a new session/i,
      );
      assert.match(notifications.at(-1)?.message ?? "", /not immediate revocation/i);
    });
  },
);

test(
  "experimental command opens a TUI picker with no args and toggles selections until cancelled",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const pi = createPiHarness();
      registerExperimentalCommand(pi);
      const command = pi.commands.get("experimental");
      const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, {
        mode: "tui",
        hasUI: true,
        selectResponses: [(options) => options[0], null],
      });

      await command.handler("", ctx);

      assert.equal(selectCalls.length, 2);
      assert.match(selectCalls[0].prompt, /toggle tlh experimental features/i);
      assert.match(selectCalls[0].options[0], new RegExp(SESSION_MIRROR_OBSERVER_FEATURE));
      assert.match(selectCalls[0].options[0], /disabled \(default\)/i);
      const observerOption = selectCalls[0].options.find((option) =>
        option.includes(SESSION_MIRROR_OBSERVER_FEATURE),
      );
      assert.match(observerOption ?? "", /iPhone companion session mirroring/i);
      assert.match(observerOption ?? "", /paired companion can submit .*user-message replies/i);
      assert.match(observerOption ?? "", /disabled \(default\)/i);
      assert.deepEqual(
        JSON.parse(readFileSync(settingsPath, "utf8")).tlh.experimental.enabledFeatures,
        [SESSION_MIRROR_OBSERVER_FEATURE],
      );
      assert.match(selectCalls[1].options[0], /enabled/i);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /Updated TLH experimental feature session-mirror-observer/,
      );
      assert.deepEqual(pi.emittedEvents.at(-1), {
        name: "tlh:experimental-feature-changed",
        payload: { cwd: fixture.dir, enabled: true, featureId: SESSION_MIRROR_OBSERVER_FEATURE },
      });
    });
  },
);

test(
  "experimental command falls back to status output with no args when UI is unavailable",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, {
        hasUI: false,
      });

      await command.handler("", ctx);

      assert.equal(selectCalls.length, 0);
      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
      assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
      assert.doesNotMatch(
        notifications.at(-1)?.message ?? "",
        /delta-follow-up-reviews|ci-failure-investigation/,
      );
    });
  },
);

test(
  "experimental command falls back to status output with no args outside TUI even when UI is available",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications, selectCalls } = createCommandContext(fixture.dir, {
        mode: "rpc",
        hasUI: true,
      });

      await command.handler("", ctx);

      assert.equal(selectCalls.length, 0);
      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(notifications.at(-1)?.message ?? "", /TLH experimental features:/);
      assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
      assert.doesNotMatch(
        notifications.at(-1)?.message ?? "",
        /delta-follow-up-reviews|ci-failure-investigation/,
      );
    });
  },
);

test("contrarian experimental settings stay harmless and no longer inject primary prompts", () => {
  assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, undefined), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, undefined), undefined);

  const legacyConfig = { enabledFeatures: ["contrarian"] };
  assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, legacyConfig), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, legacyConfig), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "product" }, legacyConfig), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "bug-hunter" }, legacyConfig), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "developer" }, legacyConfig), undefined);
});

test("retired experimental flags stay inert and do not inject primary prompts", () => {
  assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, undefined), undefined);
  assert.equal(buildPrimaryExperimentalPrompt({ name: "rush" }, undefined), undefined);

  const retiredConfig = { enabledFeatures: RETIRED_EXPERIMENTAL_FEATURES };
  for (const primary of ["architect", "rush", "product", "bug-hunter", "developer"]) {
    assert.equal(buildPrimaryExperimentalPrompt({ name: primary }, retiredConfig), undefined);
  }
});

test(
  "experimental helpers treat stale contrarian settings as harmless while malformed arrays still fail closed",
  SERIAL_TEST,
  async (t) => {
    const enabledFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    writeFileSync(
      join(enabledFixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [" Contrarian "] } } }, null, 2)}\n`,
    );

    await withEnv(
      { HOME: enabledFixture.home, PI_CODING_AGENT_DIR: enabledFixture.agent },
      async () => {
        const command = registeredExperimentalCommand();
        const config = getTlhExperimentalConfig(enabledFixture.dir);
        assert.equal(isTlhExperimentalFeatureEnabled(config, "contrarian"), false);
        assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, config), undefined);

        let { ctx, notifications } = createCommandContext(enabledFixture.dir);
        await command.handler("", ctx);
        assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);

        ({ ctx, notifications } = createCommandContext(enabledFixture.dir));
        await command.handler("status contrarian", ctx);
        assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
      },
    );

    const malformedFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    writeFileSync(
      join(malformedFixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["Contrarian", 123] } } }, null, 2)}\n`,
    );

    await withEnv(
      { HOME: malformedFixture.home, PI_CODING_AGENT_DIR: malformedFixture.agent },
      async () => {
        const command = registeredExperimentalCommand();
        const config = getTlhExperimentalConfig(malformedFixture.dir);
        assert.equal(isTlhExperimentalFeatureEnabled(config, "contrarian"), false);
        assert.equal(buildPrimaryExperimentalPrompt({ name: "architect" }, config), undefined);

        let { ctx, notifications } = createCommandContext(malformedFixture.dir);
        await command.handler("", ctx);
        assert.doesNotMatch(notifications.at(-1)?.message ?? "", /contrarian/);

        ({ ctx, notifications } = createCommandContext(malformedFixture.dir));
        await command.handler("status contrarian", ctx);
        assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
      },
    );
  },
);

test(
  "experimental stale settings fail closed and do not rebuild retired or promoted guidance",
  SERIAL_TEST,
  async (t) => {
    for (const enabledFeatures of [
      true,
      [123],
      [RETIRED_RUN_TESTS_LAST_FEATURE],
      ...RETIRED_EXPERIMENTAL_FEATURES.map((feature) => [feature]),
      ["contrarian"],
      ["session-mirror-replies"],
    ]) {
      const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
      const settingsPath = join(fixture.agent, "settings.json");
      const malformedOrStaleSettings = `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`;
      writeFileSync(settingsPath, malformedOrStaleSettings);

      await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
        const command = registeredExperimentalCommand();
        assert.equal(
          isTlhExperimentalFeatureEnabled(
            getTlhExperimentalConfig(fixture.dir),
            RETIRED_RUN_TESTS_LAST_FEATURE,
          ),
          false,
        );
        assert.equal(
          buildPrimaryExperimentalPrompt(
            { name: "architect" },
            getTlhExperimentalConfig(fixture.dir),
          ),
          undefined,
        );

        let { ctx, notifications } = createCommandContext(fixture.dir);
        await command.handler("", ctx);
        assert.equal(notifications.at(-1)?.type, "info");
        assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
        assert.match(notifications.at(-1)?.message ?? "", /disabled \(default\)/);
        assert.doesNotMatch(
          notifications.at(-1)?.message ?? "",
          /delta-follow-up-reviews|ci-failure-investigation/,
        );
        assert.doesNotMatch(notifications.at(-1)?.message ?? "", /run-tests-last/);

        ({ ctx, notifications } = createCommandContext(fixture.dir));
        await command.handler(`status ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
        assert.equal(notifications.at(-1)?.type, "info");
        assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
        assert.match(notifications.at(-1)?.message ?? "", /run-tests-last/);
        assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
        assert.doesNotMatch(
          notifications.at(-1)?.message ?? "",
          /delta-follow-up-reviews|ci-failure-investigation/,
        );

        for (const action of ["enable", "disable", "toggle"]) {
          ({ ctx, notifications } = createCommandContext(fixture.dir));
          await command.handler(`${action} ${RETIRED_RUN_TESTS_LAST_FEATURE}`, ctx);
          assert.equal(notifications.at(-1)?.type, "error");
          assert.match(
            notifications.at(-1)?.message ?? "",
            new RegExp(
              `Could not update TLH experimental feature ${RETIRED_RUN_TESTS_LAST_FEATURE}:`,
              "i",
            ),
          );
          assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
        }

        assert.equal(readFileSync(settingsPath, "utf8"), malformedOrStaleSettings);
        assert.equal(
          buildPrimaryExperimentalPrompt(
            { name: "developer" },
            getTlhExperimentalConfig(fixture.dir),
          ),
          undefined,
        );
      });
    }
  },
);

test(
  "persisted retired experimental flags are inert without rewriting settings",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");
    const legacySettings = `${JSON.stringify(
      {
        tlh: {
          experimental: {
            enabledFeatures: [
              "session-mirror-replies",
              ...RETIRED_EXPERIMENTAL_FEATURES,
              SESSION_MIRROR_OBSERVER_FEATURE,
            ],
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(settingsPath, legacySettings);

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const config = getTlhExperimentalConfig(fixture.dir);

      // Retired and legacy flags are treated as unknown/ignored.
      assert.equal(isTlhExperimentalFeatureEnabled(config, "session-mirror-replies"), false);
      for (const retiredFeature of RETIRED_EXPERIMENTAL_FEATURES) {
        assert.equal(isTlhExperimentalFeatureEnabled(config, retiredFeature), false);
      }
      // Known flag in the same array still works.
      assert.equal(isTlhExperimentalFeatureEnabled(config, SESSION_MIRROR_OBSERVER_FEATURE), true);

      // List shows only the registered feature, with no error output or stale flags.
      let { ctx, notifications } = createCommandContext(fixture.dir);
      await command.handler("list", ctx);
      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(notifications.at(-1)?.message ?? "", /session-mirror-observer/);
      assert.doesNotMatch(
        notifications.at(-1)?.message ?? "",
        /session-mirror-replies|delta-follow-up-reviews|ci-failure-investigation/,
      );

      for (const retiredFeature of RETIRED_EXPERIMENTAL_FEATURES) {
        ({ ctx, notifications } = createCommandContext(fixture.dir));
        await command.handler(`enable ${retiredFeature}`, ctx);
        assert.equal(notifications.at(-1)?.type, "error");
        assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
      }

      // Settings are not rewritten.
      assert.equal(readFileSync(settingsPath, "utf8"), legacySettings);
    });
  },
);

test(
  "experimental enable is idempotent, preserves settings, and does not clobber other enabled features",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");
    const initialSettings = `${JSON.stringify(
      {
        tlh: {
          primaryAgent: { selected: "architect" },
          experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE] },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(settingsPath, initialSettings);

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications } = createCommandContext(fixture.dir);

      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);

      const writtenAfterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.deepEqual(writtenAfterFirst.tlh.primaryAgent, { selected: "architect" });
      assert.deepEqual(writtenAfterFirst.tlh.experimental.enabledFeatures, [
        LEGACY_UNKNOWN_FEATURE,
        SESSION_MIRROR_OBSERVER_FEATURE,
      ]);
      assert.equal(
        isTlhExperimentalFeatureEnabled(
          getTlhExperimentalConfig(fixture.dir),
          SESSION_MIRROR_OBSERVER_FEATURE,
        ),
        true,
      );
      assert.equal(
        isTlhExperimentalFeatureEnabled(
          getTlhExperimentalConfig(fixture.dir),
          RETIRED_RUN_TESTS_LAST_FEATURE,
        ),
        false,
      );

      const backupsAfterFirst = readdirSync(fixture.agent).filter((entry) =>
        entry.startsWith("settings.json.bak-"),
      );
      assert.equal(backupsAfterFirst.length, 1);
      assert.equal(
        readFileSync(join(fixture.agent, backupsAfterFirst[0]), "utf8"),
        initialSettings,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /Updated TLH experimental feature session-mirror-observer/,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /Undo with \/experimental disable session-mirror-observer/,
      );
      assert.match(notifications.at(-1)?.message ?? "", /Backup:/);

      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);

      assert.deepEqual(
        readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
        backupsAfterFirst,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /No change to TLH experimental feature session-mirror-observer/,
      );
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Backup:/);
    });
  },
);

test(
  "session-mirror enable, disable, and toggle preserve unrelated settings",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          defaultThinkingLevel: "medium",
          tlh: {
            primaryAgent: { selected: "architect" },
            experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE] },
          },
        },
        null,
        2,
      )}\n`,
    );

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications } = createCommandContext(fixture.dir);

      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(settings.defaultThinkingLevel, "medium");
      assert.deepEqual(settings.tlh.primaryAgent, { selected: "architect" });
      assert.equal(
        settings.tlh.experimental.enabledFeatures.includes(LEGACY_UNKNOWN_FEATURE),
        true,
      );
      assert.equal(
        settings.tlh.experimental.enabledFeatures.includes(SESSION_MIRROR_OBSERVER_FEATURE),
        true,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /paired companion can submit .*user-message replies/i,
      );

      await command.handler(`toggle ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(settings.defaultThinkingLevel, "medium");
      assert.deepEqual(settings.tlh.primaryAgent, { selected: "architect" });
      assert.deepEqual(settings.tlh.experimental.enabledFeatures, [LEGACY_UNKNOWN_FEATURE]);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /disabling takes effect on the next session/i,
      );
      assert.match(
        notifications.at(-1)?.message ?? "",
        /currently enabled session retains activation until a new session/i,
      );

      await command.handler(`toggle ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(settings.defaultThinkingLevel, "medium");
      assert.deepEqual(settings.tlh.primaryAgent, { selected: "architect" });
      assert.equal(
        settings.tlh.experimental.enabledFeatures.includes(SESSION_MIRROR_OBSERVER_FEATURE),
        true,
      );
    });
  },
);

test(
  "experimental enable then disable in one frozen millisecond creates collision-safe backups",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");
    const initialSettings = `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE] } } }, null, 2)}\n`;
    writeFileSync(settingsPath, initialSettings);
    const frozenIso = "2026-07-19T16:17:18.901Z";
    const realDate = globalThis.Date;
    class FrozenDate extends Date {
      constructor(value) {
        super(value ?? frozenIso);
      }
      static now() {
        return new realDate(frozenIso).getTime();
      }
    }

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      globalThis.Date = FrozenDate;
      t.after(() => {
        globalThis.Date = realDate;
      });

      const command = registeredExperimentalCommand();

      let { ctx, notifications } = createCommandContext(fixture.dir);
      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /settings\.json\.bak-2026-07-19T16-17-18-901Z/,
      );

      ({ ctx, notifications } = createCommandContext(fixture.dir));
      await command.handler(`disable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);
      assert.match(
        notifications.at(-1)?.message ?? "",
        /settings\.json\.bak-2026-07-19T16-17-18-901Z-1/,
      );
    });

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.tlh.experimental.enabledFeatures, [LEGACY_UNKNOWN_FEATURE]);

    const backups = readdirSync(fixture.agent)
      .filter((entry) => entry.startsWith("settings.json.bak-"))
      .sort();
    assert.deepEqual(backups, [
      "settings.json.bak-2026-07-19T16-17-18-901Z",
      "settings.json.bak-2026-07-19T16-17-18-901Z-1",
    ]);
    assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);
    assert.equal(
      readFileSync(join(fixture.agent, backups[1]), "utf8"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [LEGACY_UNKNOWN_FEATURE, SESSION_MIRROR_OBSERVER_FEATURE] } } }, null, 2)}\n`,
    );
  },
);

test(
  "experimental disable and normal-Pi refusal follow isolated settings rules",
  SERIAL_TEST,
  async (t) => {
    const disableFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const disableSettingsPath = join(disableFixture.agent, "settings.json");
    writeFileSync(
      disableSettingsPath,
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [SESSION_MIRROR_OBSERVER_FEATURE] } } }, null, 2)}\n`,
    );

    await withEnv(
      { HOME: disableFixture.home, PI_CODING_AGENT_DIR: disableFixture.agent },
      async () => {
        const command = registeredExperimentalCommand();
        const { ctx, notifications } = createCommandContext(disableFixture.dir);

        await command.handler(`disable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);

        const written = JSON.parse(readFileSync(disableSettingsPath, "utf8"));
        assert.deepEqual(written.tlh.experimental.enabledFeatures, []);
        assert.match(notifications.at(-1)?.message ?? "", /It is now disabled/);
        assert.match(
          notifications.at(-1)?.message ?? "",
          /Undo with \/experimental enable session-mirror-observer/,
        );
      },
    );

    const normalFixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const normalAgent = join(normalFixture.home, ".pi", "agent");

    await withEnv({ HOME: normalFixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
      const command = registeredExperimentalCommand();
      const { ctx, notifications } = createCommandContext(normalFixture.dir);

      await command.handler(`enable ${SESSION_MIRROR_OBSERVER_FEATURE}`, ctx);

      assert.equal(existsSync(join(normalAgent, "settings.json")), false);
      assert.equal(notifications.at(-1)?.type, "error");
      assert.match(notifications.at(-1)?.message ?? "", /isolated TLH profile|normal Pi config/);
    });
  },
);

test(
  "experimental retired flag actions do not create settings or backups on a fresh profile",
  SERIAL_TEST,
  async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-experimental-test-", { test: t });
    const settingsPath = join(fixture.agent, "settings.json");

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const command = registeredExperimentalCommand();
      for (const retiredFeature of [
        RETIRED_RUN_TESTS_LAST_FEATURE,
        ...RETIRED_EXPERIMENTAL_FEATURES,
      ]) {
        for (const action of ["enable", "disable", "toggle"]) {
          const { ctx, notifications } = createCommandContext(fixture.dir);
          await command.handler(`${action} ${retiredFeature}`, ctx);

          assert.equal(notifications.at(-1)?.type, "error");
          assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
          assert.match(notifications.at(-1)?.message ?? "", new RegExp(retiredFeature));
        }

        const { ctx, notifications } = createCommandContext(fixture.dir);
        await command.handler(`status ${retiredFeature}`, ctx);
        assert.equal(notifications.at(-1)?.type, "info");
        assert.match(notifications.at(-1)?.message ?? "", /unknown tlh experimental feature/i);
      }

      assert.equal(existsSync(settingsPath), false);
      assert.deepEqual(
        readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")),
        [],
      );
    });
  },
);
