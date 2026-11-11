// Subprocess helper: runs one real single step (leased session, mock Pi from the
// inherited PI_SUBAGENT_PI_BINARY) so tests can signal the runner process.
// The mock Pi CLI script comes from TLH_TEST_PI_ARGV1 (the test's patched argv[1]);
// see mock-pi-guard.ts for the fail-closed checks.
// Usage: <sessionDir> <outputFile>
import { DISABLED_COMPACT_ARTIFACT_CONFIG as artifactConfig } from "./artifact-config-fixtures.ts";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
import { requireMockPi } from "./mock-pi-guard.ts";

// Fail closed before anything can spawn: only the proven mock Pi may be launched.
let mockPi: ReturnType<typeof requireMockPi>;
try {
  mockPi = requireMockPi();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const [sessionDir, outputFile] = process.argv.slice(2) as [string, string];
await runSingleStep(
  {
    agent: "worker",
    task: "Run until signalled.",
    inheritProjectContext: false,
    inheritSkills: false,
  },
  {
    cwd: process.cwd(),
    sessionEnabled: true,
    sessionDir,
    artifactConfig,
    id: "signal-run",
    flatIndex: 0,
    flatStepCount: 1,
    outputFile,
    startedAt: Date.now(),
    piArgv1: mockPi.cliScript,
    piPackageRoot: mockPi.packageRoot,
  },
  () => undefined,
);
