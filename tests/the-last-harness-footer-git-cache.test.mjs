import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FooterGitCache } = await jiti.import("../extensions/the-last-harness/footer-git-cache.ts");

const HASH = "1234567890abcdef1234567890abcdef12345678";

function gitStatusStdout({
  branch = "main",
  upstream = undefined,
  ahead = 0,
  behind = 0,
  lines = [],
} = {}) {
  const out = [`# branch.oid ${HASH}`, `# branch.head ${branch}`];
  if (upstream) {
    out.push(`# branch.upstream ${upstream}`);
  }
  if (ahead > 0 || behind > 0) {
    out.push(`# branch.ab +${ahead} -${behind}`);
  }
  out.push(...lines);
  return out.join("\n") + "\n";
}

function handleSymbolicRef(args, stdout = "origin/main\n") {
  if (args[0] === "symbolic-ref") {
    return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
  }
  return null;
}

function ghPrStdout(pr) {
  return JSON.stringify(pr);
}

function createFakeClock() {
  let nextId = 1;
  const intervals = new Map();
  return {
    intervals,
    setInterval(callback, ms) {
      const handle = { id: nextId++, ms, callback };
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    tick(handle) {
      const cb = intervals.get(handle);
      if (cb) cb();
    },
  };
}

function createRecordingRunner(handlers) {
  const calls = [];
  return {
    calls,
    runner(command, args, options) {
      calls.push({ command, args: [...args], cwd: options.cwd });
      const handler = handlers[command];
      if (!handler) {
        return Promise.reject(new Error(`unexpected command: ${command}`));
      }
      return handler({ command, args: [...args], options, callIndex: calls.length - 1 });
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("initial refresh populates status snapshot from injected runner", async () => {
  const stdout = gitStatusStdout({
    branch: "feature/git-footer",
    lines: [
      `1 M. N... 100644 100644 100644 ${HASH} ${HASH} staged.txt`,
      `1 .M N... 100644 100644 100644 ${HASH} ${HASH} unstaged.txt`,
      "? untracked.txt",
    ],
  });
  const { runner } = createRecordingRunner({
    git: async (call) => handleSymbolicRef(call.args) ?? { stdout, stderr: "", exitCode: 0 },
    gh: async () => ({ stdout: "", stderr: "no pr", exitCode: 1 }),
  });
  const clock = createFakeClock();

  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock });
  try {
    await cache.refresh(); // shares the in-flight initial refresh
    await flushMicrotasks();

    const status = cache.getStatusSnapshot();
    assert.ok(status, "expected status snapshot to be populated");
    assert.equal(status.branch, "feature/git-footer");
    assert.equal(status.staged, 1);
    assert.equal(status.unstaged, 1);
    assert.equal(status.untracked, 1);
    assert.equal(cache.getPullRequestSnapshot(), undefined, "no PR when gh exits non-zero");
  } finally {
    cache.dispose();
  }
});

test("git timeout aborts and snapshot remains undefined", async () => {
  let observedSignal;
  const runner = (command, _args, options) => {
    if (command !== "git") {
      return Promise.reject(new Error(`unexpected ${command}`));
    }
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    gitTimeoutMs: 5,
  });
  try {
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot(), undefined);
    assert.equal(cache.getPullRequestSnapshot(), undefined);
    assert.ok(observedSignal?.aborted, "expected runner signal to be aborted by timeout");
  } finally {
    cache.dispose();
  }
});

test("missing-binary error from the runner is swallowed", async () => {
  const runner = () => {
    const err = new Error("spawn ENOENT");
    err.code = "ENOENT";
    return Promise.reject(err);
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock });
  try {
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot(), undefined);
    assert.equal(cache.getPullRequestSnapshot(), undefined);
  } finally {
    cache.dispose();
  }
});

