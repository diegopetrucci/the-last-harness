import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { setupTicketsEnabledWrapperFixture } from "./install-stage1-wrapper-managed-bin-test-helpers.mjs";

test("wrapper includes managed_bin first in pi PATH across ticket settings", async (t) => {
  for (const [name, enabled] of [
    ["enabled", true],
    ["legacy disabled", false],
    ["missing settings", undefined],
    ["non-boolean", "false"],
  ]) {
    await t.test(name, (t) => {
      const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
      const settingsPath = join(agentDir, "settings.json");
      if (enabled === undefined) {
        assert.equal(existsSync(settingsPath), false);
      } else {
        writeFileSync(settingsPath, JSON.stringify({ tlh: { tickets: { enabled } } }, null, 2));
      }

      const result = runWrapper();
      assert.equal(result.status, 0, result.stderr);
      const piPathEntries = readPiPath();
      assert.equal(
        piPathEntries[0],
        agentBin,
        `expected managed bin first; got ${piPathEntries.join(":")}`,
      );
    });
  }
});
