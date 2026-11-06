import * as fs from "node:fs";
import * as path from "node:path";

export interface MockPiLocation {
  /** The mock Pi CLI script (`<root>/pi-coding-agent/dist/cli.mjs`). */
  cliScript: string;
  /** The mock's package root, safe to pass as `piPackageRoot`. */
  packageRoot: string;
}

/**
 * Fail-closed guard for subprocess helpers that spawn "Pi". Returns the mock Pi
 * location only when the environment proves it is the test mock (created by
 * `createMockPi`): `TLH_TEST_PI_ARGV1` must be the mock CLI script, which must
 * delegate to `mock-pi-script.mjs` and sit beside the queue directory named by
 * `MOCK_PI_QUEUE_DIR`; and `PI_SUBAGENT_PI_BINARY` must be unset (it would
 * override script resolution). Otherwise it throws, so a helper can never fall
 * back to a real Pi, real model or the caller's TLH profile.
 */
export function requireMockPi(env: NodeJS.ProcessEnv = process.env): MockPiLocation {
  const fail = (reason: string): never => {
    throw new Error(`Refusing to run: not a mock Pi environment (${reason}).`);
  };
  const argv1 = env.TLH_TEST_PI_ARGV1;
  const queueDir = env.MOCK_PI_QUEUE_DIR;
  if (!argv1) return fail("TLH_TEST_PI_ARGV1 is not set");
  if (!queueDir) return fail("MOCK_PI_QUEUE_DIR is not set");
  if (env.PI_SUBAGENT_PI_BINARY?.trim()) return fail("PI_SUBAGENT_PI_BINARY is set");
  let cliScript: string;
  let queue: string;
  try {
    cliScript = fs.realpathSync(argv1);
    queue = fs.realpathSync(queueDir);
  } catch {
    return fail("mock paths do not exist");
  }
  const packageRoot = path.dirname(path.dirname(cliScript));
  if (
    path.basename(cliScript) !== "cli.mjs" ||
    path.basename(path.dirname(cliScript)) !== "dist" ||
    path.basename(packageRoot) !== "pi-coding-agent" ||
    path.join(path.dirname(packageRoot), "queue") !== queue
  ) {
    return fail("TLH_TEST_PI_ARGV1 is not beside MOCK_PI_QUEUE_DIR");
  }
  try {
    if (!fs.readFileSync(cliScript, "utf-8").includes("mock-pi-script.mjs")) {
      return fail("CLI script does not delegate to the mock");
    }
  } catch {
    return fail("CLI script is unreadable");
  }
  return { cliScript, packageRoot };
}
