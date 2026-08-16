import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";

import { createSubagentToolResultBridge } from "../extensions/subagents/src/extension/index.js";
import { buildPiArgs } from "../extensions/subagents/src/runs/shared/pi-args.js";

const repoRoot = join(import.meta.dirname, "..");

function extensionArgs(args) {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--extension") paths.push(args[index + 1]);
  }
  return paths;
}

test("generated child Pi arguments select generated JavaScript runtime extensions", () => {
  const result = buildPiArgs({
    baseArgs: [],
    task: "child path smoke",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
    tools: ["subagent"],
  });
  const paths = extensionArgs(result.args);

  assert.equal(paths.length, 1);
  assert.equal(
    paths.some((path) => path.endsWith("subagent-prompt-runtime.js")),
    true,
  );
  assert.equal(
    paths.every((path) => !path.endsWith("fanout-child.js")),
    true,
  );
  assert.equal(
    paths.every((path) => extname(path) === ".js"),
    true,
  );
});

test("Pi 0.83 tool-result bridge preserves rich failures and patches the matching execution", () => {
  const bridge = createSubagentToolResultBridge();
  const content = [{ type: "text", text: "Unknown agent with useful detail" }];
  const details = { mode: "single", results: [], diagnostic: { agent: "missing" } };
  const normalized = bridge.normalize("failure-call", "subagent", {
    content,
    details,
    isError: true,
  });

  assert.equal(Object.hasOwn(normalized, "isError"), false);
  assert.equal(normalized.content, content);
  assert.equal(normalized.details, details);
  assert.deepEqual(bridge.errorPatch("failure-call", "subagent", details), { isError: true });
  assert.equal(bridge.errorPatch("failure-call", "subagent", details), undefined);
});

test("Pi 0.83 compatibility declaration shim is absent", () => {
  assert.equal(
    existsSync(join(repoRoot, "extensions/subagents/src/types/typecheck-compat.d.ts")),
    false,
  );
});
