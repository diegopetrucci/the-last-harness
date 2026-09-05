import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACKAGED_MINOR_AGENT_ROLES } from "../../../shared/project-agent-guidance.ts";
import {
  CANONICAL_AGENT_MAX_EXECUTION_TIME_MS,
  DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS,
  DEFAULT_SUBAGENT_MAX_RUN_TIME_MS,
  canonicalAgentMaxExecutionTimeMs,
  resolveCustomAgentMaxExecutionTimeMs,
  resolveExecutionPolicy,
} from "../../src/agents/execution-ceiling.ts";

describe("human-owned execution policy", () => {
  it("uses the bounded default and accepts an explicit false", () => {
    assert.deepEqual(resolveExecutionPolicy(undefined), {
      maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS,
    });
    assert.deepEqual(resolveExecutionPolicy({ maxRunTimeMs: false }), { maxRunTimeMs: false });
    assert.deepEqual(
      resolveExecutionPolicy({ maxRunTimeMs: 1_000, execution: { maxRunTimeMs: 12_345 } }),
      { maxRunTimeMs: 1_000 },
    );
  });

  it("falls back safely with one bounded actionable warning for invalid values", () => {
    // Run this assertion in a fresh process so the once-per-process warning
    // contract is deterministic regardless of test-file loading order.
    const script = `
      const warnings = [];
      console.warn = (message) => warnings.push(String(message));
      const { resolveExecutionPolicy } = await import(${JSON.stringify(
        new URL("../../src/agents/execution-ceiling.ts", import.meta.url).href,
      )});
      const first = resolveExecutionPolicy({ maxRunTimeMs: 0 });
      const second = resolveExecutionPolicy({ maxRunTimeMs: Number.MAX_SAFE_INTEGER + 1 });
      process.stdout.write(JSON.stringify({ first, second, warnings }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.error, undefined);
    const output = JSON.parse(child.stdout) as {
      first: ReturnType<typeof resolveExecutionPolicy>;
      second: ReturnType<typeof resolveExecutionPolicy>;
      warnings: string[];
    };

    assert.equal(output.first.maxRunTimeMs, DEFAULT_SUBAGENT_MAX_RUN_TIME_MS);
    assert.equal(output.second.maxRunTimeMs, DEFAULT_SUBAGENT_MAX_RUN_TIME_MS);
    assert.equal(output.first.diagnostic, output.warnings[0]);
    assert.equal(output.warnings.length, 1);
    assert.ok(output.warnings[0]?.includes("execution.maxRunTimeMs"));
    assert.ok(output.warnings[0]?.includes("positive safe integer or false"));
    assert.ok(output.warnings[0]!.length < 300);
  });

  it("consumes only own maxRunTimeMs and keeps custom fallback centralized", () => {
    const inherited = Object.create({ maxRunTimeMs: 1 });
    assert.equal(resolveExecutionPolicy(inherited).maxRunTimeMs, DEFAULT_SUBAGENT_MAX_RUN_TIME_MS);
    assert.equal(
      resolveCustomAgentMaxExecutionTimeMs(undefined),
      DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS,
    );
    assert.equal(resolveCustomAgentMaxExecutionTimeMs(99), 99);
    assert.deepEqual(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, {
      developer: 7_200_000,
      "code-reviewer": 1_800_000,
      "test-runner": 3_600_000,
      librarian: 14_400_000,
      oracle: 2_700_000,
      contrarian: 1_800_000,
      "repo-scout": 600_000,
      "web-scout": 300_000,
      "diff-summarizer": 300_000,
    });
    assert.deepEqual(
      [...PACKAGED_MINOR_AGENT_ROLES].sort(),
      Object.keys(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS).sort(),
    );
    assert.equal(canonicalAgentMaxExecutionTimeMs("toString"), undefined);
    assert.equal(canonicalAgentMaxExecutionTimeMs("constructor"), undefined);
  });
});
