import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessAlive, parseLinuxProcStatState } from "./process-liveness.mjs";

function procStat(comm, state) {
  return `123 (${comm}) ${state} 1 2 3`;
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

test("parseLinuxProcStatState handles spaces and embedded parentheses in comm", () => {
  assert.equal(
    parseLinuxProcStatState(procStat("writer with spaces (and ) parentheses)", "Z")),
    "Z",
  );
  assert.equal(
    parseLinuxProcStatState(procStat("writer with spaces (and ) parentheses)", "R")),
    "R",
  );
});

test("parseLinuxProcStatState rejects malformed stat records", () => {
  assert.equal(parseLinuxProcStatState("not a proc stat"), undefined);
  assert.equal(parseLinuxProcStatState("123 (writer)"), undefined);
  assert.equal(parseLinuxProcStatState("123 (writer) ZZ 1 2 3"), undefined);
});

test("isProcessAlive treats a positively identified Linux zombie as terminated", () => {
  const kills = [];
  const reads = [];
  const alive = isProcessAlive(123, {
    platform: "linux",
    kill: (pid, signal) => kills.push([pid, signal]),
    readProcStat: (pid) => {
      reads.push(pid);
      return procStat("writer with spaces (and ) parentheses)", "Z");
    },
  });

  assert.equal(alive, false);
  assert.deepEqual(kills, [[123, 0]]);
  assert.deepEqual(reads, [123]);
});

test("isProcessAlive keeps unknown or malformed Linux states alive", () => {
  for (const stat of [procStat("writer", "Q"), "malformed"]) {
    assert.equal(
      isProcessAlive(123, {
        platform: "linux",
        kill: () => {},
        readProcStat: () => stat,
      }),
      true,
      `expected conservative liveness for ${JSON.stringify(stat)}`,
    );
  }
});

test("isProcessAlive keeps unreadable Linux proc records alive", () => {
  assert.equal(
    isProcessAlive(123, {
      platform: "linux",
      kill: () => {},
      readProcStat: () => {
        throw codedError("EACCES");
      },
    }),
    true,
  );
});

test("isProcessAlive preserves EPERM and ESRCH kill results", () => {
  assert.equal(
    isProcessAlive(123, {
      platform: "linux",
      kill: () => {
        throw codedError("EPERM");
      },
      readProcStat: () => {
        throw new Error("proc stat should not be read after EPERM");
      },
    }),
    true,
  );
  assert.equal(
    isProcessAlive(123, {
      platform: "linux",
      kill: () => {
        throw codedError("ESRCH");
      },
      readProcStat: () => {
        throw new Error("proc stat should not be read after ESRCH");
      },
    }),
    false,
  );
});

test("isProcessAlive leaves non-Linux kill-success behavior unchanged", () => {
  let procRead = false;
  assert.equal(
    isProcessAlive(123, {
      platform: "darwin",
      kill: () => {},
      readProcStat: () => {
        procRead = true;
        return procStat("writer", "Z");
      },
    }),
    true,
  );
  assert.equal(procRead, false);
});
