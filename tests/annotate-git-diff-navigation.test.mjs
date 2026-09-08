import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const navigationSource = readFileSync(
  new URL("../extensions/annotate-git-diff/web/review-navigation.js", import.meta.url),
  "utf8",
);

class FakeElement {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.style = {};
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event);
  }
}

function createNavigationHarness() {
  const context = vm.createContext({});
  context.document = { createElement: () => new FakeElement() };
  vm.runInContext(navigationSource, context, { filename: "review-navigation.js" });

  const files = [
    {
      id: "src-app",
      path: "src/app.js",
      inGitDiff: true,
      worktreeStatus: "modified",
      kind: "text",
      gitDiff: { status: "modified" },
    },
    {
      id: "src-api",
      path: "src/api/client.js",
      inGitDiff: true,
      worktreeStatus: "added",
      kind: "text",
      gitDiff: { status: "added" },
    },
    {
      id: "docs-guide",
      path: "docs/guide.md",
      inGitDiff: false,
      worktreeStatus: null,
      kind: "text",
      gitDiff: null,
    },
  ];
  const commitFile = {
    id: "commit:c1:src-app",
    path: "src/app.js",
    inGitDiff: true,
    worktreeStatus: null,
    kind: "text",
    gitDiff: { status: "modified" },
  };
  const secondCommitFile = { ...commitFile, id: "commit:c2:src-app" };
  const reviewData = {
    files,
    commits: [
      { sha: "c1", shortSha: "c1", subject: "First", kind: "commit" },
      { sha: "c2", shortSha: "c2", subject: "Second", kind: "commit" },
    ],
    repositoryHasHead: true,
  };
  const state = {
    activeFileId: null,
    currentScope: "branch",
    selectedCommitSha: "c1",
    commitFilesBySha: { c1: [commitFile], c2: [secondCommitFile] },
    commitRequestIds: {},
    commitErrors: {},
    reviewDataRequestId: null,
    comments: [],
    overallComment: "",
    collapsedDirs: {},
    reviewedFiles: {},
    fileFilter: "",
    localChangesDetected: false,
    lastLocalChangeDetectedAt: null,
    lastWorkingTreeLoadAt: null,
  };
  const elements = {
    sidebarEl: new FakeElement(),
    sidebarTitleEl: new FakeElement(),
    toggleSidebarButton: new FakeElement(),
    scopeBranchButton: new FakeElement(),
    scopeCommitsButton: new FakeElement(),
    scopeAllButton: new FakeElement(),
    commitPickerEl: new FakeElement(),
    commitListEl: new FakeElement(),
    fileTreeEl: new FakeElement(),
    summaryEl: new FakeElement(),
    refreshReviewButton: new FakeElement(),
  };
  const calls = [];
  const navigation = context.__createReviewNavigation({
    reviewData,
    state,
    elements,
    icons: {
      OCTICON_CHEVRON_DOWN: "down",
      OCTICON_CHEVRON_RIGHT: "right",
      OCTICON_FOLDER: "folder",
      OCTICON_FILE: "file",
    },
    callbacks: {
      escapeHtml: (value) => String(value),
      getRequestState: () => ({ contents: {}, error: null, requestId: null }),
      getActiveStatus: (file) => file.gitDiff?.status ?? file.worktreeStatus,
      isFileReviewed: (fileId) => state.reviewedFiles[fileId] === true,
      fileKindBadgeMarkup: () => "",
      saveCurrentScrollPosition: () => calls.push("save-scroll"),
      renderAll: (options) => {
        calls.push(["render-all", options]);
        navigation.ensureActiveFileForScope();
        navigation.updateScopeButtons();
      },
      ensureFileLoaded: (...args) => calls.push(["load-file", ...args]),
      ensureCommitFilesLoaded: (...args) => calls.push(["load-commit", ...args]),
      updateToggleButtons: () => calls.push("update-toggles"),
    },
  });

  return { navigation, reviewData, state, elements, calls };
}

test("review navigation preserves fuzzy filtering and tree/search presentation", () => {
  const { navigation, state, elements } = createNavigationHarness();

  state.currentScope = "all";
  state.fileFilter = "client";
  assert.deepEqual(
    navigation.getFilteredFiles().map((file) => file.id),
    ["src-api"],
  );
  navigation.renderTree();
  assert.equal(elements.fileTreeEl.children.length, 1);
  assert.match(elements.fileTreeEl.children[0].innerHTML, /client\.js/);

  state.fileFilter = "";
  navigation.renderTree();
  assert.ok(elements.fileTreeEl.children.length >= 4);
  assert.ok(elements.fileTreeEl.children.some((child) => child.innerHTML.includes("folder")));
  assert.ok(elements.fileTreeEl.children.some((child) => child.innerHTML.includes("guide.md")));
});

test("review navigation owns scope and commit selection while delegating loading/editor coordination", () => {
  const { navigation, state, elements, calls } = createNavigationHarness();

  navigation.ensureActiveFileForScope();
  assert.equal(state.activeFileId, "src-app");
  navigation.switchScope("commits");
  assert.equal(state.currentScope, "commits");
  assert.equal(state.activeFileId, "commit:c1:src-app");
  assert.equal(calls.length, 4);
  assert.equal(calls[0], "save-scroll");
  assert.deepEqual(calls[1], ["load-commit", "c1"]);
  assert.equal(calls[2][0], "render-all");
  assert.equal(calls[2][1].restoreFileScroll, true);
  assert.deepEqual(calls[3], ["load-file", "commit:c1:src-app", "commits"]);
  assert.equal(elements.commitPickerEl.style.display, "");

  navigation.renderCommitList();
  assert.equal(elements.commitListEl.children.length, 2);
  elements.commitListEl.children[1].dispatch("click");
  assert.equal(state.selectedCommitSha, "c2");
  assert.equal(calls.length, 8);
  assert.equal(calls[4], "save-scroll");
  assert.deepEqual(calls[5], ["load-commit", "c2"]);
  assert.equal(calls[6][0], "render-all");
  assert.equal(calls[6][1].restoreFileScroll, false);
  assert.deepEqual(calls[7], ["load-file", "commit:c2:src-app", "commits"]);
});
