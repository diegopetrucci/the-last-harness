import { spawnSync } from "node:child_process";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { expandHomePath } from "./common.js";
const TK_VALIDATION_TIMEOUT_MS = 5000;
let autoScopedTicketsDir;
let autoScopedCwd;
function configuredTicketInstallPath(config) {
    const installPath = config?.installPath;
    if (typeof installPath !== "string" || !installPath.trim()) {
        return undefined;
    }
    return resolve(expandHomePath(installPath.trim()));
}
function uniqueTicketCandidates(candidates) {
    const seen = new Set();
    const unique = [];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const key = candidate === "tk" ? candidate : resolve(candidate);
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(candidate);
    }
    return unique;
}
function ticketCommandCandidates(settings, agentDir) {
    const agentRoot = resolve(expandHomePath(agentDir));
    return uniqueTicketCandidates([
        configuredTicketInstallPath(settings.tlh?.tickets),
        join(agentRoot, "bin", "tk"),
        "tk",
    ]);
}
function hasTkCommandName(candidate) {
    return candidate === "tk" || basename(candidate) === "tk";
}
function validateTlhTicketCommand(command) {
    const result = spawnSync(command, ["help"], {
        encoding: "utf8",
        timeout: TK_VALIDATION_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0)
        return false;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return /Usage:\s+tk\b/.test(output) && /ticket/i.test(output);
}
function prependProcessPath(dir) {
    const currentPath = process.env.PATH || "";
    const entries = currentPath
        .split(delimiter)
        .filter(Boolean)
        .filter((entry) => entry !== dir);
    process.env.PATH = [dir, ...entries].join(delimiter);
}
function resolveGitWorktreeRoot(cwd) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        timeout: TK_VALIDATION_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
        return undefined;
    }
    const root = (result.stdout || "").trim();
    return root ? resolve(root) : undefined;
}
function resolveDefaultTicketsDir(cwd) {
    return join(resolveGitWorktreeRoot(cwd) ?? resolve(cwd), ".tickets");
}
export function activateTlhTicketSessionScope(cwd) {
    const normalizedCwd = resolve(cwd);
    const current = process.env.TICKETS_DIR?.trim();
    if (current) {
        const currentIsAutoScoped = current === autoScopedTicketsDir;
        if (!currentIsAutoScoped) {
            return current;
        }
        if (normalizedCwd === autoScopedCwd) {
            return current;
        }
    }
    const scopedDir = resolveDefaultTicketsDir(normalizedCwd);
    process.env.TICKETS_DIR = scopedDir;
    autoScopedTicketsDir = scopedDir;
    autoScopedCwd = normalizedCwd;
    return scopedDir;
}
export function findValidTlhTicketCommand(settings, agentDir, options = {}) {
    for (const candidate of ticketCommandCandidates(settings, agentDir)) {
        if (!hasTkCommandName(candidate))
            continue;
        if (!validateTlhTicketCommand(candidate))
            continue;
        if (options.prependPath && candidate !== "tk") {
            prependProcessPath(dirname(candidate));
        }
        return candidate;
    }
    return undefined;
}
export function activateTlhTicketRuntime(settings, agentDir, cwd) {
    if (cwd) {
        activateTlhTicketSessionScope(cwd);
    }
    return findValidTlhTicketCommand(settings, agentDir, { prependPath: true });
}
