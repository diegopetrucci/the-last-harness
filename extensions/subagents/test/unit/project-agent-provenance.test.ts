import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import { SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV } from "../../src/runs/shared/pi-args.ts";
import type { SubagentRunConfig } from "../../src/runs/shared/parallel-utils.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
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
  it("serializes a strict provenance boolean on every async runner task", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-provenance-"));
    fixtures.push(root);
    const agentDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";

    const canonical = makeAgent("developer", {
      filePath: path.join(agentDir, "tlh", "agents", "subagents", "developer.md"),
    });
    const custom = makeAgent("code-reviewer", {
      filePath: path.join(root, "custom", "code-reviewer.md"),
    });
    const built = buildAsyncRunnerPlan("provenance", {
      tasks: [
        { agent: "developer", task: "canonical" },
        { agent: "code-reviewer", task: "custom" },
      ],
      agents: [canonical, custom],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx: { pi: makeExtensionAPI(), cwd: root, currentSessionId: "parent" },
      maxSubagentDepth: 2,
    });

    assert.equal("error" in built, false);
    if ("error" in built) return;
    assert.deepEqual(
      built.plan.tasks.map((task) => task.projectAgentGuidance),
      [true, false],
    );
    const persisted = JSON.parse(JSON.stringify(built.plan)) as unknown;
    assert.ok(persisted && typeof persisted === "object");
    const persistedPlan = persisted as { tasks: Array<{ projectAgentGuidance?: unknown }> };
    assert.equal(persistedPlan.tasks[0]?.projectAgentGuidance, true);
    assert.equal(persistedPlan.tasks[1]?.projectAgentGuidance, false);

    // The persisted direct plan remains assignable after JSON round-trip;
    // malformed values cannot opt in at the child-env boundary because launch
    // wiring uses exact === true.
    const config: Required<Pick<SubagentRunConfig, "plan">> = { plan: built.plan };
    assert.equal(config.plan.kind, "parallel");
    assert.equal(config.plan.tasks.length, 2);
  });
});
