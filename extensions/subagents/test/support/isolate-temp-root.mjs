/**
 * Isolate test runs onto a per-process temp root (issue #45).
 *
 * Usage: node --experimental-strip-types --import ./test/support/isolate-temp-root.mjs --test test/unit/*.test.ts
 *
 * Tests import ASYNC_DIR/RESULTS_DIR/etc. from src/shared/types.ts, which
 * otherwise resolve under the shared uid-scoped temp root
 * ($TMPDIR/pi-subagents-uid-<uid>/) also used by live pi sessions. Writing
 * fixture runs/results there pollutes live sessions (ghost notifications,
 * doctor noise). Redirect via PI_SUBAGENTS_TEMP_ROOT to a fresh mkdtemp
 * directory for this process, unless the caller already set an override.
 * Spawned child processes (e.g. the async runner) inherit this env var and
 * transparently resolve the same isolated root.
 *
 * TEMP_ROOT_DIR in src/shared/types.ts is computed at module load, so this
 * env var must be set before any test file imports src — that ordering is
 * guaranteed by --import semantics.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()) {
	const isolatedRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-test-root-"),
	);
	process.env.PI_SUBAGENTS_TEMP_ROOT = isolatedRoot;

	process.on("exit", () => {
		try {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; ignore failures (e.g. already removed)
		}
	});
}
