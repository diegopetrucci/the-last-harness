import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { classifyTlhInstallState, formatTlhInstallNoticeTrackLabel, readTlhInstallNotice } =
  await jiti.import("../extensions/the-last-harness/install-state.ts");
const { readTlhInstallState } = await jiti.import(
  "../extensions/the-last-harness/profile-state.ts",
);

const OFFICIAL_LATEST_STABLE = {
  repo: "diegopetrucci/the-last-harness",
  track: "latest-release",
  ref: "v0.10.0",
  packageSource: "git:github.com/diegopetrucci/the-last-harness@v0.10.0",
  packageSourceIsDefault: true,
};

function assertNoticeLabel(notice, label, message) {
  assert.ok(notice, message);
  assert.equal(formatTlhInstallNoticeTrackLabel(notice), label, message);
}

function createInstallStateFixture(t, contents) {
  const fixture = createIsolatedProfileFixture("tlh-install-state-reader-", { test: t });
  const stateDir = join(fixture.agent, "tlh");
  mkdirSync(stateDir, { recursive: true });
  if (contents !== undefined) {
    writeFileSync(
      join(stateDir, "install-state.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents),
      "utf8",
    );
  }
  return fixture;
}

function withInstallStateProfile(fixture, callback) {
  return withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, callback);
}

test("readTlhInstallState synchronously parses valid install-state JSON", async (t) => {
  const fixture = createInstallStateFixture(t, OFFICIAL_LATEST_STABLE);
  await withInstallStateProfile(fixture, () => {
    assert.deepEqual(readTlhInstallState(), OFFICIAL_LATEST_STABLE);
  });
});

test("readTlhInstallState synchronously returns {} for missing or corrupt JSON", async (t) => {
  const missingFixture = createInstallStateFixture(t);
  await withInstallStateProfile(missingFixture, () => {
    assert.deepEqual(readTlhInstallState(), {});
  });

  const corruptFixture = createInstallStateFixture(t, "NOT JSON");
  await withInstallStateProfile(corruptFixture, () => {
    assert.deepEqual(readTlhInstallState(), {});
  });
});

test("synchronous install-state readers return unknown outside an isolated profile", async (t) => {
  const fixture = createInstallStateFixture(t, OFFICIAL_LATEST_STABLE);
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
    assert.deepEqual(readTlhInstallState(), {});
    assert.deepEqual(readTlhInstallNotice(), {
      kind: "unknown",
      summary: "TLH install metadata is missing or invalid.",
    });
  });
});

test("readTlhInstallNotice synchronously returns no notice for official latest-stable installs", async (t) => {
  const fixture = createInstallStateFixture(t, OFFICIAL_LATEST_STABLE);
  await withInstallStateProfile(fixture, () => {
    assert.equal(readTlhInstallNotice(), undefined);
  });
});

test("readTlhInstallNotice synchronously returns unknown for missing or corrupt metadata", async (t) => {
  for (const contents of [undefined, "NOT JSON"]) {
    const fixture = createInstallStateFixture(t, contents);
    await withInstallStateProfile(fixture, () => {
      assert.deepEqual(readTlhInstallNotice(), {
        kind: "unknown",
        summary: "TLH install metadata is missing or invalid.",
      });
    });
  }
});

test("readTlhInstallNotice synchronously classifies ref-track installs", async (t) => {
  const fixture = createInstallStateFixture(t, {
    ...OFFICIAL_LATEST_STABLE,
    track: "ref",
    ref: "main",
    packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
  });
  await withInstallStateProfile(fixture, () => {
    assert.deepEqual(readTlhInstallNotice(), {
      kind: "ref",
      summary: "TLH follows a non-stable git ref.",
      detail: "main",
    });
  });
});

test("classifier returns no notice for official latest-stable installs", () => {
  assert.equal(classifyTlhInstallState(OFFICIAL_LATEST_STABLE), undefined);
});

