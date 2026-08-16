import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyTlhInstallState, formatTlhInstallNoticeTrackLabel } = await jiti.import(
  "../extensions/the-last-harness/install-state.ts",
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
