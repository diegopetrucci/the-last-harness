import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { tempRoot } from "../support/lifecycle-state-fixtures.ts";

const HELPER = path.resolve(import.meta.dirname, "../support/signal-status-writer.ts");
const ITERATIONS = 64;
const CONCURRENCY = 8;
const WAIT_TIMEOUT_MS = 10_000;

interface KillOutcome {
  signal: NodeJS.Signals | null;
  ownerlessLock: boolean;
}

async function killWriterOnce(index: number, installHandler: boolean): Promise<KillOutcome> {
  const asyncDir = tempRoot("tlh-signal-lock-");
  const { TLH_TEST_NO_KILL_CLEANUP: _inherited, ...baseEnv } = process.env;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", HELPER, asyncDir],
    {
      env: installHandler ? baseEnv : { ...baseEnv, TLH_TEST_NO_KILL_CLEANUP: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => resolve(signal));
  });
  // A rejected `exited` must not be reported as unhandled while we await readiness.
  exited.catch(() => undefined);
  const timers: NodeJS.Timeout[] = [];
  const bounded = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timers.push(timer);
      promise.then(resolve, reject);
    });
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
        child.once("exit", () => reject(new Error("writer exited before ready")));
      }),
      WAIT_TIMEOUT_MS,
      `writer did not report ready within ${WAIT_TIMEOUT_MS}ms`,
    );
    // Vary the kill point across the write loop.
    await new Promise((resolve) => setTimeout(resolve, index % 7));
    child.kill("SIGINT");
    const signal = await bounded(
      exited,
      WAIT_TIMEOUT_MS,
      `writer did not exit within ${WAIT_TIMEOUT_MS}ms after SIGINT`,
    );
    const lock = path.join(asyncDir, ".lifecycle-transition.lock");
    const ownerlessLock = fs.existsSync(lock) && !fs.existsSync(path.join(lock, "owner.json"));
    return { signal, ownerlessLock };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited.catch(() => undefined),
        new Promise((resolve) => timers.push(setTimeout(resolve, WAIT_TIMEOUT_MS))),
      ]);
    }
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(asyncDir, { recursive: true, force: true });
  }
}

async function runKills(installHandler: boolean): Promise<KillOutcome[]> {
  const outcomes: KillOutcome[] = [];
  for (let start = 0; start < ITERATIONS; start += CONCURRENCY) {
    const batch = Array.from({ length: CONCURRENCY }, (_, i) =>
      killWriterOnce(start + i, installHandler),
    );
    outcomes.push(...(await Promise.all(batch)));
  }
  return outcomes;
}

describe("runner signal handling vs lifecycle lock", () => {
  it("never leaves an ownerless lifecycle lock when SIGINT hits a writer with the kill handler", async () => {
    const outcomes = await runKills(true);
    assert.equal(
      outcomes.filter((o) => o.ownerlessLock).length,
      0,
      "SIGINT left .lifecycle-transition.lock without owner.json",
    );
    for (const outcome of outcomes) assert.equal(outcome.signal, "SIGINT");
  });
});