test("formats pinned/ref/local/unknown labels for install-track notices", () => {
  assertNoticeLabel(
    classifyTlhInstallState({
      ...OFFICIAL_LATEST_STABLE,
      track: "pinned-tag",
    }),
    "v0.10.0",
    "pinned-tag",
  );
  assertNoticeLabel(
    classifyTlhInstallState({
      ...OFFICIAL_LATEST_STABLE,
      track: "ref",
      ref: "main",
      packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
    }),
    "main",
    "ref",
  );
  assertNoticeLabel(
    classifyTlhInstallState({
      ...OFFICIAL_LATEST_STABLE,
      packageSource: "../the-last-harness",
      packageSourceIsDefault: false,
    }),
    "local",
    "local",
  );
  assertNoticeLabel(classifyTlhInstallState(undefined), "unknown", "unknown");
});

test("formats pinned-tag install notices with the pinned ref label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "pinned-tag",
  });
  assert.deepEqual(notice, {
    kind: "pinned-tag",
    summary: "TLH is pinned to a specific release tag.",
    detail: "v0.10.0",
  });
  assertNoticeLabel(notice, "v0.10.0");
});

test("prefers the pinned ref label over a custom package-source label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "pinned-tag",
    packageSource: "../the-last-harness",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "pinned-tag",
    summary: "TLH is pinned to a specific release tag.",
    detail: "v0.10.0",
  });
  assertNoticeLabel(notice, "v0.10.0");
});

test("formats ref install notices with the ref label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "ref",
    ref: "main",
    packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
  });
  assert.deepEqual(notice, {
    kind: "ref",
    summary: "TLH follows a non-stable git ref.",
    detail: "main",
  });
  assertNoticeLabel(notice, "main");
});

test("preserves a valid installed subject only for the main ref label", () => {
  const mainNotice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "ref",
    ref: "main",
    packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
    commitSubject: "  Add the main footer subject  ",
  });
  assert.deepEqual(mainNotice, {
    kind: "ref",
    summary: "TLH follows a non-stable git ref.",
    detail: "main",
    commitSubject: "Add the main footer subject",
  });
  assertNoticeLabel(mainNotice, "main");

  const otherRefNotice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "ref",
    ref: "feature/footer",
    packageSource: "git:github.com/diegopetrucci/the-last-harness@feature/footer",
    commitSubject: "Feature commit subject",
  });
  assert.deepEqual(otherRefNotice, {
    kind: "ref",
    summary: "TLH follows a non-stable git ref.",
    detail: "feature/footer",
  });

  for (const commitSubject of [undefined, "   ", 42]) {
    const notice = classifyTlhInstallState({
      ...OFFICIAL_LATEST_STABLE,
      track: "ref",
      ref: "main",
      packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
      commitSubject,
    });
    assert.deepEqual(notice, {
      kind: "ref",
      summary: "TLH follows a non-stable git ref.",
      detail: "main",
    });
  }
});

test("prefers the ref label over a custom package-source label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "ref",
    ref: "main",
    packageSource: "../the-last-harness",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "ref",
    summary: "TLH follows a non-stable git ref.",
    detail: "main",
  });
  assertNoticeLabel(notice, "main");
});

test("formats custom-track notices with the custom label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    track: "custom",
  });
  assert.deepEqual(notice, {
    kind: "custom-track",
    summary: "TLH uses a custom update track.",
    detail: "custom",
  });
  assertNoticeLabel(notice, "custom");
});

test("formats local package-source notices with the local label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    packageSource: "../the-last-harness",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "custom-package-source",
    summary: "TLH uses a custom package source.",
    detail: "../the-last-harness",
  });
  assertNoticeLabel(notice, "local");
});

test("formats git@ custom package-source notices with the custom label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    packageSource: "git@github.com:owner/repo.git",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "custom-package-source",
    summary: "TLH uses a custom package source.",
    detail: "git@github.com:owner/repo.git",
  });
  assertNoticeLabel(notice, "custom");
});

test("formats host-path custom package-source notices with the custom label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    packageSource: "github.com/owner/repo@main",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "custom-package-source",
    summary: "TLH uses a custom package source.",
    detail: "github.com/owner/repo@main",
  });
  assertNoticeLabel(notice, "custom");
});

test("formats ambiguous custom package-source notices with the custom label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    packageSource: "the-last-harness@next",
    packageSourceIsDefault: false,
  });
  assert.deepEqual(notice, {
    kind: "custom-package-source",
    summary: "TLH uses a custom package source.",
    detail: "the-last-harness@next",
  });
  assertNoticeLabel(notice, "custom");
});

