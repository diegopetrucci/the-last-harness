import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
export class QuietGlimpseWindowImpl extends EventEmitter {
    #proc;
    #closed = false;
    #pendingHTML;
    #stderr = "";
    constructor(proc, initialHTML) {
        super();
        this.#proc = proc;
        this.#pendingHTML = initialHTML;
        proc.stdin.on("error", () => { });
        proc.stderr.on("data", (chunk) => {
            this.#stderr += chunk.toString();
        });
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                this.emit("error", new Error(`Malformed glimpse protocol line: ${line}`));
                return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
                return;
            const message = parsed;
            switch (message.type) {
                case "ready":
                    if (this.#pendingHTML != null) {
                        this.setHTML(this.#pendingHTML);
                        this.#pendingHTML = null;
                    }
                    break;
                case "message":
                    this.emit("message", message.data);
                    break;
                case "closed":
                    this.#markClosed();
                    break;
                default:
                    break;
            }
        });
        proc.on("error", (error) => this.emit("error", error));
        proc.on("exit", (code, signal) => {
            const stderr = this.#stderr.trim();
            const failed = signal != null || (code != null && code !== 0);
            if (!this.#closed && failed) {
                const message = stderr || `Glimpse process exited abnormally (code: ${code}, signal: ${signal}).`;
                this.emit("error", new Error(message));
            }
            this.#markClosed();
        });
    }
    send(js) {
        this.#write({ type: "eval", js });
    }
    close() {
        this.#write({ type: "close" });
    }
    #markClosed() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.emit("closed");
    }
    #write(obj) {
        if (this.#closed)
            return;
        this.#proc.stdin.write(`${JSON.stringify(obj)}\n`);
    }
    setHTML(html) {
        this.#write({ type: "html", html: Buffer.from(html).toString("base64") });
    }
}
function isNativeHostInfo(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    if (!("path" in value) || typeof value.path !== "string") {
        return false;
    }
    if ("extraArgs" in value &&
        value.extraArgs !== undefined &&
        (!Array.isArray(value.extraArgs) ||
            !value.extraArgs.every((entry) => typeof entry === "string"))) {
        return false;
    }
    return !("buildHint" in value &&
        value.buildHint !== undefined &&
        typeof value.buildHint !== "string");
}
function readNativeHostInfo(module) {
    if (module === null ||
        typeof module !== "object" ||
        Array.isArray(module) ||
        !("getNativeHostInfo" in module) ||
        typeof module.getNativeHostInfo !== "function") {
        throw new Error("Glimpse module does not expose getNativeHostInfo().");
    }
    const host = module.getNativeHostInfo();
    if (!isNativeHostInfo(host)) {
        throw new Error("Glimpse module returned an invalid native host description.");
    }
    return host;
}
async function getNativeHostInfo() {
    const glimpseModule = await import("glimpseui");
    return readNativeHostInfo(glimpseModule);
}
export async function openQuietGlimpse(html, options = {}) {
    const host = await getNativeHostInfo();
    if (!existsSync(host.path)) {
        const hint = host.buildHint ? ` ${host.buildHint}` : "";
        throw new Error(`Glimpse host not found at '${host.path}'.${hint}`);
    }
    const args = [];
    if (options.width != null)
        args.push("--width", String(options.width));
    if (options.height != null)
        args.push("--height", String(options.height));
    if (options.title != null)
        args.push("--title", options.title);
    if (options.frameless)
        args.push("--frameless");
    if (options.floating)
        args.push("--floating");
    if (options.transparent)
        args.push("--transparent");
    if (options.clickThrough)
        args.push("--click-through");
    if (options.hidden)
        args.push("--hidden");
    if (options.autoClose)
        args.push("--auto-close");
    if (options.x != null)
        args.push(`--x=${options.x}`);
    if (options.y != null)
        args.push(`--y=${options.y}`);
    if (options.cursorOffset?.x != null)
        args.push(`--cursor-offset-x=${options.cursorOffset.x}`);
    if (options.cursorOffset?.y != null)
        args.push(`--cursor-offset-y=${options.cursorOffset.y}`);
    if (options.cursorAnchor != null)
        args.push("--cursor-anchor", options.cursorAnchor);
    if (options.followMode != null)
        args.push("--follow-mode", options.followMode);
    if (options.followCursor)
        args.push("--follow-cursor");
    const proc = spawn(host.path, [...(host.extraArgs ?? []), ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: process.platform === "win32",
        env: {
            ...process.env,
            OS_ACTIVITY_MODE: process.env.OS_ACTIVITY_MODE ?? "disable",
        },
    });
    return new QuietGlimpseWindowImpl(proc, html);
}
