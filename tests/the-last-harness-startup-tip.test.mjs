import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TLH_STARTUP_TIPS, getTlhStartupTip, selectTlhStartupTip } = await jiti.import(
  "../extensions/the-last-harness/startup-tip.ts",
);

test("selectTlhStartupTip chooses from the curated TLH startup tip list", () => {
  assert.ok(TLH_STARTUP_TIPS.length > 0, "expected at least one curated TLH startup tip");
  assert.equal(
    selectTlhStartupTip(() => 0),
    TLH_STARTUP_TIPS[0],
  );
  assert.equal(
    selectTlhStartupTip(() => 0.999999),
    TLH_STARTUP_TIPS.at(-1),
  );
});

test("getTlhStartupTip returns one process-scoped selection from the curated list", () => {
  const startupTip = getTlhStartupTip();

  assert.ok(startupTip, "expected a TLH startup tip to be selected at module startup");
  assert.ok(
    TLH_STARTUP_TIPS.includes(startupTip),
    "expected the startup tip to come from the curated TLH list",
  );
  assert.equal(getTlhStartupTip(), startupTip);
});
