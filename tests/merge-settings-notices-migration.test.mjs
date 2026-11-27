import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { readJson, runMerge, tempFixture } from "./support/merge-settings-fixtures.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const realDefaults = readJson(join(repoRoot, "config", "settings.defaults.json"));

const noticeKeys = ["cacheMisses", "cacheWarming", "compactionCosts", "reasoningDrops"];

function loadNotices(settingsPath) {
  const cwd = mkdtempSync(join(tmpdir(), "tlh-notices-cwd-"));
  try {
    return SettingsManager.create(cwd, dirname(settingsPath)).getNotices();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("TLH keeps showCacheMissNotices: true in its defaults", () => {
  assert.equal(realDefaults.showCacheMissNotices, true);
});

test("explicit notices.* = false survive TLH merge re-adding showCacheMissNotices and Pi migration", () => {
  const off = Object.fromEntries(noticeKeys.map((key) => [key, false]));
  const fixture = tempFixture(realDefaults, { packages: [], notices: off });

  runMerge(fixture);
  const merged = readJson(fixture.settings);
  assert.equal(merged.showCacheMissNotices, true);
  assert.deepEqual(merged.notices, off);

  assert.deepEqual(loadNotices(fixture.settings), off);
});

test("fresh TLH-merged settings yield all four notices enabled in Pi", () => {
  const fixture = tempFixture(realDefaults, {});

  runMerge(fixture);

  assert.deepEqual(
    loadNotices(fixture.settings),
    Object.fromEntries(noticeKeys.map((key) => [key, true])),
  );
});
