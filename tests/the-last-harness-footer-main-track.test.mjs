import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhFooter } = await jiti.import("../extensions/the-last-harness/footer.ts");

const theme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const pi = {
  getThinkingLevel: () => "medium",
  getActiveTools: () => [],
  getAllTools: () => [],
};

function createCtx() {
  return {
    model: { id: "test-model", contextWindow: 100_000 },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/workspace",
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
    ui: { getEditorText: () => "" },
    isIdle: () => true,
  };
}

function createFooterData() {
  return {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  };
}

function createMainNotice(commitSubject) {
  return {
    kind: "ref",
    detail: "main",
    summary: "TLH install notice",
    commitSubject,
    commitSha: "a".repeat(40),
  };
}

function renderMainNotice({ behindCount, commitSubject, width = 200, colorAware = false } = {}) {
  const footer = createTlhFooter(
    pi,
    createCtx(),
    colorAware ? theme : plainTheme,
    () => "architect",
    createFooterData(),
    {},
    null,
    createMainNotice(commitSubject),
    undefined,
    { behindCount },
  );
  return footer.render(width).at(-1) ?? "";
}

test("main-track footer renders singular and plural behind counts as dim suffixes", () => {
  assert.equal(
    renderMainNotice({ behindCount: 1, colorAware: true }),
    "<dim>TLH </dim><warning>main</warning><dim> • </dim><dim>1 commit behind origin/main</dim>",
  );
  assert.equal(
    renderMainNotice({ behindCount: 3, colorAware: true }),
    "<dim>TLH </dim><warning>main</warning><dim> • </dim><dim>3 commits behind origin/main</dim>",
  );
});

test("main-track footer suppresses invalid, non-main, and missing display state", () => {
  assert.equal(renderMainNotice({ behindCount: 0 }), "TLH main");
  assert.equal(renderMainNotice({ behindCount: undefined }), "TLH main");
  assert.equal(
    createTlhFooter(
      pi,
      createCtx(),
      plainTheme,
      () => "architect",
      createFooterData(),
      {},
      null,
      { kind: "ref", detail: "feature/footer", summary: "notice", commitSha: "a".repeat(40) },
      undefined,
      { behindCount: 2 },
    )
      .render(200)
      .at(-1),
    "TLH feature/footer",
  );
  assert.equal(
    createTlhFooter(
      pi,
      createCtx(),
      plainTheme,
      () => "architect",
      createFooterData(),
      {},
      null,
      { kind: "ref", detail: "main", summary: "notice" },
      undefined,
      { behindCount: 2 },
    )
      .render(200)
      .at(-1),
    "TLH main",
  );
});

test("main-track footer keeps the install line within narrow widths", () => {
  const line = renderMainNotice({
    behindCount: 123,
    commitSubject: "A very long persisted subject",
    width: 20,
  });
  assert.ok(visibleWidth(line) <= 20);
  assert.match(line, /\.\.\./);
});
