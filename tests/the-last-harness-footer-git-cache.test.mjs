import assert from "node:assert/strict";
import test from "node:test";

import { FooterGitCache } from "../extensions/the-last-harness/footer-git-cache.ts";

const HASH = "1234567890abcdef1234567890abcdef12345678";

function gitStatusStdout({ branch = "main", ahead = 0, behind = 0, lines = [] } = {}) {
	const out = [`# branch.oid ${HASH}`, `# branch.head ${branch}`];
	if (ahead > 0 || behind > 0) {
		out.push(`# branch.ab +${ahead} -${behind}`);
	}
	out.push(...lines);
	return out.join("\n") + "\n";
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
		git: async () => ({ stdout, stderr: "", exitCode: 0 }),
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
			options.signal.addEventListener(
				"abort",
				() => reject(new Error("aborted")),
				{ once: true },
			);
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
	let branch = "main";
	const ghCallsByBranch = [];
	const runner = (command) => {
		if (command === "git") {
			return Promise.resolve({ stdout: gitStatusStdout({ branch }), stderr: "", exitCode: 0 });
		}
		if (command === "gh") {
			ghCallsByBranch.push(branch);
			return Promise.resolve({
				stdout: ghPrStdout({ number: branch === "main" ? 1 : 2, state: "OPEN", isDraft: false }),
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
		assert.equal(cache.getStatusSnapshot()?.branch, "main");
		assert.equal(cache.getPullRequestSnapshot()?.number, 1);
		assert.deepEqual(ghCallsByBranch, ["main"]);

		// Switch branch and trigger the next refresh via the fake clock.
		branch = "feature/x";
		const [intervalHandle] = [...clock.intervals.keys()];
		clock.tick(intervalHandle);
		// The timer callback fires `void cache.refresh()`; drain all microtasks
		// before observing snapshots.
		await flushMicrotasks();
		await flushMicrotasks();

		assert.equal(cache.getStatusSnapshot()?.branch, "feature/x");
		assert.equal(cache.getPullRequestSnapshot()?.number, 2);
		assert.deepEqual(ghCallsByBranch, ["main", "feature/x"]);
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
			options.signal.addEventListener(
				"abort",
				() => reject(new Error("aborted")),
				{ once: true },
			);
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
	const runner = (command) => {
		if (command === "git") {
			return Promise.resolve({ stdout: gitStatusStdout({ branch: "main", ahead: 1 }), stderr: "", exitCode: 0 });
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
		assert.equal(status.branch, "main");
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
			return Promise.resolve({ stdout: gitStatusStdout({ branch: "(detached)" }), stderr: "", exitCode: 0 });
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
		git: () =>
			new Promise((resolve) => {
				resolveGit = resolve;
			}),
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

		// Let the runner record the git invocation.
		await flushMicrotasks();

		assert.ok(resolveGit, "git runner should have been invoked");
		resolveGit({
			stdout: gitStatusStdout({ branch: "main" }),
			stderr: "",
			exitCode: 0,
		});

		await Promise.all([r1, r2, r3]);

		const gitCalls = calls.filter((c) => c.command === "git").length;
		const ghCalls = calls.filter((c) => c.command === "gh").length;
		assert.equal(gitCalls, 1, "concurrent refresh() calls must share one git spawn");
		assert.ok(ghCalls <= 1, `expected at most one gh call, got ${ghCalls}`);
	} finally {
		cache.dispose();
	}
});

test("dispose() retains last-known snapshot and post-dispose refresh() is a no-op", async () => {
	const stdout = gitStatusStdout({
		branch: "main",
		lines: ["? untracked.txt"],
	});
	const { calls, runner } = createRecordingRunner({
		git: async () => ({ stdout, stderr: "", exitCode: 0 }),
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
	assert.equal(beforeDispose.branch, "main");
	assert.equal(beforeDispose.untracked, 1);

	const callsBeforeDispose = calls.length;
	cache.dispose();

	const afterDispose = cache.getStatusSnapshot();
	assert.strictEqual(afterDispose, beforeDispose, "snapshot reference must survive dispose()");
	assert.equal(afterDispose?.branch, "main");
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
	const runner = (command) => {
		if (command === "git") {
			if (gitMode === "ok") {
				return Promise.resolve({
					stdout: gitStatusStdout({ branch: "main" }),
					stderr: "",
					exitCode: 0,
				});
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
		assert.equal(cache.getStatusSnapshot()?.branch, "main");
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
		assert.equal(cache.getStatusSnapshot()?.branch, "main");
		assert.equal(cache.getPullRequestSnapshot()?.number, 42);
	} finally {
		cache.dispose();
	}
});

test("transient git failure (runner rejects) preserves both snapshots", async () => {
	let gitMode = "ok";
	const runner = (command) => {
		if (command === "git") {
			if (gitMode === "ok") {
				return Promise.resolve({
					stdout: gitStatusStdout({ branch: "main" }),
					stderr: "",
					exitCode: 0,
				});
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
		assert.equal(statusBefore.branch, "main");
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
	let branch = "main";
	let gitMode = "ok";
	const ghCallsByBranch = [];
	const runner = (command) => {
		if (command === "git") {
			if (gitMode === "not-a-repo") {
				return Promise.resolve({
					stdout: "",
					stderr: "fatal: not a git repository\n",
					exitCode: 128,
				});
			}
			return Promise.resolve({
				stdout: gitStatusStdout({ branch }),
				stderr: "",
				exitCode: 0,
			});
		}
		if (command === "gh") {
			ghCallsByBranch.push(branch);
			return Promise.resolve({
				stdout: ghPrStdout({
					number: branch === "main" ? 1 : 2,
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
		// 1. ok in "main"
		await cache.refresh();
		assert.equal(cache.getStatusSnapshot()?.branch, "main");
		assert.equal(cache.getPullRequestSnapshot()?.number, 1);
		assert.deepEqual(ghCallsByBranch, ["main"]);

		// 2. cwd leaves the repo
		gitMode = "not-a-repo";
		await cache.refresh();
		assert.equal(cache.getStatusSnapshot(), undefined);
		assert.equal(cache.getPullRequestSnapshot(), undefined);

		// 3. cwd enters a different repo on a different branch
		gitMode = "ok";
		branch = "other-branch";
		await cache.refresh();
		assert.equal(cache.getStatusSnapshot()?.branch, "other-branch");
		assert.equal(cache.getPullRequestSnapshot()?.number, 2);
		assert.deepEqual(ghCallsByBranch, ["main", "other-branch"]);
	} finally {
		cache.dispose();
	}
});

test("onChange fires after the initial refresh populates visible snapshots", async () => {
	const notifications = [];
	const runner = (command) => {
		if (command === "git") {
			return Promise.resolve({
				stdout: gitStatusStdout({ branch: "main" }),
				stderr: "",
				exitCode: 0,
			});
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
		assert.deepEqual(notifications, [{ branch: "main", prNumber: 17 }]);
	} finally {
		cache.dispose();
	}
});

test("onChange does not fire when a manual refresh keeps both snapshots identical", async () => {
	let notifications = 0;
	const runner = (command) => {
		if (command === "git") {
			return Promise.resolve({
				stdout: gitStatusStdout({ branch: "main", ahead: 1 }),
				stderr: "",
				exitCode: 0,
			});
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
	const runner = (command) => {
		if (command === "git") {
			if (gitMode === "not-a-repo") {
				return Promise.resolve({
					stdout: "",
					stderr: "fatal: not a git repository\n",
					exitCode: 128,
				});
			}
			return Promise.resolve({
				stdout: gitStatusStdout({ branch: "main" }),
				stderr: "",
				exitCode: 0,
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
			{ branch: "main", prNumber: 42 },
			{ branch: undefined, prNumber: undefined },
		]);
	} finally {
		cache.dispose();
	}
});

test("onChange fires after branch-change refresh clears a stale PR snapshot", async () => {
	let branch = "main";
	let branchChangeCallback;
	const notifications = [];
	const runner = (command) => {
		if (command === "git") {
			return Promise.resolve({
				stdout: gitStatusStdout({ branch }),
				stderr: "",
				exitCode: 0,
			});
		}
		if (command === "gh") {
			if (branch === "main") {
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
		branch = "feature/x";
		branchChangeCallback();
		await flushMicrotasks();
		await flushMicrotasks();
		assert.deepEqual(notifications, [
			{ branch: "main", prNumber: 3 },
			{ branch: "feature/x", prNumber: undefined },
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
			options.signal.addEventListener(
				"abort",
				() => reject(new Error("aborted")),
				{ once: true },
			);
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
