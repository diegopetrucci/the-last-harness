import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSlashSubagentBridge } from "../../src/slash/slash-bridge.ts";

const REQUEST = "subagent:slash:request";
const CANCEL = "subagent:slash:cancel";
const RESPONSE = "subagent:slash:response";

function eventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () =>
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
    },
    emit(event: string, data: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

function nextResponse(events: ReturnType<typeof eventBus>, requestId: string): Promise<any> {
  return new Promise((resolve) => {
    const unsubscribe = events.on(RESPONSE, (data: any) => {
      if (data?.requestId !== requestId) return;
      unsubscribe();
      resolve(data);
    });
  });
}

describe("slash subagent bridge request boundary", () => {
  it("executes only the exact retained diagnostic request shapes", async () => {
    const events = eventBus();
    const executed: unknown[] = [];
    const fallbackCtx = { cwd: "/fallback" } as any;
    const callerParams = [{ action: "doctor" }, { action: "status", view: "fleet" }];

    registerSlashSubagentBridge({
      events,
      getContext: () => fallbackCtx,
      execute: async (_id, params) => {
        executed.push(params);
        return {
          content: [{ type: "text", text: "ok" }],
          details: { mode: "single", results: [] },
        } as any;
      },
    });

    for (const [index, params] of callerParams.entries()) {
      const requestId = `allowed-${index}`;
      const response = nextResponse(events, requestId);
      events.emit(REQUEST, { requestId, params });
      assert.equal((await response).isError, false);
      assert.notStrictEqual(executed[index], params);
    }

    assert.deepEqual(executed, [{ action: "doctor" }, { action: "status", view: "fleet" }]);
  });

  it("rejects unsupported, execution-bearing, extra-field, and malformed params", async () => {
    const events = eventBus();
    let executeCalls = 0;

    registerSlashSubagentBridge({
      events,
      getContext: () => ({ cwd: "/fallback" }) as any,
      execute: async () => {
        executeCalls++;
        return {
          content: [{ type: "text", text: "unexpected" }],
          details: { mode: "single", results: [] },
        } as any;
      },
    });

    const accessorParams = {};
    Object.defineProperty(accessorParams, "action", {
      enumerable: true,
      get: () => "doctor",
    });
    const symbolParams = { action: "doctor" };
    Object.defineProperty(symbolParams, Symbol("extra"), { enumerable: true, value: true });
    const proxyParams = new Proxy(
      { action: "doctor" },
      {
        ownKeys: () => {
          throw new Error("hostile proxy");
        },
      },
    );
    const rejected: unknown[] = [
      undefined,
      null,
      [],
      {},
      { action: "list" },
      { agent: "worker", task: "run" },
      { action: "doctor", agent: "worker" },
      { action: "status" },
      { action: "status", view: "fleet", id: "run-1" },
      accessorParams,
      symbolParams,
      proxyParams,
    ];

    for (const [index, params] of rejected.entries()) {
      const requestId = `rejected-${index}`;
      const response = nextResponse(events, requestId);
      events.emit(REQUEST, { requestId, params });
      const result = await response;
      assert.equal(result.isError, true);
      assert.equal(result.errorText, "Unsupported slash subagent request.");
      assert.deepEqual(result.result.content, [
        { type: "text", text: "Unsupported slash subagent request." },
      ]);
      assert.deepEqual(result.result.details, { mode: "single", results: [] });
    }

    const missingParamsResponse = nextResponse(events, "missing-params");
    events.emit(REQUEST, { requestId: "missing-params" });
    assert.equal((await missingParamsResponse).isError, true);

    const malformedEnvelope = Object.assign([], {
      requestId: "array-envelope",
      params: { action: "doctor" },
    });
    const malformedEnvelopeResponse = nextResponse(events, malformedEnvelope.requestId);
    events.emit(REQUEST, malformedEnvelope);
    assert.equal((await malformedEnvelopeResponse).isError, true);

    const throwingContextRequest = { requestId: "throwing-context", params: { action: "doctor" } };
    Object.defineProperty(throwingContextRequest, "ctx", {
      enumerable: true,
      get: () => {
        throw new Error("hostile context getter");
      },
    });
    const throwingContextResponse = nextResponse(events, throwingContextRequest.requestId);
    events.emit(REQUEST, throwingContextRequest);
    assert.equal((await throwingContextResponse).isError, true);
    assert.equal(executeCalls, 0);
  });

  it("clears pending cancellation after rejected and no-context requests", async () => {
    const events = eventBus();
    const fallbackContext = { cwd: "/fallback" } as any;
    let activeContext: any = fallbackContext;
    let executeCalls = 0;

    registerSlashSubagentBridge({
      events,
      getContext: () => activeContext,
      execute: async () => {
        executeCalls++;
        return {
          content: [{ type: "text", text: "ok" }],
          details: { mode: "single", results: [] },
        } as any;
      },
    });

    const rejectedId = "rejected-then-valid";
    events.emit(CANCEL, { requestId: rejectedId });
    const rejectedResponse = nextResponse(events, rejectedId);
    events.emit(REQUEST, { requestId: rejectedId, params: { action: "list" } });
    assert.equal((await rejectedResponse).isError, true);

    const validAfterRejectedResponse = nextResponse(events, rejectedId);
    events.emit(REQUEST, { requestId: rejectedId, params: { action: "doctor" } });
    assert.equal((await validAfterRejectedResponse).isError, false);
    assert.equal(executeCalls, 1);

    const noContextId = "no-context-then-valid";
    activeContext = null;
    events.emit(CANCEL, { requestId: noContextId });
    const noContextResponse = nextResponse(events, noContextId);
    events.emit(REQUEST, { requestId: noContextId, params: { action: "doctor" } });
    assert.equal((await noContextResponse).isError, true);

    activeContext = fallbackContext;
    const validAfterNoContextResponse = nextResponse(events, noContextId);
    events.emit(REQUEST, { requestId: noContextId, params: { action: "doctor" } });
    assert.equal((await validAfterNoContextResponse).isError, false);
    assert.equal(executeCalls, 2);
  });

  it("uses request ctx instead of stale fallback context when provided", async () => {
    const events = eventBus();
    const fallbackCtx = { cwd: "/fallback" } as any;
    const requestCtx = { cwd: "/request" } as any;
    let executedCtx: any;

    registerSlashSubagentBridge({
      events,
      getContext: () => fallbackCtx,
      execute: async (_id, _params, _signal, _onUpdate, ctx) => {
        executedCtx = ctx;
        return {
          content: [{ type: "text", text: "ok" }],
          details: { mode: "single", results: [] },
        } as any;
      },
    });

    const done = new Promise<void>((resolve, reject) => {
      events.on(RESPONSE, (data: any) => {
        try {
          assert.equal(data.isError, false);
          assert.equal(executedCtx, requestCtx);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    events.emit(REQUEST, { requestId: "ctx-test", params: { action: "doctor" }, ctx: requestCtx });
    await done;
  });
});
