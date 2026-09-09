import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
const PROCESS_TERM_GRACE_MS = 1500;
const PROCESS_KILL_GRACE_MS = 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const PYTHON_PTY_BRIDGE = String.raw `
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time

READ_TIMEOUT_SECONDS = 0.05
TERM_GRACE_SECONDS = 0.6
KILL_GRACE_SECONDS = 0.2

if len(sys.argv) < 2:
    print("error: missing PTY command", file=sys.stderr)
    raise SystemExit(2)

master_fd, slave_fd = pty.openpty()
child = None
termination_requested = False


def request_termination(_signum, _frame):
    global termination_requested
    termination_requested = True


def write_stdout(data):
    pending = memoryview(data)
    while pending:
        try:
            written = os.write(sys.stdout.fileno(), pending)
        except BrokenPipeError:
            return False
        if written <= 0:
            return False
        pending = pending[written:]
    return True


def stop_child():
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
    except ProcessLookupError:
        return
    deadline = time.monotonic() + TERM_GRACE_SECONDS
    while child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if child.poll() is None:
        try:
            child.kill()
        except ProcessLookupError:
            return
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)


try:
    signal.signal(signal.SIGTERM, request_termination)
    signal.signal(signal.SIGINT, request_termination)
    child = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)
    slave_fd = None

    while not termination_requested:
        try:
            ready, _, _ = select.select([master_fd], [], [], READ_TIMEOUT_SECONDS)
        except InterruptedError:
            ready = []
        if master_fd in ready:
            try:
                data = os.read(master_fd, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    data = b""
                else:
                    raise
            if not data or not write_stdout(data):
                break
        if child.poll() is not None and master_fd not in ready:
            break
finally:
    stop_child()
    if slave_fd is not None:
        try:
            os.close(slave_fd)
        except OSError:
            pass
    try:
        os.close(master_fd)
    except OSError:
        pass

if child is not None and child.returncode is not None:
    raise SystemExit(128 + abs(child.returncode) if child.returncode < 0 else child.returncode)
`;
function appendCapture(current, chunk) {
    if (current.length >= MAX_CAPTURE_BYTES)
        return current;
    const remaining = MAX_CAPTURE_BYTES - current.length;
    if (chunk.length <= remaining)
        return current + chunk;
    return `${current}${chunk.slice(0, remaining)}\n[output truncated]`;
}
function processExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}
function processGroupExists(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error) {
            if (error.code === "ESRCH")
                return false;
            if (error.code === "EPERM")
                return true;
        }
        return false;
    }
}
function sendProcessSignal(child, signal) {
    const pid = child.pid;
    if (pid && pid > 0) {
        try {
            process.kill(-pid, signal);
            return;
        }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
                // The direct child may be exiting after its group disappeared.
            }
        }
    }
    if (!processExited(child)) {
        try {
            child.kill(signal);
        }
        catch { }
    }
}
function waitForProcessTreeGone(child, timeoutMs) {
    return new Promise((resolvePromise) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            const directGone = processExited(child);
            const groupGone = !processGroupExists(child.pid);
            if (directGone && groupGone) {
                resolvePromise(true);
                return;
            }
            if (Date.now() >= deadline) {
                resolvePromise(false);
                return;
            }
            setTimeout(check, 25);
        };
        check();
    });
}
export async function stopProcessTree(child, initialSignal = "SIGTERM") {
    if (!processExited(child) || processGroupExists(child.pid)) {
        sendProcessSignal(child, initialSignal);
        if (await waitForProcessTreeGone(child, PROCESS_TERM_GRACE_MS))
            return;
        sendProcessSignal(child, "SIGKILL");
        await waitForProcessTreeGone(child, PROCESS_KILL_GRACE_MS);
    }
}
export async function runProcess(command, args, options) {
    const startedAt = performance.now();
    let child;
    try {
        child = spawn(command, [...args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        });
    }
    catch (error) {
        return {
            command,
            args: [...args],
            code: null,
            signal: null,
            stdout: "",
            stderr: "",
            elapsedMs: performance.now() - startedAt,
            timedOut: false,
            stoppedByCondition: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stoppedByCondition = false;
    let stopPromise;
    let spawnError;
    const closePromise = new Promise((resolvePromise) => {
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
        child.once("error", (error) => {
            spawnError = error instanceof Error ? error.message : String(error);
        });
    });
    const requestStop = (signal) => {
        if (!stopPromise)
            stopPromise = stopProcessTree(child, signal);
        return stopPromise;
    };
    const unregisterStop = options.registerStop?.(() => requestStop("SIGTERM"));
    const consume = (stream, chunk) => {
        const text = chunk.toString();
        if (stream === "stdout")
            stdout = appendCapture(stdout, text);
        else
            stderr = appendCapture(stderr, text);
        try {
            if (options.onOutput?.(text, stream, performance.now() - startedAt)) {
                stoppedByCondition = true;
                void requestStop("SIGTERM");
            }
        }
        catch (error) {
            stderr = appendCapture(stderr, `\nobserver error: ${error instanceof Error ? error.message : String(error)}\n`);
            stoppedByCondition = true;
            void requestStop("SIGTERM");
        }
    };
    child.stdout?.on("data", (chunk) => consume("stdout", chunk));
    child.stderr?.on("data", (chunk) => consume("stderr", chunk));
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        void requestStop("SIGTERM");
    }, options.timeoutMs);
    const close = await closePromise;
    clearTimeout(timeoutHandle);
    if (!stopPromise && (close.code !== 0 || close.signal !== null)) {
        stopPromise = stopProcessTree(child, "SIGTERM");
    }
    await stopPromise;
    unregisterStop?.();
    return {
        command,
        args: [...args],
        code: close.code,
        signal: close.signal,
        stdout,
        stderr,
        elapsedMs: performance.now() - startedAt,
        timedOut,
        stoppedByCondition,
        error: spawnError,
    };
}
function commandExists(command) {
    const result = spawnSync(command, ["-c", "pass"], { stdio: "ignore", timeout: 2_000 });
    return !result.error && result.status === 0;
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function buildPtyCommand(commandParts) {
    if (process.platform === "win32")
        throw new Error("installer performance launch requires a Unix-like PTY");
    if (commandExists("python3")) {
        return { command: "python3", args: ["-c", PYTHON_PTY_BRIDGE, ...commandParts] };
    }
    if (["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
        return { command: "script", args: ["-q", "/dev/null", ...commandParts] };
    }
    return {
        command: "script",
        args: ["-q", "-e", "-c", commandParts.map(shellQuote).join(" "), "/dev/null"],
    };
}