test("formats non-default repository notices with the custom label", () => {
  const notice = classifyTlhInstallState({
    ...OFFICIAL_LATEST_STABLE,
    repo: "someone-else/the-last-harness",
  });
  assert.deepEqual(notice, {
    kind: "non-default-repo",
    summary: "TLH is installed from a non-default repository.",
    detail: "someone-else/the-last-harness",
  });
  assertNoticeLabel(notice, "custom");
});

test("formats missing install-state notices with the unknown label", () => {
  const notice = classifyTlhInstallState(undefined);
  assert.deepEqual(notice, {
    kind: "unknown",
    summary: "TLH install metadata is missing or invalid.",
  });
  assertNoticeLabel(notice, "unknown");
});

test("classifies installs with missing package-source metadata as unknown", () => {
  for (const installState of [
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "latest-release",
      packageSource: undefined,
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "pinned-tag",
      packageSource: undefined,
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "ref",
      ref: "main",
      packageSource: undefined,
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "pinned-tag",
      packageSourceIsDefault: undefined,
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "ref",
      ref: "main",
      packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
      packageSourceIsDefault: undefined,
    },
  ]) {
    const notice = classifyTlhInstallState(installState);
    assert.deepEqual(notice, {
      kind: "unknown",
      summary: "TLH install metadata is missing or invalid.",
    });
    assertNoticeLabel(notice, "unknown");
  }
});

test("classifies pinned-tag/ref installs with invalid package-source metadata as unknown", () => {
  for (const installState of [
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "pinned-tag",
      packageSourceIsDefault: "yes",
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "ref",
      ref: "main",
      packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
      packageSourceIsDefault: 0,
    },
  ]) {
    const notice = classifyTlhInstallState(installState);
    assert.deepEqual(notice, {
      kind: "unknown",
      summary: "TLH install metadata is missing or invalid.",
    });
    assertNoticeLabel(notice, "unknown");
  }
});

test("classifies latest-release/pinned-tag/ref installs with missing ref metadata as unknown", () => {
  for (const [label, installState] of [
    [
      "latest-release",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "latest-release",
        ref: undefined,
      },
    ],
    [
      "pinned-tag",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "pinned-tag",
        ref: undefined,
      },
    ],
    [
      "ref",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "ref",
        ref: undefined,
        packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
      },
    ],
  ]) {
    const notice = classifyTlhInstallState(installState);
    assert.deepEqual(
      notice,
      {
        kind: "unknown",
        summary: "TLH install metadata is missing or invalid.",
      },
      label,
    );
    assertNoticeLabel(notice, "unknown", label);
  }
});

test("classifies latest-release/pinned-tag/ref installs with blank ref metadata as unknown before local/custom labels", () => {
  for (const [label, installState] of [
    [
      "latest-release",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "latest-release",
        ref: "   ",
        packageSource: "../the-last-harness",
        packageSourceIsDefault: false,
      },
    ],
    [
      "pinned-tag",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "pinned-tag",
        ref: "   ",
        packageSource: "../the-last-harness",
        packageSourceIsDefault: false,
      },
    ],
    [
      "ref",
      {
        ...OFFICIAL_LATEST_STABLE,
        track: "ref",
        ref: "   ",
        packageSource: "../the-last-harness",
        packageSourceIsDefault: false,
      },
    ],
  ]) {
    const notice = classifyTlhInstallState(installState);
    assert.deepEqual(
      notice,
      {
        kind: "unknown",
        summary: "TLH install metadata is missing or invalid.",
      },
      label,
    );
    assertNoticeLabel(notice, "unknown", label);
  }
});

test("classifier flags invalid latest-stable install-state as unknown", () => {
  for (const installState of [
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "latest-release",
      packageSource: undefined,
    },
    {
      ...OFFICIAL_LATEST_STABLE,
      track: "latest-release",
      packageSourceIsDefault: undefined,
    },
  ]) {
    assert.deepEqual(classifyTlhInstallState(installState), {
      kind: "unknown",
      summary: "TLH install metadata is missing or invalid.",
    });
  }
});
