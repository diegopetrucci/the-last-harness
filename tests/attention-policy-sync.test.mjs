import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readNumericLiteral(relativePath, pattern) {
  const source = readFileSync(join(repoRoot, relativePath), "utf8");
  const match = pattern.exec(source);
  assert.ok(match, `${relativePath}: ${pattern} not found`);
  return Number(match[1].replaceAll("_", ""));
}

// The installer must not import runtime extension modules, so compare the two
// owned copies of the needs-attention policy by source text instead.
test("installer needs-attention policy matches the subagent runtime default", () => {
  const installer = readNumericLiteral(
    "scripts/lib/tlh-install-subagents.mts",
    /const TLH_NEEDS_ATTENTION_AFTER_MS = ([\d_]+);/,
  );
  const runtime = readNumericLiteral(
    "extensions/subagents/src/runs/shared/subagent-control.ts",
    /needsAttentionAfterMs: ([\d_]+),/,
  );
  assert.equal(installer, runtime);
});
