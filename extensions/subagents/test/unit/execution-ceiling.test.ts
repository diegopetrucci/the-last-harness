import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACKAGED_MINOR_AGENT_ROLES } from "../../../shared/project-agent-guidance.ts";
import {
  CANONICAL_AGENT_MAX_EXECUTION_TIME_MS,
  DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS,
  canonicalAgentMaxExecutionTimeMs,
  resolveCustomAgentMaxExecutionTimeMs,
} from "../../src/agents/execution-ceiling.ts";

describe("role execution ceilings", () => {
  it("warns once for a retired shared setting without disclosing its value", () => {
    const script = `
      const warnings = [];
      console.warn = (message) => warnings.push(String(message));
      const { warnRetiredExecutionPolicy } = await import(${JSON.stringify(
        new URL("../../src/agents/execution-ceiling.ts", import.meta.url).href,
      )});
      warnRetiredExecutionPolicy({ maxRunTimeMs: false });
      process.stdout.write(JSON.stringify({ warnings }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.error, undefined);
    const output = JSON.parse(child.stdout) as { warnings: string[] };
    assert.equal(output.warnings.length, 1);
    assert.match(output.warnings[0] ?? "", /retired execution\.maxRunTimeMs/);
    assert.doesNotMatch(output.warnings[0] ?? "", /1234|false/);
  });

  it("keeps all canonical role ceilings and the independent custom fallback", () => {
    assert.equal(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS.developer, 3_600_000);
    assert.deepEqual(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, {
      developer: 3_600_000,
      "code-reviewer": 1_800_000,
      "test-runner": 3_600_000,
      librarian: 14_400_000,
      oracle: 2_700_000,
      contrarian: 1_800_000,
      "repo-scout": 600_000,
      "web-scout": 300_000,
      "diff-summarizer": 300_000,
    });
    assert.equal(DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS, 14_400_000);

    assert.equal(
      resolveCustomAgentMaxExecutionTimeMs(undefined),
      DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS,
    );
    assert.equal(resolveCustomAgentMaxExecutionTimeMs(99), 99);
    assert.deepEqual(
      [...PACKAGED_MINOR_AGENT_ROLES].sort(),
      Object.keys(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS).sort(),
    );
    assert.equal(canonicalAgentMaxExecutionTimeMs("toString"), undefined);
    assert.equal(canonicalAgentMaxExecutionTimeMs("constructor"), undefined);
  });
});
