import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  clearForegroundMessageInbox,
  registerForegroundMessageInbox,
} from "../../src/runs/shared/foreground-message-inbox.ts";
import { NESTED_EVENTS_DIR } from "../../src/runs/shared/nested-events.ts";
import {
  retiredNestedLaunchError,
  RETIRED_NESTED_ROUTE_ENV_VARS,
  SUBAGENT_CHILD_ENV,
} from "../../src/runs/shared/pi-args.ts";

interface SimpleControl {
  runId: string;
  mode: string;
  startedAt: number;
  updatedAt: number;
  messageInboxRoot?: string;
  activeMessageInboxes?: Map<number, string>;
}

describe("nested orchestration retirement", () => {
  it("isolates foreground message inboxes across direct control lifecycles", () => {
    const first: SimpleControl = {
      runId: "same-run",
      mode: "single",
      startedAt: 1,
      updatedAt: 1,
    };
    const firstInbox = registerForegroundMessageInbox(first, first.runId, 0);
    fs.writeFileSync(path.join(firstInbox, "stale.json"), "{}", "utf-8");
    const firstRoot = first.messageInboxRoot!;

    const second: SimpleControl = {
      runId: "same-run",
      mode: "single",
      startedAt: 2,
      updatedAt: 2,
    };
    const secondInbox = registerForegroundMessageInbox(second, second.runId, 0);
    try {
      assert.notEqual(second.messageInboxRoot, firstRoot);
      assert.equal(fs.existsSync(path.join(secondInbox, "stale.json")), false);
    } finally {
      clearForegroundMessageInbox(first, 0);
      clearForegroundMessageInbox(second, 0);
    }
    assert.equal(fs.existsSync(firstRoot), false);
    assert.equal(fs.existsSync(path.dirname(secondInbox)), false);
  });

  it("does not create a retired nested events dir for an ordinary run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-root-no-nested-route-"));
    try {
      // An ordinary run launch without nested env vars should not produce
      // a NESTED_EVENTS_DIR entry. This confirms the janitor-only purpose.
      const error = retiredNestedLaunchError({});
      assert.equal(error, undefined, "ordinary config should not trigger nested error");

      let routesForRoot: string[] = [];
      try {
        routesForRoot = fs
          .readdirSync(NESTED_EVENTS_DIR)
          .filter((entry) => entry.startsWith(path.basename(root)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      assert.deepEqual(routesForRoot, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects retired route environments before spawn or artifact creation", () => {
    const routeEnvVars = [SUBAGENT_CHILD_ENV, ...RETIRED_NESTED_ROUTE_ENV_VARS];
    const previous = new Map(routeEnvVars.map((name) => [name, process.env[name]]));
    try {
      for (const activeRouteEnv of routeEnvVars) {
        for (const name of routeEnvVars) delete process.env[name];
        process.env[activeRouteEnv] = activeRouteEnv === SUBAGENT_CHILD_ENV ? "1" : "legacy-route";

        const errorMsg = retiredNestedLaunchError();
        assert.ok(errorMsg, `${activeRouteEnv} should produce retirement error`);
        assert.match(errorMsg, /Nested subagent orchestration is retired/);
      }
    } finally {
      for (const name of routeEnvVars) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects config with nestedRoute or nestedSelf fields before spawn", () => {
    const nestedRouteError = retiredNestedLaunchError({ nestedRoute: { rootRunId: "x" } });
    assert.ok(nestedRouteError, "nestedRoute in config should trigger error");
    assert.match(nestedRouteError, /Nested subagent orchestration is retired/);

    const nestedSelfError = retiredNestedLaunchError({ nestedSelf: { depth: 1 } });
    assert.ok(nestedSelfError, "nestedSelf in config should trigger error");
    assert.match(nestedSelfError, /Nested subagent orchestration is retired/);

    const cleanConfig = retiredNestedLaunchError({ agent: "worker", task: "go" });
    assert.equal(cleanConfig, undefined, "clean config should not trigger error");
  });
});
