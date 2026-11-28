// Helpers for tests/program-resume-lifecycle.test.mjs: drives the real pinned Pi CLI under the tlh
// OSC 7577 preload inside a python3 pty bridge, with a faux model provider supplied by an extension.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findFrames, parseFrame, verifyFrame } from "../scripts/lib/program-resume-frame.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PRELOAD = join(REPO_ROOT, "scripts", "tlh-program-resume-preload.mjs");
export const PI_CLI = join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const PI_AI_INDEX = pathToFileURL(
  join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
).href;

export const hasPty = (() => {
  if (process.platform === "win32") return false;
  const result = spawnSync("python3", ["-c", "import pty, os; os.openpty()"], { stdio: "ignore" });
  return !result.error && result.status === 0;
})();

const OSC_SEQUENCE = new RegExp(String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`, "g");
const CSI_SEQUENCE = new RegExp(String.raw`\u001b\[[0-9;?<>=]*[ -/]*[@-~]`, "g");

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until truthy; throws with `what` after `timeoutMs`. */
export async function waitFor(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

// Spawns argv in a new session on a pty. Control lines on stdin: `W <hex>` writes bytes to the pty,
// `S <SIGNAME>` signals the child only, `K` kills its process group. Raw pty bytes go to stdout; stderr
// carries `PID <n>` and `EXIT <status>`. Terminal queries Pi sends at startup are answered like a
// terminal without kitty keyboard support, so Ctrl+Z / Ctrl+D arrive as plain control bytes.
const PTY_BRIDGE = String.raw`
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
QUERY = re.compile(rb"\x1b\[\?u|\x1b\[0?c|\x1b\[16t|\x1b\](?:(?:10|11);|4;(\d+);)\?(?:\x07|\x1b\\)")

def reply(m):
    t = m.group(0)
    if t.startswith(b"\x1b[?u"): return b"\x1b[?0u"
    if t.endswith(b"c"): return b"\x1b[?62;22c"
    if t.endswith(b"16t"): return b"\x1b[6;20;10t"
    if m.group(1) is not None: return b"\x1b]4;" + m.group(1) + b";rgb:8080/8080/8080\x1b\\"
    if t.startswith(b"\x1b]10;"): return b"\x1b]10;rgb:dddd/dddd/dddd\x1b\\"
    return b"\x1b]11;rgb:1111/1111/1111\x1b\\"

# The pty child is a session leader that runs Pi in its own foreground process group. Pi must not be in
# an orphaned process group, or the kernel discards SIGTSTP (Ctrl+Z) for it.
LEADER = """
import os, signal, sys
r, w = int(sys.argv[1]), int(sys.argv[2])
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.tcsetpgrp(0, os.getpid())
    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
    os.execvp(sys.argv[3], sys.argv[3:])
os.write(w, ("%d\\n" % pid).encode())
while True:
    _, status = os.waitpid(pid, os.WUNTRACED)
    if os.WIFSTOPPED(status):
        continue
    sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) or os.WIFSIGNALED(status) else 1)
"""

def preexec():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

pr, pw = os.pipe()
child = subprocess.Popen([sys.executable, "-c", LEADER, str(pr), str(pw)] + sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True, pass_fds=(pr, pw), preexec_fn=preexec)
os.close(slave)
os.close(pw)
node_pid = int(os.read(pr, 32).decode().strip())
sys.stderr.write("PID %d\n" % node_pid); sys.stderr.flush()
tail = b""
ctl = b""
stdin_open = True
exited = False
while True:
    fds = [master] + ([0] if stdin_open else [])
    ready, _, _ = select.select(fds, [], [], 0.05)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(1, data)
        buf = tail + data
        for m in QUERY.finditer(buf):
            if m.end() > len(tail):
                os.write(master, reply(m))
        tail = buf[-16:]
    if stdin_open and 0 in ready:
        chunk = os.read(0, 4096)
        if not chunk:
            stdin_open = False
        ctl += chunk
        while b"\n" in ctl:
            line, ctl = ctl.split(b"\n", 1)
            cmd, _, arg = line.decode().partition(" ")
            try:
                if cmd == "W": os.write(master, bytes.fromhex(arg))
                elif cmd == "S": os.kill(node_pid, getattr(signal, arg))
                elif cmd == "K":
                    os.killpg(node_pid, signal.SIGKILL)
                    os.killpg(child.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
    if child.poll() is not None and master not in ready:
        break
status = child.wait()
sys.stderr.write("EXIT %d\n" % status); sys.stderr.flush()
`;

// Faux provider extension (loaded from <agent>/extensions, never via -e). Replies depend on the last
// user message: BASHPLEASE:<file> makes the model call the bash tool (env > file) first.
const FAUX_EXTENSION = (markerDir) => `
import { appendFileSync } from "node:fs";
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import(${JSON.stringify(PI_AI_INDEX)});
const marker = (name) => appendFileSync(${JSON.stringify(join(markerDir, "events.log"))}, name + "\\n");
let n = 0;
export default function (pi) {
  const core = createFauxCore({ provider: "faux", models: [{ id: "fauxm", name: "fauxm", reasoning: false, input: ["text"] }] });
  const reply = (context) => {
    const last = context.messages[context.messages.length - 1];
    if (last && last.role === "toolResult") return fauxAssistantMessage(fauxText("FAUXTOOLDONE"));
    const text = JSON.stringify(last?.content ?? "");
    const bash = /BASHPLEASE:([^"\\s\\\\]+)/.exec(text);
    if (bash) return fauxAssistantMessage(fauxToolCall("bash", { command: "env > " + bash[1] }));
    n += 1;
    return fauxAssistantMessage(fauxText("FAUXREPLY" + n));
  };
  pi.registerProvider("faux", {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "faux-not-a-secret",
    api: core.api,
    models: [{ id: "fauxm", name: "fauxm", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model, context, options) => { core.appendResponses([reply]); return core.streamSimple(model, context, options); },
  });
  pi.on("session_start", () => marker("session_start"));
  pi.on("agent_end", () => marker("agent_end"));
}
`;

/** Real directory layout: <root>/agent (PI_CODING_AGENT_DIR), <root>/work (cwd), <root>/markers. */
export function createWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tlh-resume-lifecycle-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const markers = join(root, "markers");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(cwd);
  mkdirSync(markers);
  writeFileSync(join(agentDir, "extensions", "faux.js"), FAUX_EXTENSION(markers));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "faux",
      defaultModel: "fauxm",
      quietStartup: true,
      collapseChangelog: true,
      enableInstallTelemetry: false,
    }),
  );
  const sessionDir = join(
    agentDir,
    "sessions",
    `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  mkdirSync(sessionDir, { recursive: true });
  return {
    root,
    agentDir,
    cwd,
    markers,
    sessionDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Write a resumable session file for the workspace cwd; returns its uuid. */
export function writeFixtureSession(workspace, secondsAgo = 60) {
  const id = randomUUID();
  const stamp = new Date(Date.now() - secondsAgo * 1000).toISOString();
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const at = Date.parse(stamp);
  const user = (entryId, parentId, text) => ({
    type: "message",
    id: entryId,
    parentId,
    timestamp: stamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: at },
  });
  const assistant = (entryId, parentId, text) => ({
    type: "message",
    id: entryId,
    parentId,
    timestamp: stamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "faux",
      provider: "faux",
      model: "fauxm",
      usage,
      stopReason: "stop",
      timestamp: at,
    },
  });
  const entries = [
    { type: "session", version: 3, id, timestamp: stamp, cwd: workspace.cwd },
    user("aaaaaaa1", null, "FIXTUREPROMPTONE"),
    assistant("aaaaaaa2", "aaaaaaa1", "FIXTUREREPLYONE"),
    user("aaaaaaa3", "aaaaaaa2", "FIXTUREPROMPTTWO"),
    assistant("aaaaaaa4", "aaaaaaa3", "FIXTUREREPLYTWO"),
  ];
  writeFileSync(
    join(workspace.sessionDir, `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return id;
}

export const sessionFiles = (workspace) =>
  readdirSync(workspace.sessionDir).filter((name) => name.endsWith(".jsonl"));

export const readEvents = (workspace) => {
  const file = join(workspace.markers, "events.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

/** A running real Pi in a pty. Records raw bytes; `frames()` returns every complete OSC 7577 frame. */
export class PiPty {
  constructor(workspace, args, { env = {}, token = randomBytes(24).toString("hex") } = {}) {
    this.workspace = workspace;
    this.token = token;
    this.baselineEvents = readEvents(workspace).length;
    this.chunks = [];
    this.stderr = "";
    this.exit = undefined;
    this.pid = undefined;
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^(OSC7577|TLH_PROGRAM_RESUME|TMUX|STY|ZELLIJ|HERDR)/.test(key)) delete childEnv[key];
    }
    Object.assign(childEnv, {
      HOME: workspace.root,
      PI_CODING_AGENT_DIR: workspace.agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      TLH_SKIP_TELEMETRY: "1",
      TERM: "xterm-256color",
      OSC7577_TOKEN: token,
      TLH_PROGRAM_RESUME_ACTIVE: "1",
      TLH_RUNTIME_WRAPPER_NAME: "tlh",
      ...env,
    });
    delete childEnv.NODE_OPTIONS;
    this.proc = spawn(
      "python3",
      ["-c", PTY_BRIDGE, process.execPath, "--import", PRELOAD, PI_CLI, ...args],
      { cwd: workspace.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc.stdout.on("data", (chunk) => this.chunks.push(chunk));
    this.proc.stdin.on("error", () => {});
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      this.pid ??= Number(/PID (\d+)/.exec(this.stderr)?.[1]) || undefined;
      const status = /EXIT (-?\d+)/.exec(this.stderr)?.[1];
      if (status !== undefined) this.exit = Number(status);
    });
    this.closed = new Promise((resolve) => this.proc.once("close", resolve));
  }

  raw() {
    return Buffer.concat(this.chunks);
  }

  /** Visible-ish text: raw output with escape sequences removed. */
  text() {
    return this.raw().toString("latin1").replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "");
  }

  /** Every complete frame in output order, each parsed and tagged with real-token verification. */
  frames() {
    const text = this.raw().toString("latin1");
    return findFrames(text).map((location) => {
      const parsed = parseFrame(location.frame);
      const verified = parsed !== undefined && verifyFrame(parsed, this.token);
      return { start: location.start, raw: location.frame, parsed, verified };
    });
  }

  /** Real-token-verified frames only, as {kind, argv, cwd, pid}. */
  verified() {
    return this.frames()
      .filter((frame) => frame.verified)
      .map(({ parsed }) =>
        parsed.clear
          ? { kind: "clear", pid: Number(parsed.pid) }
          : { kind: "report", argv: parsed.argv, cwd: parsed.cwd, pid: Number(parsed.pid) },
      );
  }

  send(text) {
    this.proc.stdin.write(`W ${Buffer.from(text, "latin1").toString("hex")}\n`);
  }

  signal(name) {
    this.proc.stdin.write(`S ${name}\n`);
  }

  /** Wait until Pi's UI is up: the faux extension's session_start marker, or just output when extensions are off. */
  async ready({ extensions = true } = {}) {
    await waitFor(() => this.pid !== undefined, "pty bridge pid");
    if (extensions) {
      await waitFor(() => readEvents(this.workspace).length > this.baselineEvents, "session_start");
      await delay(400);
    } else {
      await waitFor(() => this.chunks.length > 0, "first output");
      await delay(1500);
    }
  }

  async type(text) {
    this.send(text);
    await delay(150);
    this.send("\r");
  }

  async waitForExit(timeoutMs = 15_000) {
    await waitFor(() => this.exit !== undefined, "pi exit", timeoutMs);
    await this.closed;
    return this.exit;
  }

  async dispose() {
    if (this.exit === undefined) {
      this.proc.stdin.write("K\n");
      await Promise.race([this.closed, delay(3000)]);
    }
    this.proc.stdin.end();
    this.proc.kill("SIGKILL");
  }

  /** Process title as the OS reports it for the Pi process. */
  psArgs() {
    const result = spawnSync("ps", ["-o", "args=", "-p", String(this.pid)], { encoding: "utf8" });
    return result.stdout.trim();
  }
}
