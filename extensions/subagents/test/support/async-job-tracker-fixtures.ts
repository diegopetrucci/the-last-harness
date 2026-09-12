import assert from "node:assert/strict";
import * as fs from "node:fs";
import { scaleTestTimeout } from "./scale-timeout.ts";
import { tryImport } from "./helpers.ts";
import type { AsyncStatusQuarantineOptions } from "../../src/runs/background/async-status-quarantine.ts";

export interface AsyncJobTrackerModule {
  createAsyncJobTracker(
    pi: { events: { emit(channel: string, data: unknown): void } },
    state: Record<string, unknown>,
    asyncDirRoot: string,
    options?: {
      completionRetentionMs?: number;
      pollIntervalMs?: number;
      resultsDir?: string;
      kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
      now?: () => number;
      fs?: Pick<typeof fs, "statSync" | "openSync" | "readSync" | "closeSync">;
      /** Typed from production AsyncStatusQuarantineOptions. */
      quarantine?: AsyncStatusQuarantineOptions;
    },
  ): {
    ensurePoller(): void;
    resetJobs(ctx?: unknown): void;
    restoreActiveJobs(ctx?: unknown): void;
    handleStarted(data: unknown): void;
    handleComplete(data: unknown): void;
  };
}

export const trackerMod = await tryImport<AsyncJobTrackerModule>(
  "./src/runs/background/async-job-tracker.ts",
);
export const available = !!trackerMod;

export function createState() {
  return {
    baseCwd: "/repo",
    currentSessionId: null as string | null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

export function createEventRecorder() {
  const events: Array<{ channel: string; data: unknown }> = [];
  return {
    pi: {
      events: {
        emit: (channel: string, data: unknown) => {
          events.push({ channel, data });
        },
      },
    },
    events,
  };
}

export function pidGone(): never {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
}

export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = scaleTestTimeout(1000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function createUiContext() {
  const widgets: unknown[] = [];
  let renderRequests = 0;
  const ctx = {
    hasUI: true,
    ui: {
      theme: {
        fg: (_theme: string, text: string) => text,
      },
      setWidget: (_key: string, value: unknown) => {
        widgets.push(value);
      },
      requestRender: () => {
        renderRequests += 1;
      },
    },
  };
  return {
    ctx,
    get widgets() {
      return widgets;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}
