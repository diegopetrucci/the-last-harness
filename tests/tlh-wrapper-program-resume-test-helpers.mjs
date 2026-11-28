import { spawnSync } from "node:child_process";
import {
  readdirSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TOKEN = "secret-osc7577-token";

function stub(name) {
  return [
    "#!/bin/sh",
    `rec="$TLH_TEST_RECORD_DIR/${name}.txt"`,
    '{ printf "ARGV:"; for a in "$@"; do printf "[%s]" "$a"; done; printf "\\n"; env; } >> "$rec"',
    "",
  ].join("\n");
}

// Runs a freshly rendered wrapper with fake node/pi stubs that record argv + env.
// `tty: true` runs it with stdin/stdout on a pty (python3 pty bridge).
export function runWrapper(t, options = {}) {
  const {
    args = [],
    env: extraEnv = {},
    tty = false,
    wrapperName = "tlh",
    packageRoot,
    missingPreload = false,
  } = options;
  const root = mkdtempSync(join(tmpdir(), "tlh wrapper resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = join(root, "rec");
  mkdirSync(record);
  const piCmd = join(root, "runtime", "bin", "pi");
  mkdirSync(dirname(piCmd), { recursive: true });
  writeFileSync(piCmd, stub("pi"), { mode: 0o755 });
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "node"), stub("node"), { mode: 0o755 });
  const wrapperPath = join(root, "wrapper-bin", wrapperName.includes("/") ? "tlh" : wrapperName);
  mkdirSync(dirname(wrapperPath), { recursive: true });
  let pkg = packageRoot ?? REPO_ROOT;
  if (missingPreload) {
    // Package root mirroring the real one (symlinks) minus the preload.
    pkg = join(root, "pkg with space");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "config"), join(pkg, "config"));
    for (const entry of readdirSync(join(REPO_ROOT, "scripts"))) {
      if (entry.startsWith("tlh-program-resume-preload")) continue;
      symlinkSync(join(REPO_ROOT, "scripts", entry), join(pkg, "scripts", entry));
    }
  }
  writeFileSync(
    wrapperPath,
    renderWrapper({
      agentDir: join(root, "agent"),
      binDir: dirname(wrapperPath),
      wrapperName,
      packageRoot: pkg,
      piCmd,
    }),
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TLH_TEST_RECORD_DIR: record,
  };
  for (const key of [
    "OSC7577_TOKEN",
    "TLH_PROGRAM_RESUME",
    "TLH_PROGRAM_RESUME_ACTIVE",
    "tlh_osc7577_stash",
    "TMUX",
    "STY",
    "ZELLIJ",
    "HERDR_ENV",
    "HERDR_PANE_ID",
  ]) {
    delete env[key];
  }
  Object.assign(env, extraEnv);
  let result;
  if (tty) {
    const bridge = [
      "import os, pty, subprocess, sys",
      "m, s = pty.openpty()",
      "p = subprocess.Popen(sys.argv[1:], stdin=s, stdout=s, stderr=subprocess.PIPE, close_fds=True)",
      "os.close(s)",
      "_, err = p.communicate()",
      "sys.stderr.write(err.decode())",
      "sys.exit(p.returncode)",
    ].join("\n");
    result = spawnSync("python3", ["-c", bridge, "bash", wrapperPath, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  } else {
    result = spawnSync("bash", [wrapperPath, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  const read = (name) => {
    const file = join(record, `${name}.txt`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  };
  return { result, node: read("node"), pi: read("pi"), root, piCmd };
}

export function parseRecord(text) {
  if (text === undefined) return undefined;
  const argv = /^ARGV:(.*)$/m.exec(text)?.[1] ?? "";
  const env = new Map();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) {
      env.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }
  return { argv, env, text };
}
