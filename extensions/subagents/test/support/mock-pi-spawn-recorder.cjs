// Preloaded into Node processes started while mock pi is installed. It records
// every child-process spawn of a pi agent (identified by "--mode") synchronously
// at the spawn call, before the child can initialize or be signaled, so tests can
// assert whether a spawn was attempted regardless of how quickly it was killed.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const logPath = process.env.MOCK_PI_SPAWN_LOG;
if (logPath) {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function recordedSpawn(command, args, ...rest) {
    if (Array.isArray(args) && args.includes("--mode")) {
      try {
        fs.appendFileSync(logPath, `${JSON.stringify({ command, args, ts: Date.now() })}\n`);
      } catch {
        // Recording is best effort; the spawn itself must proceed.
      }
    }
    return originalSpawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
}