test("branch change on next refresh triggers a fresh PR fetch", async () => {
  let branch = "feature/a";
  const ghCallsByBranch = [];
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({ branch, upstream: `origin/${branch}` }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      ghCallsByBranch.push(branch);
      return Promise.resolve({
        stdout: ghPrStdout({
          number: branch === "feature/a" ? 1 : 2,
          state: "OPEN",
          isDraft: false,
        }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock });
  try {
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "feature/a");
    assert.equal(cache.getPullRequestSnapshot()?.number, 1);
    assert.deepEqual(ghCallsByBranch, ["feature/a"]);

    // Switch branch and trigger the next refresh via the fake clock.
    branch = "feature/b";
    const [intervalHandle] = [...clock.intervals.keys()];
    clock.tick(intervalHandle);
    // The timer callback fires `void cache.refresh()`; drain all microtasks
    // before observing snapshots.
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(cache.getStatusSnapshot()?.branch, "feature/b");
    assert.equal(cache.getPullRequestSnapshot()?.number, 2);
    assert.deepEqual(ghCallsByBranch, ["feature/a", "feature/b"]);
  } finally {
    cache.dispose();
  }
});

test("dispose() clears the periodic timer and aborts in-flight subprocesses", async () => {
  const observedSignals = [];
  let resolveGit;
  const runner = (command, _args, options) => {
    observedSignals.push(options.signal);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (command === "git") {
        resolveGit = resolve;
      }
    });
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    gitTimeoutMs: 60_000,
    ghTimeoutMs: 60_000,
  });

  // Wait until the in-flight git call is observed.
  const refreshPromise = cache.refresh();
  while (observedSignals.length === 0) {
    await flushMicrotasks();
  }
  assert.equal(clock.intervals.size, 1, "interval should be registered before dispose");

  cache.dispose();

  assert.equal(clock.intervals.size, 0, "interval should be cleared after dispose");
  assert.ok(observedSignals[0].aborted, "in-flight git subprocess should be aborted");

  // Even if the underlying runner later resolves, the cache should not crash
  // or update state.
  resolveGit?.({ stdout: gitStatusStdout(), stderr: "", exitCode: 0 });
  await refreshPromise;
  assert.equal(cache.getStatusSnapshot(), undefined);
});

test("gh failure does not clobber a valid git snapshot", async () => {
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({
            branch: "feature/gh-failure",
            upstream: "origin/feature/gh-failure",
            ahead: 1,
          }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    // Simulate `gh` not installed / not authenticated.
    return Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock });
  try {
    await cache.refresh();
    const status = cache.getStatusSnapshot();
    assert.ok(status, "expected status snapshot to survive gh failure");
    assert.equal(status.branch, "feature/gh-failure");
    assert.equal(status.ahead, 1);
    assert.equal(cache.getPullRequestSnapshot(), undefined);
  } finally {
    cache.dispose();
  }
});

test("detached HEAD skips gh entirely", async () => {
  let ghCalled = false;
  const runner = (command) => {
    if (command === "git") {
      return Promise.resolve({
        stdout: gitStatusStdout({ branch: "(detached)" }),
        stderr: "",
        exitCode: 0,
      });
    }
    ghCalled = true;
    return Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 });
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock });
  try {
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "detached");
    assert.equal(ghCalled, false, "gh should not be invoked when branch is detached");
  } finally {
    cache.dispose();
  }
});

