import assert from "node:assert/strict";
import { test } from "node:test";

import { tempFixture, runMerge, readJson } from "./support/merge-settings-fixtures.mjs";

const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

test("merge adds cacheWarming: idle when the key is absent from isolated settings", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage] },
  );

  runMerge(fixture);

  assert.equal(readJson(fixture.settings).cacheWarming, "idle");
});

test("merge preserves cacheWarming: off without --force", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage], cacheWarming: "off" },
  );

  runMerge(fixture);

  assert.equal(
    readJson(fixture.settings).cacheWarming,
    "off",
    "user-set cacheWarming: off must survive without --force",
  );
});

test("merge preserves cacheWarming: streaming without --force", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage], cacheWarming: "streaming" },
  );

  runMerge(fixture);

  assert.equal(
    readJson(fixture.settings).cacheWarming,
    "streaming",
    "user-set cacheWarming: streaming must survive without --force",
  );
});
