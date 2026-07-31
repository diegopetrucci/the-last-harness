#!/usr/bin/env node
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathIsProtectedPiConfig, } from "./lib/tlh-install-paths.mjs";
import { assignOptionValue, defaultTlhAgentDir, defaultTlhBinDir, expandHomePath, } from "./lib/tlh-install-utils.mjs";
const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const DEFAULT_WRAPPER_NAME = "tlh";
const VALID_TRACKS = new Set(["latest-release", "pinned-tag", "ref", "custom"]);
const DOWNLOAD_TIMEOUT_MS = 30_000;
const PACKAGE_UPDATE_ARGS = ["update", "--extensions"];
const PACKAGE_UPDATE_UNSUPPORTED_OPTIONS = [
    ["track", "--track"],
    ["ref", "--ref"],
    ["repo", "--repo"],
    ["packageSource", "--package-source"],
    ["force", "--force"],
    ["noSettings", "--no-settings"],
    ["noWrapper", "--no-wrapper"],
];
function usage() {
    return `Usage: tlh update [options]

Run The Last Harness installer update flow for the current isolated profile.
Upstream Pi is installed into a private TLH runtime at ~/.the-last-harness/runtime by the installer when needed.

Options:
  --agent-dir DIR       Isolated profile dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR         Wrapper install dir (default: ~/.local/bin)
  --wrapper-name NAME   Wrapper command name (default: tlh)
  --extensions          Update isolated extensions/packages only via pi update --extensions
  --track TRACK         Override update track: latest-release, pinned-tag, ref, custom
  --ref REF             Override git ref/tag for pinned-tag or ref tracks
  --repo OWNER/REPO     Override GitHub repository
  --package-source SRC  Preserve a custom package source via TLH_PACKAGE_SOURCE
  --dry-run             Print the update plan without downloading or running installer
  --force               Pass --force to the installer
  --no-settings         Pass --no-settings to the installer
  --no-wrapper          Pass --no-wrapper to the installer
  --quiet               Suppress installer progress output
  --verbose             Show underlying installer output
  -h, --help            Show this help
`;
}
function parseArgs(argv) {
    const args = {
        agentDir: defaultTlhAgentDir(process.env, { preferTlhAgentDir: true }),
        binDir: defaultTlhBinDir(process.env),
        wrapperName: process.env.TLH_WRAPPER_NAME || DEFAULT_WRAPPER_NAME,
        repo: process.env.TLH_REPO,
        track: undefined,
        ref: undefined,
        packageSource: process.env.TLH_PACKAGE_SOURCE,
        explicitOptions: new Set(),
        dryRun: false,
        extensions: false,
        force: false,
        noSettings: false,
        noWrapper: false,
        quiet: false,
        verbose: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help") {
            args.help = true;
            continue;
        }
        if (arg === "--dry-run") {
            args.dryRun = true;
            args.explicitOptions.add("dryRun");
            continue;
        }
        if (arg === "--extensions") {
            args.extensions = true;
            args.explicitOptions.add("extensions");
            continue;
        }
        if (arg === "--force") {
            args.force = true;
            args.explicitOptions.add("force");
            continue;
        }
        if (arg === "--no-settings") {
            args.noSettings = true;
            args.explicitOptions.add("noSettings");
            continue;
        }
        if (arg === "--no-wrapper") {
            args.noWrapper = true;
            args.explicitOptions.add("noWrapper");
            continue;
        }
        if (arg === "--quiet") {
            args.quiet = true;
            args.verbose = false;
            continue;
        }
        if (arg === "--verbose") {
            args.verbose = true;
            args.quiet = false;
            continue;
        }
        const agentDirIndex = assignOptionValue(args, "agentDir", argv, i, "--agent-dir");
        if (agentDirIndex !== undefined) {
            args.explicitOptions.add("agentDir");
            i = agentDirIndex;
            continue;
        }
        const binDirIndex = assignOptionValue(args, "binDir", argv, i, "--bin-dir");
        if (binDirIndex !== undefined) {
            args.explicitOptions.add("binDir");
            i = binDirIndex;
            continue;
        }
        const wrapperNameIndex = assignOptionValue(args, "wrapperName", argv, i, "--wrapper-name");
        if (wrapperNameIndex !== undefined) {
            args.explicitOptions.add("wrapperName");
            i = wrapperNameIndex;
            continue;
        }
        const trackIndex = assignOptionValue(args, "track", argv, i, "--track");
        if (trackIndex !== undefined) {
            args.explicitOptions.add("track");
            i = trackIndex;
            continue;
        }
        const refIndex = assignOptionValue(args, "ref", argv, i, "--ref");
        if (refIndex !== undefined) {
            args.explicitOptions.add("ref");
            i = refIndex;
            continue;
        }
        const repoIndex = assignOptionValue(args, "repo", argv, i, "--repo");
        if (repoIndex !== undefined) {
            args.explicitOptions.add("repo");
            i = repoIndex;
            continue;
        }
        const packageSourceIndex = assignOptionValue(args, "packageSource", argv, i, "--package-source");
        if (packageSourceIndex !== undefined) {
            args.explicitOptions.add("packageSource");
            i = packageSourceIndex;
            continue;
        }
        throw new Error(`Unknown option for tlh update: ${arg}`);
    }
    args.agentDir = expandHomePath(args.agentDir) || args.agentDir;
    args.binDir = expandHomePath(args.binDir) || args.binDir;
    return args;
}
function isTruthyEnv(value) {
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
function isSemverTag(ref) {
    return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref);
}
function installStatePath(agentDir) {
    return join(agentDir, "tlh", "install-state.json");
}
function settingsPath(agentDir) {
    return join(agentDir, "settings.json");
}
function realpathIfPossible(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return undefined;
    }
}
function sanitizedPath(pathValue, agentDir) {
    if (pathValue === undefined)
        return "";
    const cwd = resolve(process.cwd());
    const cwdRealpath = realpathIfPossible(cwd);
    const managedBin = resolve(agentDir, "bin");
    const managedBinRealpath = realpathIfPossible(managedBin);
    return String(pathValue)
        .split(delimiter)
        .filter((entry) => {
        if (!entry)
            return false;
        const resolvedEntry = resolve(entry);
        if (resolvedEntry === cwd || resolvedEntry === managedBin)
            return false;
        const entryRealpath = realpathIfPossible(resolvedEntry);
        if (entryRealpath && cwdRealpath && entryRealpath === cwdRealpath)
            return false;
        if (entryRealpath && managedBinRealpath && entryRealpath === managedBinRealpath)
            return false;
        return true;
    })
        .join(delimiter);
}
function envWithSanitizedPath(baseEnv, agentDir) {
    return {
        ...baseEnv,
        PATH: sanitizedPath(baseEnv.PATH, agentDir),
    };
}
function isExecutable(path) {
    try {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function resolveCommand(command, env) {
    const pathValue = env.PATH || "";
    for (const entry of pathValue.split(delimiter)) {
        if (!entry)
            continue;
        const candidate = resolve(entry, command);
        if (isExecutable(candidate))
            return candidate;
    }
    throw new Error(`required command not found on sanitized PATH: ${command}`);
}
function readJson(path) {
    // Keep update metadata/settings parsing strict so existing diagnostics stay unchanged.
    const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(content);
}
function packageSourceOf(entry) {
    if (typeof entry === "string")
        return entry;
    if (entry && typeof entry === "object" && typeof entry.source === "string") {
        return entry.source;
    }
    return undefined;
}
function splitRefFromPath(path) {
    const hashIndex = path.lastIndexOf("#");
    const atIndex = path.lastIndexOf("@");
    const refIndex = Math.max(hashIndex, atIndex);
    if (refIndex === -1) {
        return { path, ref: undefined };
    }
    const repoPath = path.slice(0, refIndex);
    const ref = path.slice(refIndex + 1);
    if (!repoPath || !ref) {
        return { path, ref: undefined };
    }
    return { path: repoPath, ref };
}
function parseGitHubPackageSource(source) {
    if (typeof source !== "string")
        return undefined;
    let value = source.trim();
    if (!value)
        return undefined;
    if (value.startsWith("git:"))
        value = value.slice("git:".length).trim();
    if (value.startsWith("git+"))
        value = value.slice("git+".length);
    let host;
    let repoPathWithRef;
    const scpLike = value.match(/^git@([^:]+):(.+)$/);
    if (scpLike) {
        host = scpLike[1] || "";
        repoPathWithRef = scpLike[2] || "";
    }
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            host = parsed.hostname;
            repoPathWithRef = parsed.pathname.replace(/^\/+/, "");
            if (parsed.hash && !repoPathWithRef.includes("#")) {
                repoPathWithRef = `${repoPathWithRef}${parsed.hash}`;
            }
        }
        catch {
            return undefined;
        }
    }
    else {
        const slashIndex = value.indexOf("/");
        if (slashIndex === -1)
            return undefined;
        host = value.slice(0, slashIndex);
        repoPathWithRef = value.slice(slashIndex + 1);
    }
    if (host !== "github.com")
        return undefined;
    const split = splitRefFromPath(repoPathWithRef);
    const repoPath = split.path.replace(/\.git$/, "").replace(/^\/+/, "");
    const segments = repoPath.split("/").filter(Boolean);
    if (segments.length < 2)
        return undefined;
    return {
        repo: `${segments[0]}/${segments[1]}`,
        ref: split.ref,
    };
}
function trackForPackageRef(ref) {
    if (!ref)
        return "ref";
    return isSemverTag(ref) ? "pinned-tag" : "ref";
}
function normalizeState(raw, fallback = {}) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const record = raw;
    const repo = typeof record.repo === "string" && record.repo.trim() ? record.repo.trim() : fallback.repo;
    const track = typeof record.track === "string" && record.track.trim() ? record.track.trim() : fallback.track;
    const ref = typeof record.ref === "string" && record.ref.trim() ? record.ref.trim() : fallback.ref;
    const packageSource = typeof record.packageSource === "string" && record.packageSource.trim() ? record.packageSource.trim() : fallback.packageSource;
    if (!repo || !track || !VALID_TRACKS.has(track))
        return undefined;
    return {
        schemaVersion: Number.isInteger(record.schemaVersion) ? record.schemaVersion : undefined,
        repo,
        track,
        ref,
        packageSource,
        packageSourceIsDefault: record.packageSourceIsDefault === true,
        inferred: record.inferred === true,
        // Carry piInstalledByTlh only when it is a boolean; absent in older install-states.
        ...(typeof record.piInstalledByTlh === "boolean" && { piInstalledByTlh: record.piInstalledByTlh }),
    };
}
function inferStateFromSettings(agentDir, requestedRepo) {
    const path = settingsPath(agentDir);
    if (!existsSync(path))
        return undefined;
    const settings = readJson(path);
    if (!settings || typeof settings !== "object" || !Array.isArray(settings.packages)) {
        return undefined;
    }
    let fallback;
    for (const entry of settings.packages) {
        const source = packageSourceOf(entry);
        const parsed = parseGitHubPackageSource(source);
        if (!parsed)
            continue;
        const candidate = {
            schemaVersion: 1,
            repo: parsed.repo,
            track: trackForPackageRef(parsed.ref),
            ref: parsed.ref || "main",
            packageSource: source,
            packageSourceIsDefault: parsed.repo === DEFAULT_REPO,
            inferred: true,
        };
        if (requestedRepo && parsed.repo === requestedRepo)
            return candidate;
        if (parsed.repo === DEFAULT_REPO)
            return candidate;
        if (!fallback && parsed.repo.endsWith("/the-last-harness"))
            fallback = candidate;
    }
    return fallback;
}
function loadState(args) {
    const path = installStatePath(args.agentDir);
    if (existsSync(path)) {
        try {
            const state = normalizeState(readJson(path));
            if (state)
                return state;
        }
        catch (error) {
            if (!args.quiet) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`warning: could not read ${path}: ${message}`);
            }
        }
    }
    const inferred = inferStateFromSettings(args.agentDir, args.repo);
    if (inferred)
        return inferred;
    return undefined;
}
function encodePathRef(ref) {
    return ref.split("/").map((part) => encodeURIComponent(part)).join("/");
}
function resolvePlan(state, args) {
    const repo = args.repo || state?.repo || DEFAULT_REPO;
    const track = args.track || state?.track;
    const ref = args.ref || state?.ref;
    const packageSource = args.packageSource || state?.packageSource;
    const packageSourceIsDefault = args.packageSource ? false : state?.packageSourceIsDefault === true;
    const changesStoredCustomTarget = state?.packageSourceIsDefault === false &&
        !args.packageSource &&
        ((args.ref && args.ref !== state.ref) || (args.repo && args.repo !== state.repo) || (args.track && args.track !== state.track));
    if (changesStoredCustomTarget) {
        throw new Error("This install uses a custom package source. Pass --package-source with any --track, --repo, or --ref override so package code and update metadata stay aligned.");
    }
    if (!track || !VALID_TRACKS.has(track)) {
        throw new Error("Could not determine update track. Re-run the installer with --track latest-release, --track pinned-tag, or --track ref.");
    }
    if (track === "custom") {
        throw new Error("This install is marked as a custom update track. Re-run the appropriate installer command manually, or run tlh update with --track, --ref, and --package-source overrides.");
    }
    if ((track === "pinned-tag" || track === "ref") && !ref) {
        throw new Error(`Update track '${track}' requires a ref. Pass --ref <ref>.`);
    }
    const requiredRef = ref;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error(`Unsupported GitHub repo value: ${repo}`);
    }
    if (track === "latest-release") {
        return {
            repo,
            track,
            ref: undefined,
            packageSource,
            packageSourceIsDefault,
            url: `https://github.com/${repo}/releases/latest/download/install.sh`,
        };
    }
    if (track === "pinned-tag") {
        return {
            repo,
            track,
            ref: requiredRef,
            packageSource,
            packageSourceIsDefault,
            url: `https://github.com/${repo}/releases/download/${encodeURIComponent(requiredRef)}/install.sh`,
        };
    }
    return {
        repo,
        track,
        ref: requiredRef,
        packageSource,
        packageSourceIsDefault,
        url: `https://raw.githubusercontent.com/${repo}/${encodePathRef(requiredRef)}/install.sh`,
    };
}
function buildInstallerArgs(plan, args, state) {
    const installerArgs = [
        "--agent-dir",
        args.agentDir,
        "--bin-dir",
        args.binDir,
        "--wrapper-name",
        args.wrapperName,
        "--track",
        plan.track,
    ];
    if (plan.track === "pinned-tag" || plan.track === "ref") {
        if (!plan.ref)
            throw new Error(`Update track '${plan.track}' requires a ref.`);
        installerArgs.push("--ref", plan.ref);
    }
    if (args.force)
        installerArgs.push("--force");
    if (args.noSettings)
        installerArgs.push("--no-settings");
    if (args.noWrapper)
        installerArgs.push("--no-wrapper");
    if (args.quiet)
        installerArgs.push("--quiet");
    if (args.verbose)
        installerArgs.push("--verbose");
    // Preserve piInstalledByTlh from the existing install-state so the update does not
    // reinvent or clear a value that was set during the original install. When absent in the
    // prior state (older installs), omit the flag; the installer itself will still record true
    // if this update run has to install Pi.
    if (typeof state?.piInstalledByTlh === "boolean") {
        installerArgs.push("--pi-installed-by-tlh", String(state.piInstalledByTlh));
    }
    return installerArgs;
}
function shellQuote(value) {
    // Keep this dry-run rendering style stable for existing update command output.
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
function printDryRun(plan, installerArgs, env) {
    console.log("The Last Harness update plan");
    console.log(`Track: ${plan.track}${plan.ref ? ` (${plan.ref})` : ""}`);
    console.log(`Installer: ${plan.url}`);
    if (env.TLH_PACKAGE_SOURCE) {
        console.log(`Package source: ${env.TLH_PACKAGE_SOURCE}`);
    }
    const envParts = [];
    if (env.TLH_REPO)
        envParts.push(`TLH_REPO=${shellQuote(env.TLH_REPO)}`);
    if (env.TLH_PACKAGE_SOURCE)
        envParts.push(`TLH_PACKAGE_SOURCE=${shellQuote(env.TLH_PACKAGE_SOURCE)}`);
    const prefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
    console.log(`Would run: ${prefix}bash <downloaded install.sh> ${installerArgs.map(shellQuote).join(" ")}`);
}
function assertPackageUpdateTargetSafe(agentDir) {
    if (pathIsProtectedPiConfig(agentDir)) {
        throw new Error(`refusing to run The Last Harness extension update against normal Pi config root: ${agentDir}`);
    }
}
function assertPackageUpdateArgs(args) {
    const unsupported = PACKAGE_UPDATE_UNSUPPORTED_OPTIONS
        .filter(([key]) => args.explicitOptions.has(key))
        .map(([, flag]) => flag);
    if (unsupported.length > 0) {
        throw new Error(`--extensions does not support ${unsupported.join(", ")}. Run plain tlh update for installer updates.`);
    }
}
function printPackageUpdateDryRun(piCommand, args) {
    console.log("The Last Harness extension update plan");
    console.log(`Agent dir: ${args.agentDir}`);
    console.log(`Would run: PI_CODING_AGENT_DIR=${shellQuote(args.agentDir)} ${shellQuote(piCommand)} ${PACKAGE_UPDATE_ARGS.map(shellQuote).join(" ")}`);
}
function runPackageUpdate(args) {
    assertPackageUpdateTargetSafe(args.agentDir);
    assertPackageUpdateArgs(args);
    const sanitizedEnv = envWithSanitizedPath(process.env, args.agentDir);
    // Always use the absolute private TLH runtime pi binary rather than resolving
    // "pi" by name from PATH — identical logic to tlh-recover-update.mjs.
    const piCommand = join(dirname(args.agentDir), "runtime", "bin", "pi");
    if (args.dryRun) {
        printPackageUpdateDryRun(piCommand, args);
        return;
    }
    if (!existsSync(piCommand)) {
        throw new Error(`The Last Harness private runtime pi not found at ${piCommand}. Run \`tlh update\` (without --extensions) to repair the private runtime.`);
    }
    if (isTruthyEnv(process.env.PI_OFFLINE)) {
        throw new Error("PI_OFFLINE is set; refusing to run a network update.");
    }
    if (!args.quiet) {
        console.log("Updating The Last Harness isolated extensions...");
        if (args.verbose)
            console.log(`Pi: ${piCommand}`);
    }
    const result = spawnSync(piCommand, [...PACKAGE_UPDATE_ARGS], {
        stdio: "inherit",
        env: {
            ...sanitizedEnv,
            PI_CODING_AGENT_DIR: args.agentDir,
        },
    });
    if (result.error) {
        throw result.error;
    }
    const exitCode = result.status ?? (result.signal ? 1 : 0);
    if (exitCode !== 0) {
        process.exitCode = exitCode;
        return;
    }
    process.exitCode = 0;
}
async function downloadInstaller(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "text/x-shellscript,text/plain,*/*",
            "User-Agent": "tlh-update",
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`failed to download installer (${response.status} ${response.statusText}): ${url}`);
    }
    const content = await response.text();
    if (!content.trim()) {
        throw new Error(`downloaded installer was empty: ${url}`);
    }
    const dir = mkdtempSync(join(tmpdir(), "tlh-update-"));
    const installerPath = join(dir, "install.sh");
    writeFileSync(installerPath, content, "utf8");
    chmodSync(installerPath, 0o700);
    return { dir, installerPath };
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(usage());
        return;
    }
    if (args.extensions) {
        runPackageUpdate(args);
        return;
    }
    if (args.track && !VALID_TRACKS.has(args.track)) {
        throw new Error(`Invalid --track value: ${args.track}`);
    }
    const state = loadState(args);
    const plan = resolvePlan(state, args);
    const installerArgs = buildInstallerArgs(plan, args, state);
    const sanitizedEnv = envWithSanitizedPath(process.env, args.agentDir);
    const childEnv = {
        ...sanitizedEnv,
        TLH_REPO: plan.repo,
    };
    delete childEnv.TLH_REF;
    delete childEnv.TLH_RAW_BASE;
    delete childEnv.TLH_UPDATE_TRACK;
    if (plan.packageSource && !plan.packageSourceIsDefault) {
        childEnv.TLH_PACKAGE_SOURCE = plan.packageSource;
    }
    else if (args.packageSource) {
        childEnv.TLH_PACKAGE_SOURCE = args.packageSource;
    }
    if (args.dryRun) {
        printDryRun(plan, installerArgs, childEnv);
        return;
    }
    if (isTruthyEnv(process.env.PI_OFFLINE)) {
        throw new Error("PI_OFFLINE is set; refusing to run a network update.");
    }
    if (!args.quiet) {
        const refLabel = plan.ref ? ` (${plan.ref})` : "";
        console.log(`Updating The Last Harness via ${plan.track}${refLabel}...`);
        if (args.verbose)
            console.log(`Installer: ${plan.url}`);
    }
    let temp;
    try {
        temp = await downloadInstaller(plan.url);
        const bashCommand = resolveCommand("bash", sanitizedEnv);
        const result = spawnSync(bashCommand, [temp.installerPath, ...installerArgs], {
            stdio: "inherit",
            env: childEnv,
        });
        if (result.error) {
            throw result.error;
        }
        process.exitCode = result.status ?? (result.signal ? 1 : 0);
    }
    finally {
        if (temp?.dir) {
            rmSync(temp.dir, { recursive: true, force: true });
        }
    }
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
});
