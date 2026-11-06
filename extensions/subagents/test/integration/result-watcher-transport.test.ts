import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makeSubagentState } from "../support/helpers.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";

type Handler = (error: Error) => void;

function setup(options: { watch?: (call: number) => fs.FSWatcher } = {}) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-transport-"));
  const state = makeSubagentState({ baseCwd: "/repo" });
  const log = { timeouts: [] as Array<() => void>, intervals: [] as Array<() => void> };
  const cleared = { timeouts: 0, intervals: 0 };
  const watchers: Array<{ handler?: Handler; closed: boolean; fake: fs.FSWatcher }> = [];
  let watchCalls = 0;
  const makeWatcher = () => {
    const record: { handler?: Handler; closed: boolean; fake: fs.FSWatcher } = {
      closed: false,
      fake: undefined as never,
    };
    const fake = {
      on(event: string, handler: Handler) {
        if (event === "error") record.handler = handler;
        return fake;
      },
      close() {
        record.closed = true;
      },
      unref() {},
    } as fs.FSWatcher;
    record.fake = fake;
    watchers.push(record);
    return fake;
  };
  const watcher = createResultWatcher(
    { events: { on: () => () => {}, emit() {} } },
    state,
    resultsDir,
    {
      fs: {
        ...fs,
        watch: (() => {
          watchCalls++;
          return options.watch ? options.watch(watchCalls) : makeWatcher();
        }) as typeof fs.watch,
      },
      timers: {
        setTimeout: ((handler: () => void) => {
          log.timeouts.push(handler);
          return { unref() {} } as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimeout: (() => {
          cleared.timeouts++;
        }) as typeof clearTimeout,
        setInterval: ((handler: () => void) => {
          log.intervals.push(handler);
          return { unref() {} } as NodeJS.Timeout;
        }) as typeof setInterval,
        clearInterval: (() => {
          cleared.intervals++;
        }) as typeof clearInterval,
      },
    },
  );
  const originalError = console.error;
  console.error = () => {};
  const cleanup = () => {
    console.error = originalError;
    watcher.stopResultWatcher();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  };
  return { state, watcher, log, cleared, watchers, cleanup, calls: () => watchCalls };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("result watcher transport transitions", () => {
  it("native-watch -> restart-wait -> native-watch", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      t.watchers[0]!.handler?.(new Error("transient"));
      assert.equal(t.state.watcher, null);
      assert.equal(t.watchers[0]!.closed, true);
      assert.equal(t.log.timeouts.length, 1);
      t.log.timeouts[0]!();
      assert.equal(t.calls(), 2);
      assert.equal(t.state.watcher, t.watchers[1]!.fake);
    } finally {
      t.cleanup();
    }
  });

  it("native-watch -> polling on ENOSPC, and stop clears the interval", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      t.watchers[0]!.handler?.(errno("ENOSPC"));
      assert.equal(t.state.watcher, null);
      assert.equal(t.log.intervals.length, 1);
      assert.equal(t.log.timeouts.length, 0);
      t.watcher.stopResultWatcher();
      assert.equal(t.cleared.intervals, 1);
      assert.equal(t.cleared.timeouts, 0);
    } finally {
      t.cleanup();
    }
  });

  it("restart-wait -> polling when the restart fails with EMFILE", () => {
    const t = setup({
      watch: (call) => {
        throw errno(call === 1 ? "EACCES" : "EMFILE");
      },
    });
    try {
      // Non-fallback start failure -> restart-wait; restart then hits EMFILE.
      t.watcher.startResultWatcher();
      assert.equal(t.log.timeouts.length, 1);
      t.log.timeouts[0]!();
      assert.equal(t.log.intervals.length, 1);
      assert.equal(t.state.watcher, null);
    } finally {
      t.cleanup();
    }
  });

  it("stopped from restart-wait clears the timeout; stopped -> native restarts", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      t.watchers[0]!.handler?.(new Error("transient"));
      t.watcher.stopResultWatcher();
      assert.equal(t.cleared.timeouts >= 1, true);
      assert.equal(t.cleared.intervals, 0);
      t.watcher.startResultWatcher();
      assert.equal(t.calls(), 2);
      assert.equal(t.state.watcher, t.watchers[1]!.fake);
    } finally {
      t.cleanup();
    }
  });

  it("ignores a stale native watcher error during a restart wait (EMFILE cannot block the restart)", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      const first = t.watchers[0]!;
      first.handler?.(new Error("transient"));
      assert.equal(t.log.timeouts.length, 1);
      first.handler?.(errno("EMFILE"));
      assert.equal(t.log.intervals.length, 0);
      t.log.timeouts[0]!();
      assert.equal(t.state.watcher, t.watchers[1]!.fake);
    } finally {
      t.cleanup();
    }
  });

  it("keeps a replacement native watcher open when the old watcher emits a late error", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      const first = t.watchers[0]!;
      first.handler?.(new Error("transient"));
      t.log.timeouts[0]!();
      const second = t.watchers[1]!;
      assert.equal(t.state.watcher, second.fake);

      first.handler?.(new Error("late transient"));
      first.handler?.(errno("ENOSPC"));

      assert.equal(second.closed, false);
      assert.equal(t.state.watcher, second.fake);
      assert.equal(t.log.timeouts.length, 1);
      assert.equal(t.log.intervals.length, 0);
    } finally {
      t.cleanup();
    }
  });

  it("polling -> native-watch when the watcher is restarted", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      t.watchers[0]!.handler?.(errno("ENOSPC"));
      assert.equal(t.log.intervals.length, 1);
      assert.equal(t.state.watcher, null);

      t.watcher.startResultWatcher();

      assert.equal(t.cleared.intervals, 1);
      assert.equal(t.calls(), 2);
      assert.equal(t.state.watcher, t.watchers[1]!.fake);
    } finally {
      t.cleanup();
    }
  });

  it("ignores an obsolete restart callback while a different restart timer is pending", () => {
    const t = setup();
    try {
      t.watcher.startResultWatcher();
      t.watchers[0]!.handler?.(new Error("transient"));
      const obsolete = t.log.timeouts[0]!;
      // Cancel that restart wait (the injected clearTimeout is a no-op, so the
      // callback stays invocable), then enter a fresh one.
      t.watcher.stopResultWatcher();
      t.watcher.startResultWatcher();
      t.watchers[1]!.handler?.(new Error("transient again"));
      assert.equal(t.log.timeouts.length, 2);
      assert.equal(t.calls(), 2);

      obsolete();

      assert.equal(t.calls(), 2);
      assert.equal(t.state.watcher, null);
      // The current restart-wait is still intact and works.
      t.log.timeouts[1]!();
      assert.equal(t.calls(), 3);
      assert.equal(t.state.watcher, t.watchers[2]!.fake);
    } finally {
      t.cleanup();
    }
  });
});
