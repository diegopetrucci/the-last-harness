/**
 * Real Pi-session end-to-end test for the subagent extension.
 *
 * Spawns an actual child `pi` subprocess (a repo-local child CLI that runs a
 * real `AgentSession` backed by a faux provider) and exercises the extension's
 * detached-only execution path: the parent session calls the `subagent` tool,
 * the launch returns immediately, the detached runner spawns the child and
 * persists a terminal record that the result action can read. Headless (print)
 * sessions fail closed before launch. No real API keys are used.
 *
 * Pi runtime packages are required test dependencies; import failures fail the suite.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const CHILD_MARKER = "CHILD_REAL_SESSION_OK";
// Env vars the runner must clear so a parent that was itself spawned as a
// subagent child can still launch fresh children. The values are deliberately
// bogus sentinels (nonexistent paths) so a leaked value would break spawning.
const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(
  os.tmpdir(),
  "nonexistent-pi-coding-agent-package-root-e2e",
);
const ISOLATED_ENV_KEYS = [
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_MAX_DEPTH",
  "PI_SUBAGENT_EXTRA_AGENT_DIRS",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_PI_BINARY",
  "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

const win32Skip =
  process.platform === "win32"
    ? "fork argv1 pi-spawn hardening (TLH pi-spawn.ts delta) is incompatible with the upstream Windows harness; TLH targets macOS/Linux"
    : undefined;
describe("real Pi-session subagent E2E", { skip: win32Skip }, () => {
  let run: RealSessionRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  async function setupEnvAndRun(mode: "print" | "rpc") {
    const { routeParentThroughSubagent, runRealSubagentSession } =
      await import("../support/real-session-runner.ts");
    const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_DEPTH = "1";
    process.env.PI_SUBAGENT_MAX_DEPTH = "1";
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
    process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
    process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;
    try {
      run = await runRealSubagentSession({
        prompt: "Delegate to a helper and report its exact result.",
        childText: CHILD_MARKER,
        mode,
        setup({ home }) {
          const developerPath = path.join(home, "tlh", "agents", "subagents", "developer.md");
          fs.mkdirSync(path.dirname(developerPath), { recursive: true });
          fs.writeFileSync(
            developerPath,
            "---\nname: developer\ndescription: Canonical developer subagent\ntools: read\n---\n\nReturn the task result.\n",
            "utf-8",
          );
        },
        respond: routeParentThroughSubagent({
          childMarker: CHILD_MARKER,
          subagentArgs: {
            agent: "developer",
            task: "Return the marker from the faux child provider.",
            agentScope: "user",
          },
        }),
      });
      return run;
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("fails closed before launch in a headless (print) parent session", async () => {
    const { subagentToolResults } = await import("../support/real-session-runner.ts");
    const started = await setupEnvAndRun("print");
    const toolResults = subagentToolResults(started.parentSession);
    assert.equal(toolResults.length, 1);
    assert.match(toolResults[0]!, /unavailable in print\/json mode/);
    assert.doesNotMatch(toolResults[0]!, new RegExp(CHILD_MARKER));
  });

  it("launches detached in an rpc parent session and returns without waiting", async () => {
    const { subagentToolResults, subagentToolResultDetails } =
      await import("../support/real-session-runner.ts");
    const started = await setupEnvAndRun("rpc");
    const toolResults = subagentToolResults(started.parentSession);
    assert.equal(toolResults.length, 1);
    const details = subagentToolResultDetails(started.parentSession)[0] as {
      telemetry?: { run?: { execution?: string; mode?: string } };
      asyncDir?: unknown;
      awaited?: boolean;
    };
    assert.equal(details.telemetry?.run?.execution, "async");
    assert.equal(details.telemetry?.run?.mode, "single");
    assert.equal(typeof details.asyncDir, "string", "detached dispatch exposes its run directory");
    assert.notEqual(details.awaited, true);
    // The launch result carries no child-authored output; output is fetched with the result action.
    assert.doesNotMatch(toolResults[0]!, new RegExp(CHILD_MARKER));
    assert.ok(
      started.modelCalls >= 2,
      `expected parent tool-call and final turns, got ${started.modelCalls}`,
    );
  });
});
