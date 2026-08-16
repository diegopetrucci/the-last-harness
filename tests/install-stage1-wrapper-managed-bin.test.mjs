import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { setupTicketsEnabledWrapperFixture } from "./install-stage1-wrapper-managed-bin-test-helpers.mjs";

test("wrapper includes managed_bin in pi PATH when tlh.tickets.enabled is true", (t) => {
  const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ tlh: { tickets: { enabled: true } } }, null, 2),
  );

  const result = runWrapper();
  assert.equal(result.status, 0, result.stderr);
  const piPathEntries = readPiPath();
  assert.equal(
    piPathEntries[0],
    agentBin,
    `expected managed bin first; got ${piPathEntries.join(":")}`,
  );
});

test("wrapper includes managed_bin in pi PATH when legacy tlh.tickets.enabled is false", (t) => {
  const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ tlh: { tickets: { enabled: false } } }, null, 2),
  );

  const result = runWrapper();
  assert.equal(result.status, 0, result.stderr);
  const piPathEntries = readPiPath();
  assert.equal(
    piPathEntries[0],
    agentBin,
    `expected managed bin first; got ${piPathEntries.join(":")}`,
  );
});

test("wrapper defaults to managed_bin in pi PATH when settings.json is missing", (t) => {
  const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
  assert.equal(existsSync(join(agentDir, "settings.json")), false);

  const result = runWrapper();
  assert.equal(result.status, 0, result.stderr);
  const piPathEntries = readPiPath();
  assert.equal(
    piPathEntries[0],
    agentBin,
    `expected managed bin first; got ${piPathEntries.join(":")}`,
  );
});

test("wrapper defaults to managed_bin in pi PATH when tlh.tickets.enabled is not a boolean", (t) => {
  const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ tlh: { tickets: { enabled: "false" } } }, null, 2),
  );

  const result = runWrapper();
  assert.equal(result.status, 0, result.stderr);
  const piPathEntries = readPiPath();
  assert.equal(
    piPathEntries[0],
    agentBin,
    `expected managed bin first; got ${piPathEntries.join(":")}`,
  );
});
