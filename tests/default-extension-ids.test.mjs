import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  ANTHROPIC_AUTH_EXTENSION_ID,
  MCPORTER_EXTENSION_ID,
} from "../scripts/lib/default-extensions.mjs";

const manifest = JSON.parse(
  readFileSync(
    join(resolve(import.meta.dirname, ".."), "config", "default-extensions.json"),
    "utf8",
  ),
);
const manifestIds = new Set((manifest.extensions ?? manifest).map((entry) => entry.id));

test("named default-extension ID constants exist in config/default-extensions.json", () => {
  for (const id of [MCPORTER_EXTENSION_ID, ANTHROPIC_AUTH_EXTENSION_ID]) {
    assert.ok(manifestIds.has(id), `${id} missing from config/default-extensions.json`);
  }
});