test("dispose() is idempotent and refresh() becomes a no-op", async () => {
  let gitCalls = 0;
  const runner = (command) => {
    if (command === "git") {
      gitCalls += 1;
      return Promise.resolve({ stdout: gitStatusStdout(), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
  });

  cache.dispose();
  cache.dispose(); // should not throw

  await cache.refresh();
  assert.equal(gitCalls, 0, "refresh() after dispose() must be a no-op");
});

test("concurrent refresh() calls share a single git/gh invocation", async () => {
  let resolveGit;
  const { calls, runner } = createRecordingRunner({
    git: (call) => {
      if (call.args[0] === "symbolic-ref") {
        return Promise.resolve({ stdout: "origin/main\n", stderr: "", exitCode: 0 });
      }
      return new Promise((resolve) => {
        resolveGit = resolve;
      });
    },
    gh: async () => ({
      stdout: ghPrStdout({ number: 7, state: "OPEN", isDraft: false }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
  });
  try {
    // Three overlapping refresh() calls before the git promise resolves.
    const r1 = cache.refresh();
    const r2 = cache.refresh();
    const r3 = cache.refresh();

    // Let the runner record the git status invocation.
    await flushMicrotasks();

    assert.ok(resolveGit, "git status runner should have been invoked");
    resolveGit({
      stdout: gitStatusStdout({ branch: "feature/shared", upstream: "origin/feature/shared" }),
      stderr: "",
      exitCode: 0,
    });

    await Promise.all([r1, r2, r3]);

    const gitStatusCalls = calls.filter(
      (call) => call.command === "git" && call.args.includes("status"),
    ).length;
    const ghCalls = calls.filter((call) => call.command === "gh").length;
    assert.equal(gitStatusCalls, 1, "concurrent refresh() calls must share one git status spawn");
    assert.equal(ghCalls, 1, "concurrent refresh() calls must share one gh spawn");
  } finally {
    cache.dispose();
  }
});

test("dispose() retains last-known snapshot and post-dispose refresh() is a no-op", async () => {
  const stdout = gitStatusStdout({
    branch: "feature/dispose",
    upstream: "origin/feature/dispose",
    lines: ["? untracked.txt"],
  });
  const { calls, runner } = createRecordingRunner({
    git: async (call) => handleSymbolicRef(call.args) ?? { stdout, stderr: "", exitCode: 0 },
    gh: async () => ({ stdout: "", stderr: "no pr", exitCode: 1 }),
  });
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
  });

  await cache.refresh();
  const beforeDispose = cache.getStatusSnapshot();
  assert.ok(beforeDispose, "expected snapshot to be populated after refresh");
  assert.equal(beforeDispose.branch, "feature/dispose");
  assert.equal(beforeDispose.untracked, 1);

  const callsBeforeDispose = calls.length;
  cache.dispose();

  const afterDispose = cache.getStatusSnapshot();
  assert.strictEqual(afterDispose, beforeDispose, "snapshot reference must survive dispose()");
  assert.equal(afterDispose?.branch, "feature/dispose");
  assert.equal(afterDispose?.untracked, 1);

  await cache.refresh();
  assert.equal(
    calls.length,
    callsBeforeDispose,
    "runner must not be invoked again after dispose()",
  );
  assert.strictEqual(
    cache.getStatusSnapshot(),
    beforeDispose,
    "post-dispose refresh() must not clobber the retained snapshot",
  );
});

test("non-zero git exit (not a repo) clears both snapshots and resets lastSeenBranch", async () => {
  let gitMode = "ok";
  const runner = (command, args) => {
    if (command === "git") {
      if (gitMode === "ok") {
        return (
          handleSymbolicRef(args) ??
          Promise.resolve({
            stdout: gitStatusStdout({
              branch: "feature/persist",
              upstream: "origin/feature/persist",
            }),
            stderr: "",
            exitCode: 0,
          })
        );
      }
      return Promise.resolve({
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        exitCode: 128,
      });
    }
    if (command === "gh") {
      return Promise.resolve({
        stdout: ghPrStdout({ number: 42, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock, skipInitialRefresh: true });
  try {
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "feature/persist");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42);

    // Simulate cd'ing out of the repo: git now exits 128.
    gitMode = "not-a-repo";
    await cache.refresh();

    assert.equal(cache.getStatusSnapshot(), undefined, "status snapshot must be cleared");
    assert.equal(cache.getPullRequestSnapshot(), undefined, "PR snapshot must be cleared");

    // After clearing, returning to the same branch should be treated as a
    // fresh branch entry, not a no-op. Restore git and confirm a PR fetch
    // runs (lastSeenBranch was reset).
    gitMode = "ok";
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "feature/persist");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42);
  } finally {
    cache.dispose();
  }
});

test("transient git failure (runner rejects) preserves both snapshots", async () => {
  let gitMode = "ok";
  const runner = (command, args) => {
    if (command === "git") {
      if (gitMode === "ok") {
        return (
          handleSymbolicRef(args) ??
          Promise.resolve({
            stdout: gitStatusStdout({
              branch: "feature/stable",
              upstream: "origin/feature/stable",
            }),
            stderr: "",
            exitCode: 0,
          })
        );
      }
      // Simulate a spawn error / timeout: runner rejects, runCommandSafely
      // swallows it and fetchGitStatus returns kind:"transient".
      return Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    }
    if (command === "gh") {
      return Promise.resolve({
        stdout: ghPrStdout({ number: 5, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock, skipInitialRefresh: true });
  try {
    await cache.refresh();
    const statusBefore = cache.getStatusSnapshot();
    const prBefore = cache.getPullRequestSnapshot();
    assert.ok(statusBefore);
    assert.equal(statusBefore.branch, "feature/stable");
    assert.equal(prBefore?.number, 5);

    // Transient git failure on next refresh.
    gitMode = "transient";
    await cache.refresh();

    assert.strictEqual(
      cache.getStatusSnapshot(),
      statusBefore,
      "status snapshot must be preserved across transient failures",
    );
    assert.strictEqual(
      cache.getPullRequestSnapshot(),
      prBefore,
      "PR snapshot must be preserved across transient failures",
    );
  } finally {
    cache.dispose();
  }
});

test("ok -> not-a-repo -> ok with a different branch transitions correctly", async () => {
  let branch = "feature/enter";
  let gitMode = "ok";
  const ghCallsByBranch = [];
  const runner = (command, args) => {
    if (command === "git") {
      if (gitMode === "not-a-repo") {
        return Promise.resolve({
          stdout: "",
          stderr: "fatal: not a git repository\n",
          exitCode: 128,
        });
      }
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({ branch, upstream: `origin/${branch}` }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      ghCallsByBranch.push(branch);
      return Promise.resolve({
        stdout: ghPrStdout({
          number: branch === "feature/enter" ? 1 : 2,
          state: "OPEN",
          isDraft: false,
        }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({ cwd: () => "/repo", runner, clock, skipInitialRefresh: true });
  try {
    // 1. ok in "feature/enter"
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "feature/enter");
    assert.equal(cache.getPullRequestSnapshot()?.number, 1);
    assert.deepEqual(ghCallsByBranch, ["feature/enter"]);

    // 2. cwd leaves the repo
    gitMode = "not-a-repo";
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot(), undefined);
    assert.equal(cache.getPullRequestSnapshot(), undefined);

    // 3. cwd enters a different repo on a different branch
    gitMode = "ok";
    branch = "feature/exit";
    await cache.refresh();
    assert.equal(cache.getStatusSnapshot()?.branch, "feature/exit");
    assert.equal(cache.getPullRequestSnapshot()?.number, 2);
    assert.deepEqual(ghCallsByBranch, ["feature/enter", "feature/exit"]);
  } finally {
    cache.dispose();
  }
});

test("onChange fires after the initial refresh populates visible snapshots", async () => {
  const notifications = [];
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({
            branch: "feature/notify",
            upstream: "origin/feature/notify",
          }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      return Promise.resolve({
        stdout: ghPrStdout({ number: 17, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  let cache;
  cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    onChange: () => {
      notifications.push({
        branch: cache.getStatusSnapshot()?.branch,
        prNumber: cache.getPullRequestSnapshot()?.number,
      });
    },
  });
  try {
    await cache.refresh();
    assert.deepEqual(notifications, [{ branch: "feature/notify", prNumber: 17 }]);
  } finally {
    cache.dispose();
  }
});

test("onChange does not fire when a manual refresh keeps both snapshots identical", async () => {
  let notifications = 0;
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({
            branch: "feature/identical",
            upstream: "origin/feature/identical",
            ahead: 1,
          }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      return Promise.resolve({
        stdout: ghPrStdout({ number: 8, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
    onChange: () => {
      notifications += 1;
    },
  });
  try {
    await cache.refresh();
    await cache.refresh();
    assert.equal(notifications, 1);
  } finally {
    cache.dispose();
  }
});

test("onChange fires when a timer refresh clears stale snapshots after leaving a repo", async () => {
  let gitMode = "ok";
  const notifications = [];
  const runner = (command, args) => {
    if (command === "git") {
      if (gitMode === "not-a-repo") {
        return Promise.resolve({
          stdout: "",
          stderr: "fatal: not a git repository\n",
          exitCode: 128,
        });
      }
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({ branch: "feature/timer", upstream: "origin/feature/timer" }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      return Promise.resolve({
        stdout: ghPrStdout({ number: 42, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  let cache;
  cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
    onChange: () => {
      notifications.push({
        branch: cache.getStatusSnapshot()?.branch,
        prNumber: cache.getPullRequestSnapshot()?.number,
      });
    },
  });
  try {
    await cache.refresh();
    gitMode = "not-a-repo";
    const [intervalHandle] = [...clock.intervals.keys()];
    clock.tick(intervalHandle);
    await flushMicrotasks();
    await flushMicrotasks();
    assert.deepEqual(notifications, [
      { branch: "feature/timer", prNumber: 42 },
      { branch: undefined, prNumber: undefined },
    ]);
  } finally {
    cache.dispose();
  }
});

test("onChange fires after branch-change refresh clears a stale PR snapshot", async () => {
  let branch = "feature/has-pr";
  let branchChangeCallback;
  const notifications = [];
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({ branch, upstream: `origin/${branch}` }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      if (branch === "feature/has-pr") {
        return Promise.resolve({
          stdout: ghPrStdout({ number: 3, state: "OPEN", isDraft: false }),
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "no pr", exitCode: 1 });
    }
    return Promise.reject(new Error(`unexpected ${command}`));
  };
  const clock = createFakeClock();
  let cache;
  cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    skipInitialRefresh: true,
    onChange: () => {
      notifications.push({
        branch: cache.getStatusSnapshot()?.branch,
        prNumber: cache.getPullRequestSnapshot()?.number,
      });
    },
    onBranchChangeSource: (callback) => {
      branchChangeCallback = callback;
      return () => {};
    },
  });
  try {
    await cache.refresh();
    branch = "feature/no-pr";
    branchChangeCallback();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.deepEqual(notifications, [
      { branch: "feature/has-pr", prNumber: 3 },
      { branch: "feature/no-pr", prNumber: undefined },
    ]);
  } finally {
    cache.dispose();
  }
});

test("onChange does not fire when dispose() interrupts an in-flight refresh", async () => {
  let observedSignal;
  let notifications = 0;
  const runner = (command, _args, options) => {
    if (command !== "git") {
      return Promise.reject(new Error(`unexpected ${command}`));
    }
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const clock = createFakeClock();
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock,
    gitTimeoutMs: 60_000,
    onChange: () => {
      notifications += 1;
    },
    skipInitialRefresh: true,
  });

  const refreshPromise = cache.refresh();
  while (!observedSignal) {
    await flushMicrotasks();
  }

  cache.dispose();
  await refreshPromise;
  assert.ok(observedSignal.aborted);
  assert.equal(notifications, 0);
});

test("default five-minute cadence throttles gh attempts after every outcome", async () => {
  let fakeNow = 0;
  let gitStatusCalls = 0;
  let symbolicRefCalls = 0;
  let ghCalls = 0;
  let ghMode = "success";
  let observedGhTimeoutSignal;

  const runner = (command, args, options) => {
    if (command === "git") {
      if (args[0] === "symbolic-ref") {
        symbolicRefCalls += 1;
        return Promise.resolve({ stdout: "origin/main\n", stderr: "", exitCode: 0 });
      }
      gitStatusCalls += 1;
      return Promise.resolve({
        stdout: gitStatusStdout({ branch: "feature/no-tracking", ahead: gitStatusCalls }),
        stderr: "",
        exitCode: 0,
      });
    }
    if (command === "gh") {
      ghCalls += 1;
      if (ghMode === "no-pr") {
        return Promise.resolve({ stdout: "", stderr: "no pull request\n", exitCode: 1 });
      }
      if (ghMode === "malformed") {
        return Promise.resolve({ stdout: "not-json", stderr: "", exitCode: 0 });
      }
      if (ghMode === "error") {
        return Promise.reject(new Error("temporary gh failure"));
      }
      if (ghMode === "timeout") {
        observedGhTimeoutSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("timed out")), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        stdout: ghPrStdout({ number: 42, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  };

  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
    ghTimeoutMs: 5,
    now: () => fakeNow,
  });
  try {
    await cache.refresh();
    assert.equal(ghCalls, 1, "initial eligible branch should look up its PR");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42);

    fakeNow = 299_999;
    await cache.refresh();
    assert.equal(ghCalls, 1, "refreshes before the default TTL must skip gh");
    assert.equal(
      cache.getStatusSnapshot()?.ahead,
      2,
      "git status must keep polling during the TTL",
    );

    ghMode = "no-pr";
    fakeNow = 300_000;
    await cache.refresh();
    assert.equal(ghCalls, 2, "the exact default TTL boundary must permit another attempt");
    assert.equal(
      cache.getPullRequestSnapshot()?.number,
      42,
      "no PR keeps a valid same-context cache",
    );

    fakeNow = 599_999;
    await cache.refresh();
    assert.equal(ghCalls, 2, "a no-PR result must not retry before the next default interval");

    ghMode = "malformed";
    fakeNow = 600_000;
    await cache.refresh();
    assert.equal(ghCalls, 3, "malformed output counts as an attempt");
    assert.equal(
      cache.getPullRequestSnapshot()?.number,
      42,
      "malformed output keeps the cached PR",
    );

    fakeNow = 899_999;
    await cache.refresh();
    assert.equal(ghCalls, 3, "malformed output must not retry before the next default interval");

    ghMode = "error";
    fakeNow = 900_000;
    await cache.refresh();
    assert.equal(ghCalls, 4, "runner errors count as an attempt");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42, "runner errors keep the cached PR");

    fakeNow = 1_199_999;
    await cache.refresh();
    assert.equal(ghCalls, 4, "a runner error must not retry before the next default interval");

    ghMode = "timeout";
    fakeNow = 1_200_000;
    await cache.refresh();
    assert.equal(ghCalls, 5, "timeouts count as an attempt");
    assert.ok(observedGhTimeoutSignal?.aborted, "the gh timeout should abort its signal");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42, "timeouts keep the cached PR");

    fakeNow = 1_499_999;
    await cache.refresh();
    assert.equal(ghCalls, 5, "a timeout must not retry before the next default interval");

    ghMode = "success";
    fakeNow = 1_500_000;
    await cache.refresh();
    assert.equal(ghCalls, 6, "the next exact default TTL boundary must permit an attempt");
    assert.equal(cache.getPullRequestSnapshot()?.number, 42);
    assert.equal(symbolicRefCalls, 1, "default-branch detection should be cached per cwd");
    assert.equal(gitStatusCalls, 11, "git status should run for every refresh");
  } finally {
    cache.dispose();
  }
});

test("clock rollback permits one PR refresh before normal throttling resumes", async () => {
  let fakeNow = 1_000_000;
  let ghCalls = 0;
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({
            branch: "feature/clock-rollback",
            upstream: "origin/feature/clock-rollback",
          }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      ghCalls += 1;
      return Promise.resolve({
        stdout: ghPrStdout({ number: ghCalls, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  };

  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
    now: () => fakeNow,
  });
  try {
    await cache.refresh();
    assert.equal(ghCalls, 1);

    fakeNow = 999_000;
    await cache.refresh();
    assert.equal(ghCalls, 2, "clock rollback must permit one refresh");

    fakeNow = 999_001;
    await cache.refresh();
    assert.equal(ghCalls, 2, "normal throttling must resume after the rollback refresh");

    fakeNow = 1_298_999;
    await cache.refresh();
    assert.equal(ghCalls, 2, "the default interval still suppresses pre-boundary refreshes");

    fakeNow = 1_299_000;
    await cache.refresh();
    assert.equal(ghCalls, 3, "the default interval boundary must trigger the next refresh");
  } finally {
    cache.dispose();
  }
});

test("exact TTL, branch changes, cwd changes, and one cwd capture bypass PR throttling", async () => {
  let fakeNow = 0;
  let branch = "feature/one";
  let currentCwd = "/repo-a";
  let mutateCwdDuringStatus = false;
  let ghCalls = 0;
  const calls = [];

  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    if (command === "git") {
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ stdout: "origin/main\n", stderr: "", exitCode: 0 });
      }
      if (mutateCwdDuringStatus) {
        currentCwd = "/repo-c";
      }
      return Promise.resolve({
        stdout: gitStatusStdout({ branch, upstream: `origin/${branch}` }),
        stderr: "",
        exitCode: 0,
      });
    }
    if (command === "gh") {
      ghCalls += 1;
      const number = options.cwd === "/repo-a" ? 1 : options.cwd === "/repo-b" ? 2 : 3;
      return Promise.resolve({
        stdout: ghPrStdout({ number, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  };

  const cache = new FooterGitCache({
    cwd: () => currentCwd,
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
    pullRequestRefreshIntervalMs: 1_000,
    now: () => fakeNow,
  });
  try {
    await cache.refresh();
    assert.equal(ghCalls, 1);

    fakeNow = 999;
    await cache.refresh();
    assert.equal(ghCalls, 1, "the TTL is fixed-delay and exclusive before its boundary");

    fakeNow = 1_000;
    await cache.refresh();
    assert.equal(ghCalls, 2, "the exact TTL boundary must trigger a lookup");

    branch = "feature/two";
    fakeNow = 1_001;
    await cache.refresh();
    assert.equal(ghCalls, 3, "a branch change must bypass the TTL");

    currentCwd = "/repo-b";
    mutateCwdDuringStatus = true;
    fakeNow = 1_002;
    const beforeCwdChangeCallCount = calls.length;
    await cache.refresh();
    assert.equal(ghCalls, 4, "a cwd change must bypass the TTL");
    assert.equal(cache.getPullRequestSnapshot()?.number, 2);
    const cwdChangeCalls = calls.slice(beforeCwdChangeCallCount);
    assert.deepEqual(
      cwdChangeCalls.map((call) => call.cwd),
      ["/repo-b", "/repo-b", "/repo-b"],
      "status, default detection, and gh must share one captured cwd",
    );

    // The accessor changed during the prior refresh, but the next refresh must
    // use the newly observed cwd consistently and invalidate the old PR again.
    mutateCwdDuringStatus = false;
    fakeNow = 1_003;
    const beforeSecondCwdChangeCallCount = calls.length;
    await cache.refresh();
    assert.equal(ghCalls, 5);
    assert.equal(cache.getPullRequestSnapshot()?.number, 3);
    assert.deepEqual(
      calls.slice(beforeSecondCwdChangeCallCount).map((call) => call.cwd),
      ["/repo-c", "/repo-c", "/repo-c"],
    );
  } finally {
    cache.dispose();
  }
});

test("first upstream appearance bypasses the TTL without suppressing no-upstream lookups", async () => {
  let fakeNow = 0;
  let upstream;
  let ghCalls = 0;
  const runner = (command, args) => {
    if (command === "git") {
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({ branch: "feature/pushed-later", upstream }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    if (command === "gh") {
      ghCalls += 1;
      return Promise.resolve({
        stdout: ghPrStdout({ number: ghCalls, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.reject(new Error(`unexpected command: ${command}`));
  };

  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
    pullRequestRefreshIntervalMs: 300_000,
    now: () => fakeNow,
  });
  try {
    await cache.refresh();
    assert.equal(ghCalls, 1, "a non-default branch without upstream is still eligible");
    assert.equal(cache.getPullRequestSnapshot()?.number, 1);

    fakeNow = 1_000;
    await cache.refresh();
    assert.equal(ghCalls, 1, "an unchanged no-upstream context stays throttled");

    upstream = "origin/feature/pushed-later";
    fakeNow = 2_000;
    await cache.refresh();
    assert.equal(ghCalls, 2, "first upstream appearance must bypass the long TTL");
    assert.equal(cache.getPullRequestSnapshot()?.number, 2);

    fakeNow = 3_000;
    await cache.refresh();
    assert.equal(ghCalls, 2, "later same-context refreshes remain throttled");
  } finally {
    cache.dispose();
  }
});

test("custom origin HEAD marks its branch as default and caches local detection", async () => {
  let symbolicRefCalls = 0;
  let statusCalls = 0;
  let ghCalls = 0;
  const runner = (command, args) => {
    if (command === "git") {
      if (args[0] === "symbolic-ref") {
        symbolicRefCalls += 1;
        return Promise.resolve({ stdout: "origin/develop\n", stderr: "", exitCode: 0 });
      }
      statusCalls += 1;
      return Promise.resolve({
        stdout: gitStatusStdout({ branch: "develop", upstream: "origin/develop" }),
        stderr: "",
        exitCode: 0,
      });
    }
    ghCalls += 1;
    return Promise.resolve({
      stdout: ghPrStdout({ number: 99, state: "OPEN", isDraft: false }),
      stderr: "",
      exitCode: 0,
    });
  };
  const cache = new FooterGitCache({
    cwd: () => "/repo",
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
  });
  try {
    await cache.refresh();
    await cache.refresh();
    assert.equal(ghCalls, 0, "custom origin/HEAD default branches must skip gh");
    assert.equal(statusCalls, 2, "git status must continue polling");
    assert.equal(symbolicRefCalls, 1, "local default detection must be cached per cwd");
  } finally {
    cache.dispose();
  }
});

test("main and master are default fallbacks when local origin HEAD is unavailable", async () => {
  for (const branch of ["main", "master"]) {
    let symbolicRefCalls = 0;
    let ghCalls = 0;
    const runner = (command, args) => {
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          symbolicRefCalls += 1;
          return Promise.resolve({ stdout: "", stderr: "no origin HEAD\n", exitCode: 128 });
        }
        return Promise.resolve({
          stdout: gitStatusStdout({ branch, upstream: `origin/${branch}` }),
          stderr: "",
          exitCode: 0,
        });
      }
      ghCalls += 1;
      return Promise.resolve({
        stdout: ghPrStdout({ number: 100, state: "OPEN", isDraft: false }),
        stderr: "",
        exitCode: 0,
      });
    };
    const cache = new FooterGitCache({
      cwd: () => `/repo/${branch}`,
      runner,
      clock: createFakeClock(),
      skipInitialRefresh: true,
    });
    try {
      await cache.refresh();
      await cache.refresh();
      assert.equal(ghCalls, 0, `${branch} fallback default must skip gh`);
      assert.equal(symbolicRefCalls, 1, `${branch} fallback detection must be cached`);
    } finally {
      cache.dispose();
    }
  }
});

test("cwd changes clear stale PR state and notify even when the new git read fails", async () => {
  let currentCwd = "/repo-a";
  let gitShouldFail = false;
  const notifications = [];
  const runner = (command, args, options) => {
    if (command === "git") {
      if (gitShouldFail) {
        return Promise.reject(new Error("temporary git failure"));
      }
      return (
        handleSymbolicRef(args) ??
        Promise.resolve({
          stdout: gitStatusStdout({
            branch: "feature/same-name",
            upstream: "origin/feature/same-name",
          }),
          stderr: "",
          exitCode: 0,
        })
      );
    }
    return Promise.resolve({
      stdout: ghPrStdout({ number: options.cwd === "/repo-a" ? 10 : 20 }),
      stderr: "",
      exitCode: 0,
    });
  };
  let cache;
  cache = new FooterGitCache({
    cwd: () => currentCwd,
    runner,
    clock: createFakeClock(),
    skipInitialRefresh: true,
    onChange: () => {
      notifications.push({
        branch: cache.getStatusSnapshot()?.branch,
        prNumber: cache.getPullRequestSnapshot()?.number,
      });
    },
  });
  try {
    await cache.refresh();
    assert.deepEqual(notifications, [{ branch: "feature/same-name", prNumber: 10 }]);

    currentCwd = "/repo-b";
    gitShouldFail = true;
    await cache.refresh();
    assert.equal(cache.getPullRequestSnapshot(), undefined);
    assert.deepEqual(
      notifications,
      [
        { branch: "feature/same-name", prNumber: 10 },
        { branch: "feature/same-name", prNumber: undefined },
      ],
      "cwd invalidation must notify even when git fails before a new snapshot",
    );

    gitShouldFail = false;
    await cache.refresh();
    assert.equal(cache.getPullRequestSnapshot()?.number, 20);
    assert.equal(notifications.at(-1)?.prNumber, 20);
  } finally {
    cache.dispose();
  }
});
