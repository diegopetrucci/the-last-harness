import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AsyncJobState, NestedRunSummary, SubagentState } from "../../src/shared/types.ts";
import {
  buildNestedRouteIndex,
  createNestedRoute,
  hasLiveNestedDescendants,
  parseNestedEventRecords,
  projectNestedEvents,
  resolveNestedParentAddressFromEnv,
  resolveNestedRouteFromEnv,
  sanitizeSummary,
  updateAsyncJobNestedProjection,
  updateForegroundNestedProjection,
  nestedSummaryFromAsyncStatus,
  writeNestedEvent,
} from "../../src/runs/shared/nested-events.ts";
import {
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

const routes: Array<{ eventSink: string }> = [];
const savedEnv = {
  [SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
  [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
  [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
  [SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
  [SUBAGENT_PARENT_DEPTH_ENV]: process.env[SUBAGENT_PARENT_DEPTH_ENV],
  [SUBAGENT_PARENT_PATH_ENV]: process.env[SUBAGENT_PARENT_PATH_ENV],
  [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
};

afterEach(() => {
  for (const route of routes.splice(0)) {
    fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function trackRoute(rootRunId = "root-run") {
  const route = createNestedRoute(rootRunId);
  routes.push(route);
  return route;
}

function child(
  id: string,
  state: "queued" | "running" | "complete" | "failed" | "paused",
  ts: number,
  parentRunId = "root-run",
): NestedRunSummary {
  return {
    id,
    parentRunId,
    parentStepIndex: 1,
    depth: 1,
    path: [{ runId: parentRunId, stepIndex: 1 }],
    mode: "single" as const,
    state,
    agent: "reviewer",
    agents: ["reviewer"],
    startedAt: 10,
    lastUpdate: ts,
    steps: [
      { agent: "leaf", status: state === "running" ? ("running" as const) : ("complete" as const) },
    ],
  };
}

describe("nested route index", () => {
  it("indexes routes by root run id in a single directory scan", () => {
    const routeA = trackRoute("index-root-a");
    const routeB = trackRoute("index-root-b");

    const index = buildNestedRouteIndex();

    assert.equal(index.get("index-root-a")?.capabilityToken, routeA.capabilityToken);
    assert.equal(index.get("index-root-b")?.capabilityToken, routeB.capabilityToken);
    assert.equal(index.get("missing-root"), undefined);
  });

  it("keeps at most one route when a root run id has duplicate route dirs", () => {
    const first = trackRoute("dup-root");
    const second = trackRoute("dup-root");

    const index = buildNestedRouteIndex();

    // readdir order is not guaranteed, so the contract is deduplication: exactly
    // one route is indexed per root run id, not a specific winner.
    const indexed = index.get("dup-root");
    assert.ok(indexed, "expected one route for dup-root");
    const tokens = new Set([first.capabilityToken, second.capabilityToken]);
    assert.ok(
      tokens.has(indexed.capabilityToken),
      "indexed route must be one of the two created routes",
    );
  });
});

describe("nested event route validation", () => {
  it("resolves nested parent addresses with full inherited path", () => {
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "nested-parent";
    process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";
    process.env[SUBAGENT_PARENT_DEPTH_ENV] = "3";
    process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
      { runId: "root-run", stepIndex: 0, agent: "root-agent" },
      { runId: "../unsafe", stepIndex: 1, agent: "bad" },
      { runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
    ]);

    assert.deepEqual(resolveNestedParentAddressFromEnv(), {
      parentRunId: "nested-parent",
      parentStepIndex: 2,
      depth: 3,
      path: [
        { runId: "root-run", stepIndex: 0, agent: "root-agent" },
        { runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
      ],
    });
  });

  it("ignores unsafe nested parent ids from env", () => {
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "../unsafe";
    process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";

    assert.equal(resolveNestedParentAddressFromEnv(), undefined);
  });

  it("resolves only matching contained routes from env", () => {
    const route = trackRoute();
    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
    process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;

    assert.deepEqual(resolveNestedRouteFromEnv(), route);

    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "wrong-token";
    assert.throws(() => resolveNestedRouteFromEnv(), /capability token/);
  });
});

describe("nested event parsing and projection", () => {
  it("projects started, updated, and completed records into async and foreground parent state", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-a", "running", 100),
    });
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 200,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("nested-a", "running", 200), currentTool: "read" },
    });
    writeNestedEvent(route, {
      type: "subagent.nested.completed",
      ts: 300,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-a", "complete", 300),
    });

    const registry = projectNestedEvents(route);
    assert.equal(registry.children.length, 1);
    assert.equal(registry.children[0]?.id, "nested-a");
    assert.equal(registry.children[0]?.state, "complete");
    assert.equal(registry.children[0]?.steps?.[0]?.agent, "leaf");

    const job: AsyncJobState = {
      asyncId: "root-run",
      asyncDir: "/tmp/root-run",
      status: "running",
      nestedRoute: route,
      steps: [
        { agent: "owner-0", status: "running", index: 0 },
        { agent: "owner-1", status: "running", index: 1 },
      ],
    };
    updateAsyncJobNestedProjection(job);
    assert.equal(job.nestedChildren?.[0]?.id, "nested-a");
    assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-a");

    const control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never = {
      runId: "root-run",
      mode: "single",
      startedAt: 1,
      updatedAt: 1,
      nestedRoute: route,
    };
    updateForegroundNestedProjection(control);
    assert.equal(control.nestedChildren?.[0]?.id, "nested-a");
  });

  it("attaches root children to visible step slices by original step index", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 3,
      child: {
        ...child("nested-visible", "running", 100),
        parentStepIndex: 3,
        path: [{ runId: "root-run", stepIndex: 3 }],
      },
    });
    const job: AsyncJobState = {
      asyncId: "root-run",
      asyncDir: "/tmp/root-run",
      status: "running",
      nestedRoute: route,
      steps: [
        { agent: "owner-2", status: "running", index: 2 },
        { agent: "owner-3", status: "running", index: 3 },
      ],
    };

    updateAsyncJobNestedProjection(job);

    assert.equal(job.steps?.[0]?.children, undefined);
    assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-visible");
  });

  it("ignores corrupt, partial, wrong-token, duplicate, and stale records while preserving terminal state", () => {
    const route = trackRoute();
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000001-corrupt.json"),
      "{not json",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000002-partial.jsonl"),
      `${JSON.stringify({
        type: "subagent.nested.started",
        ts: 50,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("partial-good", "running", 50),
      })}\n{"type":"subagent.nested.started"`,
      "utf-8",
    );
    writeNestedEvent(route, {
      type: "subagent.nested.completed",
      ts: 300,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: child("nested-terminal", "complete", 300),
    });
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000400-stale.json"),
      `${JSON.stringify({
        type: "subagent.nested.updated",
        ts: 400,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("nested-terminal", "running", 100),
      })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000500-wrong-token.json"),
      `${JSON.stringify({
        type: "subagent.nested.started",
        ts: 500,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: "wrong",
        child: child("wrong-token", "running", 500),
      })}\n`,
      "utf-8",
    );

    const registry = projectNestedEvents(route);
    assert.equal(registry.children.find((item) => item.id === "partial-good")?.state, "running");
    assert.equal(
      registry.children.find((item) => item.id === "nested-terminal")?.state,
      "complete",
    );
    assert.equal(
      registry.children.some((item) => item.id === "wrong-token"),
      false,
    );
    assert.equal(hasLiveNestedDescendants(registry.children), true);
  });

  it("detects live descendants attached to terminal step children", () => {
    assert.equal(
      hasLiveNestedDescendants([
        {
          ...child("terminal-parent", "complete", 300),
          steps: [
            {
              agent: "owner-step",
              status: "complete",
              children: [
                {
                  ...child("running-step-child", "running", 310, "terminal-parent"),
                  parentStepIndex: 0,
                  path: [{ runId: "terminal-parent", stepIndex: 0 }],
                },
              ],
            },
          ],
        },
      ]),
      true,
    );
  });

  it("projects valid and invalid nested termination reasons at the event boundary", () => {
    const valid = sanitizeSummary({
      ...child("nested-terminal-reason", "complete", 100),
      steps: [{ agent: "leaf", status: "complete", terminationReason: "context_exhausted" }],
    });
    assert.equal(valid?.steps?.[0]?.terminationReason, "context_exhausted");
    const projected = nestedSummaryFromAsyncStatus(
      {
        runId: "nested-terminal-status",
        mode: "single",
        state: "complete",
        startedAt: 1,
        lastUpdate: 2,
        steps: [{ agent: "leaf", status: "complete", terminationReason: "output_limit" }],
      },
      "/tmp/nested-terminal-status",
      { id: "nested-terminal-status", parentRunId: "parent", depth: 1, ts: 2 },
    );
    assert.equal(projected.steps?.[0]?.terminationReason, "output_limit");
    const invalid = sanitizeSummary({
      ...child("nested-invalid-reason", "complete", 100),
      steps: [{ agent: "leaf", status: "complete", terminationReason: "future_reason" }],
    });
    assert.equal(invalid?.steps?.[0]?.terminationReason, undefined);
  });

  it("projects valid nested context diagnostics and omits invalid optional diagnostics", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: {
        ...child("nested-valid-pressure", "running", 100),
        steps: [
          {
            agent: "leaf",
            status: "running",
            contextUsage: { contextTokens: 800, contextWindow: 1000, contextPercent: 80 },
            contextPressure: {
              severity: "warning",
              crossedThreshold: "warning",
              contextTokens: 800,
              contextWindow: 1000,
              contextPercent: 80,
              remainingTokens: 200,
              warnedAt: 100,
            },
            contextPressureCrossedThresholds: ["warning"],
          },
        ],
      },
    });
    // Start from the same valid nested owner object used for normal event
    // fixtures, then corrupt its serialized fields through the runtime object
    // boundary. This keeps the rejection scenario explicit without pretending
    // malformed diagnostics satisfy their production interfaces.
    const invalidPressureChild = child("nested-invalid-pressure", "running", 200);
    const invalidPressureStep = invalidPressureChild.steps?.[0];
    assert.ok(invalidPressureStep, "valid owner fixture should contain one step");
    Reflect.set(invalidPressureStep, "contextUsage", { contextTokens: "bad" });
    Reflect.set(invalidPressureStep, "contextPressure", { severity: "warning" });
    Reflect.set(invalidPressureStep, "contextPressureCrossedThresholds", ["warning", "bogus"]);
    const invalidPressureEvent: Parameters<typeof writeNestedEvent>[1] = {
      type: "subagent.nested.updated",
      ts: 200,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: invalidPressureChild,
    };
    writeNestedEvent(route, invalidPressureEvent);
    const registry = projectNestedEvents(route);
    const valid = registry.children.find((item) => item.id === "nested-valid-pressure");
    assert.deepEqual(valid?.steps?.[0]?.contextUsage, {
      contextTokens: 800,
      contextWindow: 1000,
      contextPercent: 80,
    });
    assert.equal(valid?.steps?.[0]?.contextPressure?.severity, "warning");
    assert.deepEqual(valid?.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);
    const invalid = registry.children.find((item) => item.id === "nested-invalid-pressure");
    assert.equal(invalid?.steps?.[0]?.contextUsage, undefined);
    assert.equal(invalid?.steps?.[0]?.contextPressure, undefined);
    assert.equal(invalid?.steps?.[0]?.contextPressureCrossedThresholds, undefined);
  });

  it("accepts only complete numeric token usage at the nested event boundary", () => {
    const route = trackRoute();
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: {
        ...child("nested-valid-tokens", "running", 100),
        totalTokens: { input: 10, output: 15, total: 25 },
      },
    });
    fs.writeFileSync(
      path.join(route.eventSink, "0000000000200-invalid-tokens.json"),
      `${JSON.stringify({
        type: "subagent.nested.updated",
        ts: 200,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: {
          ...child("nested-invalid-tokens", "running", 200),
          totalTokens: { input: 1, output: "bad", total: 1 },
        },
      })}\n`,
      "utf-8",
    );

    const registry = projectNestedEvents(route);

    assert.deepEqual(
      registry.children.find((item) => item.id === "nested-valid-tokens")?.totalTokens,
      {
        input: 10,
        output: 15,
        total: 25,
      },
    );
    assert.equal(
      registry.children.find((item) => item.id === "nested-invalid-tokens")?.totalTokens,
      undefined,
    );
  });

  it("omits programmatic path fields (sessionFile, asyncDir) when over the 2048-char limit", () => {
    const route = trackRoute();
    const limit = 2048;
    const atLimit = "a".repeat(limit);
    const overLimit = "a".repeat(limit + 1);

    // Value exactly at limit passes through unchanged
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("path-limit", "running", 100), sessionFile: atLimit, asyncDir: atLimit },
    });
    // Value one char over the limit is omitted entirely (not truncated)
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 200,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("path-over", "running", 200), sessionFile: overLimit, asyncDir: overLimit },
    });

    const registry = projectNestedEvents(route);
    const atLimitChild = registry.children.find((c) => c.id === "path-limit");
    const overLimitChild = registry.children.find((c) => c.id === "path-over");

    assert.equal(
      atLimitChild?.sessionFile,
      atLimit,
      "sessionFile at limit must pass through unchanged",
    );
    assert.equal(atLimitChild?.asyncDir, atLimit, "asyncDir at limit must pass through unchanged");
    assert.equal(
      overLimitChild?.sessionFile,
      undefined,
      "sessionFile over limit must be omitted, not truncated",
    );
    assert.equal(
      overLimitChild?.asyncDir,
      undefined,
      "asyncDir over limit must be omitted, not truncated",
    );
  });

  it("marks display-only path field (currentPath) with an ellipsis when over the 2048-char limit", () => {
    const route = trackRoute();
    const limit = 2048;
    const atLimit = "b".repeat(limit);
    const overLimit = "b".repeat(limit + 1);

    // Value exactly at limit passes through unchanged
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 100,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("disp-limit", "running", 100), currentPath: atLimit },
    });
    // Value one char over the limit is truncated with a visible marker
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: 200,
      parentRunId: "root-run",
      parentStepIndex: 1,
      child: { ...child("disp-over", "running", 200), currentPath: overLimit },
    });

    const registry = projectNestedEvents(route);
    const atLimitChild = registry.children.find((c) => c.id === "disp-limit");
    const overLimitChild = registry.children.find((c) => c.id === "disp-over");

    assert.equal(
      atLimitChild?.currentPath,
      atLimit,
      "currentPath at limit must pass through unchanged",
    );
    assert.ok(
      overLimitChild?.currentPath?.endsWith("\u2026"),
      "currentPath over limit must end with a visible truncation marker",
    );
    assert.ok(
      overLimitChild?.currentPath !== undefined,
      "currentPath over limit must not be omitted entirely",
    );
  });

  // controlInbox cannot be exercised through the event-parsing route because
  // parseRecord overwrites any child-provided controlInbox with route.controlInbox.
  // Test it directly through sanitizeSummary, which applies displayStringValue
  // without the route-level override.
  it("marks display-only field controlInbox with an ellipsis when over the 2048-char limit (via sanitizeSummary)", () => {
    const limit = 2048;
    const base = { id: "ctrl-test", parentRunId: "root-run", state: "running", depth: 0, path: [] };

    const atLimit = sanitizeSummary({ ...base, controlInbox: "c".repeat(limit) });
    assert.equal(
      atLimit?.controlInbox,
      "c".repeat(limit),
      "controlInbox at limit must pass through unchanged",
    );

    const overLimit = sanitizeSummary({ ...base, controlInbox: "c".repeat(limit + 1) });
    assert.ok(
      overLimit?.controlInbox?.endsWith("\u2026"),
      "controlInbox over limit must end with a visible truncation marker",
    );
    assert.ok(
      overLimit?.controlInbox !== undefined,
      "controlInbox over limit must not be omitted entirely",
    );
  });

  it("displayStringValue does not emit a lone surrogate when the slice boundary falls between a surrogate pair", () => {
    // Emoji U+1F600 \uD83D\uDE00 is a UTF-16 surrogate pair (two code units).
    // Place it so the cut at (max - 1) falls on the high surrogate.
    // displayStringValue slices at max-1 = 2047 code units, backing up if the last
    // kept code unit is a high surrogate.
    const emoji = "\uD83D\uDE00"; // U+1F600
    // 2046 'a' chars + emoji + 'x' => length 2049, emoji straddles the cut at 2047.
    const value = "a".repeat(2046) + emoji + "x";
    const base = { id: "surr-test", parentRunId: "root-run", state: "running", depth: 0, path: [] };
    const result = sanitizeSummary({ ...base, currentPath: value });
    assert.ok(result?.currentPath !== undefined, "currentPath must be present");
    const cp = result!.currentPath!;
    assert.ok(cp.endsWith("\u2026"), "must end with a visible truncation marker");
    // Verify no lone surrogate in the result.
    for (let i = 0; i < cp.length; i++) {
      const cu = cp.charCodeAt(i);
      if (cu >= 0xd800 && cu <= 0xdbff) {
        const next = cp.charCodeAt(i + 1);
        assert.ok(
          next >= 0xdc00 && next <= 0xdfff,
          `lone high surrogate at index ${i}: 0x${cu.toString(16)} not followed by a low surrogate`,
        );
      }
    }
  });

  it("parses only complete jsonl records", () => {
    const route = trackRoute();
    const records = parseNestedEventRecords(
      `${JSON.stringify({
        type: "subagent.nested.started",
        ts: 100,
        rootRunId: route.rootRunId,
        parentRunId: "root-run",
        parentStepIndex: 1,
        capabilityToken: route.capabilityToken,
        child: child("jsonl-good", "running", 100),
      })}\n{"type":"subagent.nested.started"`,
      route,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.child.id, "jsonl-good");
  });
});
