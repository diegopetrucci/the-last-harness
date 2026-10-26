import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(repoRoot, ".github/workflows/macos-ci-benchmark.yml");
const workflow = readFileSync(workflowPath, "utf8");

function multilineRunBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^        run: \|$/u.test(lines[index])) continue;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      if (/^        \S/u.test(lines[index])) {
        index -= 1;
        break;
      }
      block.push(lines[index]);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

test("macOS benchmark workflow is manual-only and preserves the default CI workflow", () => {
  assert.match(workflow, /^name: macOS CI benchmark$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/mu);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /concurrency:\n  group: macos-ci-benchmark\n  cancel-in-progress: false/u);
  assert.match(workflow, /runs-on: macos-latest/u);
  assert.match(workflow, /timeout-minutes: 30/u);
  assert.match(workflow, /node-version: '24\.22\.1'/u);
  assert.match(workflow, /cache: 'npm'/u);
  assert.match(workflow, /uses: actions\/cache@v6/u);
  assert.match(workflow, /path: node_modules/u);
  assert.match(workflow, /key: node-modules-\$\{\{ runner\.os \}\}/u);
});

test("macOS benchmark dispatch exposes only the controlled layout and concurrency inputs", () => {
  assert.match(
    workflow,
    /lane_layout:\n\s+description:[\s\S]*?\n\s+default: baseline\n\s+type: choice\n\s+options:\n\s+- baseline\n\s+- experimental/u,
  );
  assert.match(
    workflow,
    /concurrency:\n\s+description:[\s\S]*?\n\s+default: default\n\s+type: string/u,
  );
  assert.match(workflow, /TLH_CI_LANE_LAYOUT: \$\{\{ inputs\.lane_layout \}\}/u);
  assert.match(workflow, /BENCHMARK_CONCURRENCY_INPUT: \$\{\{ inputs\.concurrency \}\}/u);
  assert.match(workflow, /unset TLH_TEST_CONCURRENCY/u);
  assert.match(workflow, /export TLH_TEST_CONCURRENCY=/u);

  for (const block of multilineRunBlocks(workflow)) {
    assert.doesNotMatch(
      block,
      /\$\{\{\s*inputs\./u,
      "workflow inputs must enter shell steps through environment variables",
    );
  }
});

test("macOS benchmark matrix runs each shard once and uploads failure-labelled evidence", () => {
  assert.match(workflow, /matrix:\n\s+shard:\n\s+- 1\n\s+- 2/u);
  assert.equal((workflow.match(/scripts\/run-ci-test-shard\.mjs/gu) ?? []).length, 1);
  assert.match(workflow, /"\$\{BENCHMARK_SHARD\}\/2"/u);
  assert.match(workflow, /--lane-layout "\$\{TLH_CI_LANE_LAYOUT\}"/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/u);
  assert.match(workflow, /comparisonEligible: complete/u);
  assert.match(workflow, /INCOMPLETE-BENCHMARK\.txt/u);
  assert.match(workflow, /failureLabel: complete \? null/u);
  assert.match(workflow, /executionTimingExcludesRunnerSetup: true/u);
});
