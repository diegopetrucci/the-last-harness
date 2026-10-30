import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("glimpseui is the only package approved to run install scripts", () => {
  const approved = Object.entries(pkg.allowScripts ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([name]) => name);
  assert.deepEqual(approved, ["glimpseui"]);
});

test("glimpseui stays an exact version pin", () => {
  assert.match(pkg.dependencies.glimpseui, /^\d+\.\d+\.\d+$/);
});
