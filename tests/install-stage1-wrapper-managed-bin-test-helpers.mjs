import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  runHelper,
  scrubInstallerEnv,
  TLH_PINNED_PI_VERSION,
  writeFakePi,
} from "./install-stage1-core-test-helpers.mjs";
import { makeTempDir } from "./install-stage1-test-helpers.mjs";

export function setupTicketsEnabledWrapperFixture(t) {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const fakebin = join(root, "fakebin");
  const cwdDir = join(root, "cwd");
  const piLog = join(root, "pi.txt");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakePi(
    fakebin,
    [
      `if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_PINNED_PI_VERSION}\\n'; exit 0; fi`,
      'printf \'path=%s\\n\' "${PATH:-}" >"${PI_WRAPPER_LOG}"',
    ].join("\n"),
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(fakebin, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const runWrapper = () =>
    spawnSync(wrapper, ["chat"], {
      cwd: cwdDir,
      env: scrubInstallerEnv({
        HOME: homeDir,
        PATH: [fakebin, process.env.PATH || ""].join(":"),
        PI_WRAPPER_LOG: piLog,
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const readPiPath = () => readFileSync(piLog, "utf8").trim().slice("path=".length).split(":");

  return { agentDir, agentBin, runWrapper, readPiPath };
}
