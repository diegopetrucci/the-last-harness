import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV } from "../../src/runs/shared/pi-args.ts";
import type { SubagentRunConfig } from "../../src/runs/shared/parallel-utils.ts";
import { makeAgent, makeExtensionAPI } from "../support/helpers.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalGuidanceMarker = process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
const fixtures: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalGuidanceMarker === undefined) delete process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
  else process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = originalGuidanceMarker;
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("packaged minor-agent provenance", () => {
  it("serializes a strict provenance boolean on every async runner step", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-provenance-"));
    fixtures.push(root);
    const agentDir = path.join(root, "agent");
    const asyncDir = path.join(root, "async");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";

    const canonical = makeAgent("developer", {
      filePath: path.join(agentDir, "tlh", "agents", "subagents", "developer.md"),
    });
    const custom = makeAgent("code-reviewer", {
      filePath: path.join(root, "custom", "code-reviewer.md"),
    });
    const built = buildAsyncRunnerSteps("provenance", {
      chain: [
        { agent: "developer", task: "canonical" },
        { agent: "code-reviewer", task: "custom" },
      ],
      agents: [canonical, custom],
      ctx: { pi: makeExtensionAPI(), cwd: root, currentSessionId: "parent" },
      maxSubagentDepth: 2,
      asyncDir,
    });

    assert.equal("error" in built, false);
    if ("error" in built) return;
    assert.deepEqual(
      built.steps.flatMap((step) =>
        "parallel" in step
          ? step.parallel.map((task) => task.projectAgentGuidance)
          : [step.projectAgentGuidance],
      ),
      [true, false],
    );
    const persisted = JSON.parse(JSON.stringify(built.steps)) as unknown;
    assert.ok(Array.isArray(persisted));
    const persistedSteps = persisted as Array<{ projectAgentGuidance?: unknown }>;
    assert.equal(persistedSteps[0]?.projectAgentGuidance, true);
    assert.equal(persistedSteps[1]?.projectAgentGuidance, false);

    // The persisted runner config type remains assignable after JSON round-trip;
    // malformed values cannot opt in at the child-env boundary because launch
    // wiring uses exact === true.
    const config: Pick<SubagentRunConfig, "steps"> = { steps: built.steps };
    assert.equal(config.steps.length, 2);
  });
});
