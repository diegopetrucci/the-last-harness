import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "protocol", "local-bridge", "v0", "manifest.json"), "utf8"),
);
const maxSourceEpoch = manifest.bounds.maxSourceEpoch;
assert.equal(typeof maxSourceEpoch, "number");

const jiti = createJiti(import.meta.url);
const { frame, parseResult, validIdentity } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/local-bridge-boundary.ts",
);

function resultBody({ bridgeRevision = 0, sourceEpoch = 1 } = {}) {
  const number = (value) => (Object.is(value, -0) ? "-0" : String(value));
  return new TextEncoder().encode(
    `{"kind":"result","code":"accepted","bridgeRevision":${number(bridgeRevision)},"sourceEpoch":${number(sourceEpoch)}}`,
  );
}

function lengthPrefixedBody(body) {
  const encoded = frame(body);
  assert.ok(encoded);
  return encoded.subarray(4);
}

test("identity boundary counts Unicode code points and rejects ill-formed UTF-16", () => {
  const exact = "😀".repeat(128);
  assert.equal(validIdentity(exact), exact);
  assert.equal(validIdentity("😀".repeat(129)), undefined);
  assert.equal(validIdentity("\ud800"), undefined);
  assert.equal(validIdentity("\udc00"), undefined);
});

test("production result boundary enforces canonical epoch and revision limits", () => {
  const transports = [
    ["direct", (body) => body],
    ["length-prefixed", lengthPrefixedBody],
  ];
  const cases = [
    ["zero revision and first epoch", { bridgeRevision: 0, sourceEpoch: 1 }, "accepted"],
    ["maximum epoch", { bridgeRevision: 0, sourceEpoch: maxSourceEpoch }, "accepted"],
    ["zero epoch", { bridgeRevision: 0, sourceEpoch: 0 }, undefined],
    ["negative zero epoch", { bridgeRevision: 0, sourceEpoch: -0 }, undefined],
    ["negative zero revision", { bridgeRevision: -0, sourceEpoch: 1 }, undefined],
  ];

  for (const [transportName, transport] of transports) {
    for (const [caseName, values, expected] of cases) {
      assert.equal(
        parseResult(transport(resultBody(values))),
        expected,
        `${transportName}: ${caseName}`,
      );
    }
  }
});
