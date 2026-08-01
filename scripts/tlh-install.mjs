#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { criticalGitSourceSpec, packageSourceInstallDir, packageSourcePiSource, } from "./lib/tlh-install-package-source.mjs";
import { assertProfilePathWithinAgent, assertSafeSettingsTarget, copySafeProfileFile, ensureSafeProfileDir, isSymlink, validateInstallerTargets, validateProfileRelativePath, } from "./lib/tlh-install-paths.mjs";
import { packageIdentity, } from "./lib/default-extensions.mjs";
import { assignRequiredEqualsValue, backupPathWithTimestamp, isTlhOwnedBackupFilename, renderShellWords, requiredValue, selectExpiredBackups, shellWord, } from "./lib/tlh-install-utils.mjs";
import { TLH_SUBAGENT_PROMPTS, copyTlhSubagentPrompts, defaultExtensionsRequireCriticalInstall as defaultExtensionsFileRequiresCriticalInstall, findTlhSubagentsDir as findTlhSubagentsDirFromSources, missingTlhSubagentPrompts, provisionSubagentExtensionConfig, settingsRequireTlhSubagentPrompts as settingsFileRequiresTlhSubagentPrompts, subagentExtensionConfigNeedsProvisioning, } from "./lib/tlh-install-subagents.mjs";
import { assertGitSourceTargetSafe, refreshGitCheckout, } from "./lib/tlh-install-git.mjs";
import { findLocalRepoDir, ensureSupportFilesPrepared, installableSupportFilesArePrepared, preflightRuntimeSupportFiles, } from "./lib/tlh-install-support-files.mjs";
import { formatSupportFileManifest, installableSupportFiles, supportFileManifest, } from "./lib/tlh-install-support-manifest.mjs";
const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const DEFAULT_REF = "main";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PINNED_PI_VERSION = "0.82.1";
const PI_PACKAGE_SPEC = `${PI_PACKAGE_NAME}@${PINNED_PI_VERSION}`;
// Keep in sync with TLH_MIN_NODE_VERSION and TLH_PINNED_PI_VERSION in install.sh.
const MIN_NODE_VERSION = "22.19.0";
const DEFAULT_GNOSIS_REPO = "skorokithakis/gnosis";
const DEFAULT_GNOSIS_VERSION = "0.5.4";
const DEFAULT_WRAPPER_NAME = "tlh";
const VALID_UPDATE_TRACKS = ["latest-release", "pinned-tag", "ref", "custom"];
// Ownership marker file written into the runtime prefix by TLH on every
// successful provision/repair/reuse.  Authoritative ownership carrier; written
// ONLY under a pristine/empty prefix (origin='created') or provenance-gated
// migration (origin='migrated').  Uninstall tooling must check this file before
// removing the runtime prefix.
//
// Marker contract (for uninstall.sh and tooling to mirror):
//   File   : <runtime>/.tlh-runtime-owned
//   Format : JSON { schemaVersion, packageName, runtimeAbsPath, origin }
//   schemaVersion  : 1
//   packageName    : "@earendil-works/pi-coding-agent"
//   runtimeAbsPath : realpath of the runtime prefix at write time
//   origin         : "created" (prefix was pristine/empty)
//                  | "migrated" (provenance-gated: piInstalledByTlh=true in install-state)
const RUNTIME_MARKER_FILENAME = ".tlh-runtime-owned";
const RUNTIME_MARKER_SCHEMA_VERSION = 1;
// npm 11.x --prefix layout; empirically confirmed: npm 11.16.0 +
// @earendil-works/pi-coding-agent@0.82.1.  Mirrors the advisory exclusivity
// tripwire in uninstall.sh (demoted from gate): the only top-level entries a
// TLH-owned runtime prefix should contain are those created by
// npm install -g --ignore-scripts --prefix, plus the TLH runtime ownership
// marker.  Authoritative ownership is carried by the marker file
// (.tlh-runtime-owned), not by directory shape; this set is used only as an
// advisory defense-in-depth check that can downgrade a removal to a skip.
const RUNTIME_OWNED_TOPLEVEL = new Set(["bin", "lib", "node-compile-cache", RUNTIME_MARKER_FILENAME]);
const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
function spawnErrorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    return error.code;
}
function parseNodeVersion(version) {
    const match = String(version).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return match.slice(1).map((part) => Number.parseInt(part, 10));
}
function compareVersionTriplets(currentVersion, expectedVersion) {
    const current = parseNodeVersion(currentVersion);
    const expected = parseNodeVersion(expectedVersion);
    if (!current || !expected)
        return null;
    for (let index = 0; index < expected.length; index += 1) {
        if (current[index] > expected[index])
            return 1;
        if (current[index] < expected[index])
            return -1;
    }
    return 0;
}
function nodeVersionMeetsMinimum(currentVersion, minimumVersion = MIN_NODE_VERSION) {
    const comparison = compareVersionTriplets(currentVersion, minimumVersion);
    return comparison !== null && comparison >= 0;
}
function formatNodeVersion(version) {
    const text = String(version || "").trim();
    if (!text)
        return "unknown";
    return text.startsWith("v") ? text : `v${text}`;
}
function assertSupportedNodeRuntime(currentVersion = process.versions.node) {
    if (!parseNodeVersion(currentVersion)) {
        throw new Error(`unable to determine Node.js version; The Last Harness requires Node.js >= ${MIN_NODE_VERSION}.`);
    }
    if (!nodeVersionMeetsMinimum(currentVersion)) {
        throw new Error(`Node.js >= ${MIN_NODE_VERSION} is required (found ${formatNodeVersion(currentVersion)}). Install or upgrade Node.js, then rerun the installer.`);
    }
}
function usage() {
    return `Usage: tlh-install.mjs [options]

Stage-1 The Last Harness installer helper. It runs the normal install flow using
an isolated Pi profile and installer-owned helper commands.

Requirements:
  Node.js >= ${MIN_NODE_VERSION} on PATH
  Upstream Pi ${PINNED_PI_VERSION} (installed per-user into a private TLH runtime prefix,
  default: ~/.the-last-harness/runtime (release) or ~/.the-last-harness-main/runtime (main);
  install or repair failures stop with an actionable error)

Options:
  --dry-run                  Print actions and settings/keybinding changes without writing
  --force                    Allow scalar isolated defaults and installer wrapper overwrite
  --no-settings              Install the package but skip isolated settings/keybinding merge
  --no-wrapper               Skip creating the tlh wrapper command
  --agent-dir DIR            Isolated Pi agent dir
                             (default for main: ~/.the-last-harness-main/agent;
                              default for release tags: ~/.the-last-harness/agent)
  --bin-dir DIR              Wrapper install dir (default: ~/.local/bin)
  --wrapper-name N           Wrapper command name
                             (default for main: tlh-main; default for release tags: tlh)
  --ref REF                  Install The Last Harness from a branch, tag, or commit
  --track TRACK              Update track for future tlh update: latest-release, pinned-tag, ref, custom
  --quiet                    Suppress installer progress output
  --verbose                  Show underlying pi, npm, and git output
  --print-support-manifest   Print pipe-delimited bootstrap support-file manifest and exit
  -h, --help                 Show this help

Environment overrides:
  TLH_AGENT_DIR        Isolated Pi agent dir (explicit; overrides the ref-derived default)
  TLH_BIN_DIR          Wrapper install dir
  TLH_WRAPPER_NAME     Wrapper command name (explicit; overrides the ref-derived default)
  TLH_REPO             GitHub repo, owner/name (default: diegopetrucci/the-last-harness)
  TLH_REF              Raw-file ref and package ref (default: main in source; release assets pin this to their tag)
  TLH_UPDATE_TRACK     Update track for future tlh update
  TLH_PACKAGE_SOURCE   Package source passed to \`pi install\`
  TLH_RAW_BASE         Base URL for installer support files
  TLH_GNOSIS_VERSION   Gnosis version to install (default: 0.5.4)
  TLH_GNOSIS_REPO      Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)
`;
}
function expandPath(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return join(homedir(), path.slice(2));
    return path;
}
function defaultAgentDir(env = process.env) {
    return env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}
function defaultBinDir(env = process.env) {
    return env.TLH_BIN_DIR || join(homedir(), ".local", "bin");
}
function parseArgs(argv, env = process.env) {
    const args = {
        repo: env.TLH_REPO || DEFAULT_REPO,
        ref: env.TLH_REF || DEFAULT_REF,
        dryRun: false,
        force: false,
        noSettings: false,
        noWrapper: false,
        quiet: false,
        verbose: false,
        gnosisRepo: env.TLH_GNOSIS_REPO || DEFAULT_GNOSIS_REPO,
        gnosisVersion: env.TLH_GNOSIS_VERSION || DEFAULT_GNOSIS_VERSION,
        packageSourceInput: env.TLH_PACKAGE_SOURCE || "",
        updateTrackInput: env.TLH_UPDATE_TRACK || "",
        rawBaseInput: env.TLH_RAW_BASE || "",
        agentDirInput: defaultAgentDir(env),
        // Track whether each of these was explicitly provided so that
        // buildInstallConfig() can apply ref-derived defaults for the main ref.
        agentDirExplicit: !!env.TLH_AGENT_DIR,
        binDirInput: defaultBinDir(env),
        wrapperName: env.TLH_WRAPPER_NAME || DEFAULT_WRAPPER_NAME,
        wrapperNameExplicit: !!env.TLH_WRAPPER_NAME,
        printSupportManifest: false,
        help: false,
        piInstalledByTlhOverride: undefined,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "-h" || arg === "--help") {
            args.help = true;
            continue;
        }
        if (arg === "--dry-run") {
            args.dryRun = true;
            continue;
        }
        if (arg === "--force") {
            args.force = true;
            continue;
        }
        if (arg === "--no-settings") {
            args.noSettings = true;
            continue;
        }
        if (arg === "--no-wrapper") {
            args.noWrapper = true;
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
        if (arg === "--print-support-manifest") {
            args.printSupportManifest = true;
            continue;
        }
        if (arg === "--pi-installed-by-tlh") {
            const raw = requiredValue(argv, ++index, arg);
            const lower = raw.toLowerCase();
            if (lower !== "true" && lower !== "false") {
                throw new Error(`--pi-installed-by-tlh must be true or false (got: ${raw})`);
            }
            args.piInstalledByTlhOverride = lower === "true";
            continue;
        }
        if (arg.startsWith("--pi-installed-by-tlh=")) {
            const raw = arg.slice("--pi-installed-by-tlh=".length);
            if (!raw)
                throw new Error("--pi-installed-by-tlh requires a value");
            const lower = raw.toLowerCase();
            if (lower !== "true" && lower !== "false") {
                throw new Error(`--pi-installed-by-tlh must be true or false (got: ${raw})`);
            }
            args.piInstalledByTlhOverride = lower === "true";
            continue;
        }
        if (arg === "--agent-dir") {
            args.agentDirInput = requiredValue(argv, ++index, arg);
            args.agentDirExplicit = true;
            continue;
        }
        if (arg === "--bin-dir") {
            args.binDirInput = requiredValue(argv, ++index, arg);
            continue;
        }
        if (arg === "--wrapper-name") {
            args.wrapperName = requiredValue(argv, ++index, arg);
            args.wrapperNameExplicit = true;
            continue;
        }
        if (arg === "--ref") {
            args.ref = requiredValue(argv, ++index, arg);
            continue;
        }
        if (arg === "--track") {
            args.updateTrackInput = requiredValue(argv, ++index, arg);
            continue;
        }
        if (arg.startsWith("--agent-dir=")) {
            assignRequiredEqualsValue(args, "agentDirInput", arg.slice("--agent-dir=".length), "--agent-dir");
            args.agentDirExplicit = true;
            continue;
        }
        if (arg.startsWith("--bin-dir=")) {
            assignRequiredEqualsValue(args, "binDirInput", arg.slice("--bin-dir=".length), "--bin-dir");
            continue;
        }
        if (arg.startsWith("--wrapper-name=")) {
            assignRequiredEqualsValue(args, "wrapperName", arg.slice("--wrapper-name=".length), "--wrapper-name");
            args.wrapperNameExplicit = true;
            continue;
        }
        if (arg.startsWith("--ref=")) {
            assignRequiredEqualsValue(args, "ref", arg.slice("--ref=".length), "--ref");
            continue;
        }
        if (arg.startsWith("--track=")) {
            assignRequiredEqualsValue(args, "updateTrackInput", arg.slice("--track=".length), "--track");
            continue;
        }
        throw new Error(`unknown option: ${arg}`);
    }
    return args;
}
function isSemverTag(ref) {
    return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref);
}
function buildInstallConfig(parsedArgs, env = process.env) {
    // piInstalledByTlhOverride is set when an explicit --pi-installed-by-tlh flag was passed
    // (e.g. tlh-update.mjs carries through the preserved value from an existing install-state).
    //
    // Main-ref auto-defaults: when installing from the default ref ('main') and the user has
    // NOT explicitly provided a wrapper name or agent dir (via env or CLI), use separate
    // named defaults so that main-track installs don't collide with release-tag installs.
    // Explicit values (tracked via parsedArgs.*Explicit booleans) always win.
    const isMainRef = parsedArgs.ref === DEFAULT_REF;
    const effectiveWrapperName = (isMainRef && !parsedArgs.wrapperNameExplicit)
        ? "tlh-main"
        : parsedArgs.wrapperName;
    const effectiveAgentDirInput = (isMainRef && !parsedArgs.agentDirExplicit)
        ? join(homedir(), ".the-last-harness-main", "agent")
        : parsedArgs.agentDirInput;
    const agentDir = resolve(expandPath(effectiveAgentDirInput));
    const binDir = resolve(expandPath(parsedArgs.binDirInput));
    const wrapperPath = join(binDir, effectiveWrapperName);
    let packageSource = parsedArgs.packageSourceInput;
    let packageSourceIsDefault = false;
    if (!packageSource) {
        packageSource = `git:github.com/${parsedArgs.repo}@${parsedArgs.ref}`;
        packageSourceIsDefault = true;
    }
    let updateTrack = parsedArgs.updateTrackInput;
    if (!updateTrack) {
        if (!packageSourceIsDefault)
            updateTrack = "custom";
        else if (isSemverTag(parsedArgs.ref))
            updateTrack = "pinned-tag";
        else
            updateTrack = "ref";
    }
    const scriptPath = fileURLToPath(import.meta.url);
    const scriptDir = dirname(scriptPath);
    const supportFiles = supportFileManifest({ noSettings: parsedArgs.noSettings });
    const defaultPackageRoot = join(agentDir, "git", "github.com", parsedArgs.repo);
    const homeDir = env.HOME || homedir();
    const resolvedPackageRoot = packageSourceInstallDir(packageSource, {
        agentDir,
        homeDir,
    });
    const packageRoot = resolvedPackageRoot || defaultPackageRoot;
    const packageHelperRoot = resolvedPackageRoot || (packageSourceIsDefault ? defaultPackageRoot : "");
    return {
        ...parsedArgs,
        env,
        homeDir,
        agentDir,
        binDir,
        settingsPath: join(agentDir, "settings.json"),
        keybindingsPath: join(agentDir, "keybindings.json"),
        wrapperName: effectiveWrapperName,
        supportDir: join(agentDir, "tlh"),
        statePath: join(agentDir, "tlh", "install-state.json"),
        wrapperPath,
        packageRoot,
        packageHelperRoot,
        packageSource,
        packageSourceIsDefault,
        rawBase: parsedArgs.rawBaseInput || `https://raw.githubusercontent.com/${parsedArgs.repo}/${parsedArgs.ref}`,
        updateTrack: updateTrack,
        subagentPrompts: [...TLH_SUBAGENT_PROMPTS],
        supportFiles,
        piInstalledByTlhOverride: parsedArgs.piInstalledByTlhOverride,
        piInstalledByTlh: undefined,
        piCmd: "",
        supportFilePaths: Object.fromEntries(supportFiles.map((file) => [file.variable, ""])),
        scriptPath,
        scriptDir,
        localRepoCandidate: resolve(scriptDir, ".."),
        tmpDir: "",
        supportFilesDryRunSkipped: false,
        gnosisSummary: "",
        ticketsSummary: "",
    };
}
function validateInputs(config) {
    validateInstallerTargets(config, { validUpdateTracks: VALID_UPDATE_TRACKS });
}
function log(config, message = "") {
    if (!config.quiet)
        console.log(message);
}
function verboseLog(config, message) {
    if (config.verbose && !config.quiet)
        console.log(message);
}
function detailLog(config, message) {
    if (!config.quiet && (config.verbose || config.dryRun))
        console.log(message);
}
function warn(message) {
    console.error(`warning: ${message}`);
}
function verboseWarn(config, message) {
    if (config.verbose && !config.quiet)
        warn(message);
}
function printCommand(commandArgs) {
    console.log(`+ ${renderShellWords(commandArgs)} `);
}
function commandDisplay(commandArgs) {
    return renderShellWords(commandArgs);
}
function tailLines(text, count) {
    return text.split(/\r?\n/).slice(-count).join("\n");
}
function printCommandFailure({ status, output, displayArgs, cwd }) {
    const cwdText = cwd ? `, cwd ${cwd}` : "";
    console.error(`command failed (exit ${status}${cwdText}): ${commandDisplay(displayArgs)}`);
    if (output.trim()) {
        console.error("---- output (last 80 lines) ----");
        console.error(tailLines(output.trimEnd(), 80));
        console.error("---- end output ----");
    }
    console.error("Re-run the installer with --verbose to show full command output.");
}
function quietCommandEnv(config, extraEnv = {}) {
    return {
        ...config.env,
        GIT_TERMINAL_PROMPT: "0",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_LOGLEVEL: "error",
        ...extraEnv,
    };
}
function inheritedCommandEnv(config, extraEnv = {}) {
    return { ...config.env, ...extraEnv };
}
function runCommand(config, commandArgs, { cwd, env = {}, displayArgs = commandArgs } = {}) {
    if (config.dryRun) {
        if (cwd) {
            printCommand(["bash", "-c", `cd ${shellWord(cwd)} && ${commandDisplay(displayArgs)}`]);
        }
        else {
            printCommand(displayArgs);
        }
        return;
    }
    const [command, ...args] = commandArgs;
    const result = spawnSync(command, args, {
        cwd,
        env: config.verbose ? inheritedCommandEnv(config, env) : quietCommandEnv(config, env),
        encoding: "utf8",
        maxBuffer: COMMAND_MAX_BUFFER,
        stdio: config.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
        const status = result.status ?? result.signal ?? spawnErrorCode(result.error) ?? 1;
        const output = config.verbose ? (result.error?.message ?? "") : `${result.stdout || ""}${result.stderr || ""}`;
        printCommandFailure({ status, output, displayArgs, cwd });
        throw new Error(`command failed: ${commandDisplay(displayArgs)}`);
    }
}
function runInDir(config, dir, commandArgs) {
    runCommand(config, commandArgs, { cwd: dir });
}
function commandExists(config, command) {
    const result = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], {
        env: inheritedCommandEnv(config),
        stdio: "ignore",
    });
    return !result.error && result.status === 0;
}
function requireCommand(config, command) {
    if (!commandExists(config, command))
        throw new Error(`required command not found: ${command}`);
}
function spawnCapture(config, commandArgs, { cwd, env = {}, allowFailure = false } = {}) {
    const [command, ...args] = commandArgs;
    const result = spawnSync(command, args, {
        cwd,
        env: inheritedCommandEnv(config, env),
        encoding: "utf8",
        maxBuffer: COMMAND_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (!allowFailure && (result.error || result.status !== 0)) {
        const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
        throw new Error(output || result.error?.message || `command failed: ${commandDisplay(commandArgs)}`);
    }
    return result;
}
function runNodeScript(config, scriptPath, args, { captureStdout = false } = {}) {
    const commandArgs = [process.execPath, scriptPath, ...args];
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
        env: inheritedCommandEnv(config, { PI_CODING_AGENT_DIR: config.agentDir }),
        encoding: "utf8",
        maxBuffer: COMMAND_MAX_BUFFER,
        stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (result.error || result.status !== 0) {
        const status = result.status ?? result.signal ?? spawnErrorCode(result.error) ?? 1;
        throw new Error(`command failed (exit ${status}): ${commandDisplay(commandArgs)}`);
    }
    return captureStdout ? result.stdout : "";
}
function runIsolatedPi(config, commandArgs) {
    const displayArgs = ["env", `PI_CODING_AGENT_DIR=${config.agentDir}`, ...commandArgs];
    if (!config.dryRun)
        assertSafeSettingsTarget(config);
    runCommand(config, commandArgs, {
        cwd: config.agentDir,
        env: { PI_CODING_AGENT_DIR: config.agentDir },
        displayArgs,
    });
}
function supportFileIo() {
    return {
        log: log,
        verboseLog: verboseLog,
        warn,
        requireCommand: requireCommand,
    };
}
function gitCheckoutIo() {
    return {
        spawnCapture: spawnCapture,
        runCommand: runCommand,
        runInDir: runInDir,
        printCommand: printCommand,
        log: log,
        warn,
    };
}
function pinnedPiInstallCommand(config) {
    return `npm install -g --ignore-scripts --prefix "${piInstallPrefix(config)}" ${PI_PACKAGE_SPEC}`;
}
function pinnedPiInstallGuidance(config) {
    return `Install the pinned TLH runtime with: ${pinnedPiInstallCommand(config)}`;
}
function readPiInstalledByTlhPreference(config) {
    if (config.piInstalledByTlhOverride !== undefined)
        return config.piInstalledByTlhOverride;
    if (!existsSync(config.statePath))
        return undefined;
    try {
        const state = JSON.parse(readFileSync(config.statePath, "utf8").replace(/^\uFEFF/, ""));
        return typeof state?.piInstalledByTlh === "boolean" ? state.piInstalledByTlh : undefined;
    }
    catch (error) {
        verboseLog(config, `Unable to read existing TLH install state at ${config.statePath}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
function runtimeMarkerPath(prefix) {
    return join(prefix, RUNTIME_MARKER_FILENAME);
}
/**
 * Read and validate the TLH runtime ownership marker.  Fail-closed: returns
 * null for a missing, symlinked, malformed, schema-mismatched, or unreadable
 * marker — any of those states means no valid ownership claim.
 */
function readRuntimeMarker(prefix) {
    const markerFile = runtimeMarkerPath(prefix);
    try {
        if (!existsSync(markerFile))
            return null;
        if (isSymlink(markerFile))
            return null; // symlinked marker → no valid claim
        const data = JSON.parse(readFileSync(markerFile, "utf8"));
        if (typeof data !== "object" || data === null)
            return null;
        if (data.schemaVersion !== RUNTIME_MARKER_SCHEMA_VERSION)
            return null;
        if (data.packageName !== PI_PACKAGE_NAME)
            return null;
        if (typeof data.runtimeAbsPath !== "string" || !data.runtimeAbsPath)
            return null;
        if (data.origin !== "created" && data.origin !== "migrated")
            return null;
        return data;
    }
    catch {
        return null; // fail-closed: any parse or read error → no valid claim
    }
}
function isRuntimeMarkerPathMatched(marker, prefix) {
    try {
        const realPrefix = realpathSync(prefix);
        return marker.runtimeAbsPath === realPrefix;
    }
    catch {
        return false; // fail-closed
    }
}
/**
 * Write (or refresh) the TLH runtime ownership marker atomically using a
 * temp-file + rename.  Refuses to write through a symlinked runtime directory
 * or a symlinked marker path.
 */
function writeRuntimeMarker(config, prefix, origin) {
    const markerFile = runtimeMarkerPath(prefix);
    if (config.dryRun) {
        verboseLog(config, `Would write runtime ownership marker: ${markerFile}`);
        return;
    }
    if (isSymlink(prefix)) {
        throw new Error(`refusing to write TLH runtime ownership marker through symlinked runtime directory: ${prefix}`);
    }
    if (isSymlink(markerFile)) {
        throw new Error(`refusing to write TLH runtime ownership marker through symlinked marker path: ${markerFile}`);
    }
    const realPrefix = realpathSync(prefix);
    const markerContent = JSON.stringify({
        schemaVersion: RUNTIME_MARKER_SCHEMA_VERSION,
        packageName: PI_PACKAGE_NAME,
        runtimeAbsPath: realPrefix,
        origin,
    });
    // Atomic write: unique temp file in the same directory, then rename.
    // randomUUID() avoids a predictable path; flag "wx" (O_CREAT|O_EXCL) refuses
    // to follow or overwrite any pre-existing file or symlink, closing the TOCTOU
    // symlink-follow window on the temp path.
    const tempFile = join(dirname(markerFile), `.tlh-runtime-owned.${randomUUID()}.tmp`);
    try {
        writeFileSync(tempFile, markerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
        renameSync(tempFile, markerFile);
    }
    catch (error) {
        rmSync(tempFile, { force: true });
        throw error;
    }
}
function assertSupportedPiVersion(config, { piCommand = "pi", sourceDescription = "existing pi on PATH", versionCommandDisplay = "pi --version", } = {}) {
    // `pi --version` prints a bare semver (e.g. "0.82.1") on stdout. Older builds may
    // differ, so we extract the first semver-shaped substring rather than match strictly.
    const result = spawnCapture(config, [piCommand, "--version"], {
        allowFailure: true,
        env: { PI_CODING_AGENT_DIR: config.agentDir },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const installGuidance = pinnedPiInstallGuidance(config);
    const requiredVersionDescription = `Pi ${PINNED_PI_VERSION}`;
    if (result.error || result.status !== 0) {
        const status = result.status ?? result.signal ?? spawnErrorCode(result.error) ?? "error";
        const probeDetails = output ? ` Probe output: ${output}` : "";
        throw new Error(`unable to determine Pi version from ${sourceDescription} (${versionCommandDisplay} exited with ${status}). The Last Harness requires ${requiredVersionDescription}. Verify that \`${versionCommandDisplay}\` works, or ${installGuidance}.${probeDetails}`);
    }
    const match = output.match(/\d+\.\d+\.\d+/);
    if (!match) {
        throw new Error(`unable to parse Pi version from ${sourceDescription}: ${output || "<empty>"}. The Last Harness requires ${requiredVersionDescription}. Verify that \`${versionCommandDisplay}\` prints a semantic version like ${PINNED_PI_VERSION}, or ${installGuidance}.`);
    }
    const currentVersion = match[0];
    if (currentVersion !== PINNED_PI_VERSION) {
        throw new Error(`${requiredVersionDescription} is required (found ${currentVersion}). ${installGuidance}`);
    }
    verboseLog(config, `Pi version (${sourceDescription}): ${currentVersion}`);
}
function preferBinDirOnPathForCurrentInstall(config, binDir, { addMessage, prependMessage }) {
    const currentEntries = (config.env.PATH || "")
        .split(delimiter)
        .filter(Boolean);
    if (currentEntries[0] === binDir)
        return;
    const alreadyPresent = currentEntries.includes(binDir);
    config.env.PATH = [binDir, ...currentEntries.filter((entry) => entry !== binDir)].join(delimiter);
    if (alreadyPresent) {
        verboseWarn(config, prependMessage);
        return;
    }
    verboseWarn(config, `${addMessage} Added it to PATH for this install; add it to your shell profile with: export PATH="${binDir}:$PATH"`);
}
function runtimePrefix(config) {
    // Private TLH runtime prefix: sibling of agent/ under ~/.the-last-harness/.
    // The pinned pi binary lives at <runtimePrefix>/bin/pi.
    // Invariant: always derived from the agent dir's parent so the runtime stays
    // co-located with the isolated profile regardless of --agent-dir customisation.
    return join(dirname(config.agentDir), "runtime");
}
function piInstallPrefix(config) {
    // Always install the pinned pi into the private TLH runtime prefix (no ~/.local).
    // Per-user, no sudo: npm install -g --ignore-scripts --prefix <runtimePrefix>.
    return runtimePrefix(config);
}
function absolutePiCmd(config) {
    // Return the absolute path to the private runtime pi binary.
    // config.piCmd is populated by installPiIfNeeded in non-dry-run; in dry-run it
    // is "" so we fall back to deriving the intended path from runtimePrefix for
    // sensible display output without breaking the dry-run flow.
    return config.piCmd || join(runtimePrefix(config), "bin", "pi");
}
/**
 * Assert that the private runtime prefix is either absent/empty (safe for a
 * fresh install) or affirmatively TLH-owned via the ownership marker.  Throws
 * on symlinked prefix, or on a non-empty prefix with no valid marker and no
 * recorded provenance (the shared-prefix data-loss scenario).
 *
 * Returns { origin } that must be forwarded to writeRuntimeMarker after
 * a successful provision/repair/reuse.
 */
function assertRuntimePrefixOwnedOrEmpty(config) {
    const prefix = piInstallPrefix(config);
    // Refuse symlinked runtime directory up-front — a symlink could resolve to a
    // shared or foreign prefix that happens to look like the TLH layout.
    if (isSymlink(prefix)) {
        throw new Error(`TLH runtime prefix is a symlink: ${prefix}. ` +
            `The runtime directory must not be a symlink. ` +
            `Remove the symlink or choose a dedicated profile directory (e.g. ~/.the-last-harness/agent).`);
    }
    if (!existsSync(prefix))
        return { origin: "created" }; // absent → fresh install
    const entries = readdirSync(prefix); // never returns '.' or '..'; includes dotfiles
    if (entries.length === 0)
        return { origin: "created" }; // empty → fresh install
    // Check for an affirmative ownership marker.
    const marker = readRuntimeMarker(prefix);
    if (marker && isRuntimeMarkerPathMatched(marker, prefix)) {
        // Valid marker whose recorded path matches the actual prefix → TLH owns this.
        return { origin: marker.origin };
    }
    // No valid marker. Check install-state provenance as a one-time migration gate.
    const piInstalledByTlhPreference = readPiInstalledByTlhPreference(config);
    if (piInstalledByTlhPreference === true) {
        // Provenance-gated migration: TLH installed this runtime before the ownership
        // marker was introduced.  Accept and emit origin='migrated' so the caller
        // writes the marker, making future runs marker-gated.
        verboseLog(config, `Migrating TLH runtime ownership: writing marker for pre-existing TLH-installed runtime at ${prefix}`);
        return { origin: "migrated" };
    }
    // Non-empty, no valid marker, no provenance → refuse.  This is the P1
    // shared-prefix data-loss scenario: a foreign npm --prefix directory that
    // happens to sit next to a non-default --agent-dir.
    throw new Error(`TLH runtime prefix ${prefix} is not TLH-owned: ` +
        `no ownership marker (${RUNTIME_MARKER_FILENAME}) was found and no TLH install ` +
        `provenance is recorded. A non-default --agent-dir may point at a profile whose ` +
        `sibling "runtime" directory belongs to a different installation. ` +
        `Choose a dedicated or default profile directory (e.g. ~/.the-last-harness/agent), ` +
        `or remove ${prefix} if it is safe to do so.`);
}
function installPiIfNeeded(config) {
    const { origin } = assertRuntimePrefixOwnedOrEmpty(config);
    const prefix = piInstallPrefix(config);
    const piBinDir = join(prefix, "bin");
    const piBin = join(piBinDir, "pi");
    // Always ensure the private TLH runtime exists and is the pinned version.
    // Never borrow a global or PATH pi; never fall through to ~/.local.
    if (existsSync(piBin)) {
        let needsRepair = false;
        try {
            assertSupportedPiVersion(config, {
                piCommand: piBin,
                sourceDescription: `TLH private runtime at ${piBin}`,
                versionCommandDisplay: `${piBin} --version`,
            });
            verboseLog(config, `TLH private Pi runtime is valid: ${piBin}`);
            // Prepend the private runtime's bin dir to PATH for the remainder of this
            // process so downstream pi commands resolve the validated private binary.
            preferBinDirOnPathForCurrentInstall(config, piBinDir, {
                addMessage: `TLH private Pi runtime ${piBin} is not on PATH.`,
                prependMessage: `Using TLH private Pi runtime ${piBin}. Prepended ${piBinDir} to PATH for this install.`,
            });
        }
        catch (error) {
            // Private runtime exists but is the wrong version — repair it.
            needsRepair = true;
            verboseLog(config, `TLH private Pi runtime needs repair: ${error instanceof Error ? error.message : String(error)}`);
            log(config, `Repairing TLH private Pi runtime to pinned ${PINNED_PI_VERSION} at ${prefix} (per-user, no sudo)...`);
        }
        if (!needsRepair) {
            // Ensure/refresh the ownership marker on reuse so existing users gain it
            // on their next run (marker was introduced after initial deployments).
            writeRuntimeMarker(config, prefix, origin);
            if (config.dryRun)
                return { installed: false, piCmd: "" };
            return { installed: false, piCmd: piBin };
        }
    }
    else {
        log(config, `Installing TLH private Pi runtime to ${prefix} (per-user, no sudo)...`);
    }
    verboseLog(config, `Installing pinned Pi package spec: ${PI_PACKAGE_SPEC}`);
    runCommand(config, [
        "npm",
        "install",
        "-g",
        "--ignore-scripts",
        "--prefix",
        prefix,
        PI_PACKAGE_SPEC,
    ]);
    if (config.dryRun) {
        // Log marker intent in dry-run; the prefix may not exist yet.
        writeRuntimeMarker(config, prefix, origin);
        return { installed: true, piCmd: "" };
    }
    if (!existsSync(piBin)) {
        throw new Error(`Pi install completed, but ${piBin} does not exist`);
    }
    // Validate the freshly installed binary before proceeding — a broken or wrong-version
    // npm install must throw here, before any legacy cleanup runs.
    assertSupportedPiVersion(config, {
        piCommand: piBin,
        sourceDescription: `freshly installed TLH private runtime at ${piBin}`,
        versionCommandDisplay: `${piBin} --version`,
    });
    // Prepend the private runtime's bin dir for the remainder of this process so
    // downstream steps (pi install, pi update, …) resolve the new binary.
    preferBinDirOnPathForCurrentInstall(config, piBinDir, {
        addMessage: `${piBin} installed but ${piBinDir} is not on PATH.`,
        prependMessage: `Using TLH private Pi runtime ${piBin}. Prepended ${piBinDir} to PATH for this install.`,
    });
    // Write the ownership marker after full successful install+validation.
    writeRuntimeMarker(config, prefix, origin);
    return { installed: true, piCmd: piBin };
}
// Retired files that TLH seeded in older isolated profiles.
// Each path is relative to config.agentDir and must not contain '..' components.
// The cleanup is idempotent: absent files are silently skipped.
export const LEGACY_MANAGED_PROFILE_ARTIFACTS = Object.freeze([
    "bin/rtk",
    "tlh/tlh-rtk.mjs",
]);
export const RETIRED_PROFILE_FILES = Object.freeze([
    "extensions/librarian.json",
]);
function cleanupRelativeProfileFiles(config, relativePaths) {
    for (const relativePath of relativePaths) {
        try {
            validateProfileRelativePath(relativePath, "retired profile path");
        }
        catch {
            warn(`Skipping invalid retired profile path: ${relativePath}`);
            continue;
        }
        if (isSymlink(config.agentDir)) {
            warn(`Skipping retired profile file cleanup: agentDir is a symlink: ${config.agentDir}`);
            continue;
        }
        const components = relativePath.split("/");
        const parentComponents = components.slice(0, -1);
        const fileName = components[components.length - 1];
        let cursor = config.agentDir;
        let skipThis = false;
        for (const component of parentComponents) {
            cursor = join(cursor, component);
            if (isSymlink(cursor)) {
                warn(`Skipping retired profile file cleanup through symlinked parent: ${cursor}`);
                skipThis = true;
                break;
            }
            if (!existsSync(cursor)) {
                skipThis = true;
                break;
            }
        }
        if (skipThis)
            continue;
        const target = join(cursor, fileName);
        try {
            assertProfilePathWithinAgent(config, target, "retired profile file");
        }
        catch (error) {
            warn(`Skipping retired profile file cleanup (unsafe path): ${target}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (isSymlink(target))
            continue;
        if (!existsSync(target))
            continue;
        if (!lstatSync(target).isFile())
            continue;
        if (config.dryRun) {
            log(config, `Would remove retired profile file: ${target}`);
            continue;
        }
        try {
            rmSync(target);
            detailLog(config, `Removed retired profile file: ${target}`);
        }
        catch (error) {
            warn(`failed to remove retired profile file ${target}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
export function cleanupLegacyManagedProfileArtifacts(config) {
    cleanupRelativeProfileFiles(config, LEGACY_MANAGED_PROFILE_ARTIFACTS);
}
export function cleanupRetiredProfileFiles(config) {
    // FIX 2: Read post-merge settings to decide whether to keep managed files.
    // Fail safe: if settings cannot be read, skip file removal rather than risk wrong deletion.
    let postMergePackages = []; // default empty → proceed with removal when no settings present
    if (config.settingsPath && existsSync(config.settingsPath)) {
        try {
            const raw = readFileSync(config.settingsPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.packages)) {
                postMergePackages = parsed.packages;
            }
        }
        catch {
            postMergePackages = null; // fail safe: unreadable settings → skip removal
        }
    }
    for (const relativePath of RETIRED_PROFILE_FILES) {
        if (relativePath === "extensions/librarian.json") {
            if (postMergePackages === null) {
                if (config.dryRun)
                    log(config, `Would skip removal of retired profile file (settings unreadable, fail safe): ${join(config.agentDir, relativePath)}`);
                continue;
            }
            const librarianIdentity = packageIdentity("npm:@diegopetrucci/pi-librarian");
            const librarianPresent = postMergePackages.some((entry) => packageIdentity(entry) === librarianIdentity);
            if (librarianPresent) {
                if (config.dryRun)
                    log(config, `Skipping retired profile file removal (user-added package preserved): ${join(config.agentDir, relativePath)}`);
                continue;
            }
        }
        cleanupRelativeProfileFiles(config, [relativePath]);
    }
}
export function cleanupOldSettingsBackups(config) {
    // Skip entirely when agentDir itself is a symlink — same safety posture as cleanupRetiredProfileFiles.
    if (isSymlink(config.agentDir)) {
        warn(`Skipping stale settings backup cleanup: agentDir is a symlink: ${config.agentDir}`);
        return;
    }
    // Gather candidate filenames from the agent-dir root (non-recursive).
    if (!existsSync(config.agentDir))
        return;
    let entries;
    try {
        entries = readdirSync(config.agentDir);
    }
    catch (error) {
        warn(`Skipping stale settings backup cleanup: cannot read agentDir: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    // Keep only filenames that match TLH backup patterns AND carry a parseable
    // TLH timestamp. Files like `settings.json.backup-mynotes` share the prefix
    // but have no timestamp, so they must never be treated as deletion candidates.
    const settingsCandidates = entries.filter((name) => isTlhOwnedBackupFilename(name, "settings.json"));
    const keybindingsCandidates = entries.filter((name) => isTlhOwnedBackupFilename(name, "keybindings.json"));
    if (settingsCandidates.length === 0 && keybindingsCandidates.length === 0)
        return;
    // Determine which candidates are eligible for removal.
    // Each file type (settings vs keybindings) gets its own independent keepNewest:2
    // floor so that two recent settings backups cannot consume the floor and cause
    // the only keybindings backup (however old) to be deleted.
    // All candidates have a parseable timestamp, so mtimeFallback is a defensive
    // safety net only — it should never be reached in normal operation.
    const mtimeFallback = (filename) => {
        try {
            const stat = lstatSync(join(config.agentDir, filename));
            return stat.mtimeMs;
        }
        catch {
            return undefined;
        }
    };
    const toDelete = [
        ...selectExpiredBackups(settingsCandidates, { mtimeFallback }),
        ...selectExpiredBackups(keybindingsCandidates, { mtimeFallback }),
    ];
    for (const filename of toDelete) {
        const target = join(config.agentDir, filename);
        // Assert target stays within the isolated agent dir and outside ~/.pi.
        try {
            assertProfilePathWithinAgent(config, target, "stale settings backup");
        }
        catch (error) {
            warn(`Skipping stale settings backup cleanup (unsafe path): ${target}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (isSymlink(target))
            continue; // Conservative: never remove or follow symlinks
        if (!existsSync(target))
            continue; // Idempotent: absent is fine
        if (!lstatSync(target).isFile())
            continue; // Conservative: only regular files
        if (config.dryRun) {
            log(config, `Would remove stale settings backup: ${target}`);
            continue;
        }
        try {
            rmSync(target);
            detailLog(config, `Removed stale settings backup: ${target}`);
        }
        catch (error) {
            warn(`failed to remove stale settings backup ${target}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
function backupExistingSettingsBeforePiInstall(config) {
    assertSafeSettingsTarget(config);
    if (!existsSync(config.settingsPath))
        return;
    const backupPath = backupPathWithTimestamp(config.settingsPath, {
        marker: "before-install",
        includeMilliseconds: false,
    });
    if (config.dryRun) {
        log(config, `Would back up existing isolated settings to: ${backupPath}`);
        return;
    }
    if (existsSync(backupPath) || isSymlink(backupPath)) {
        throw new Error(`refusing to overwrite existing settings backup: ${backupPath}`);
    }
    copyFileSync(config.settingsPath, backupPath);
    detailLog(config, `Backed up existing isolated settings to: ${backupPath}`);
}
function refreshHarnessPackageCheckout(config) {
    let packageRoot = config.packageRoot;
    let packageRepo = "";
    let packageRef = config.ref;
    const packageSpec = criticalGitSourceSpec(config.packageSource, { agentDir: config.agentDir });
    if (packageSpec) {
        packageRoot = packageSpec.targetDir;
        packageRepo = packageSpec.repo;
        packageRef = packageSpec.ref;
    }
    if (config.packageSourceIsDefault) {
        packageRef = packageRef || config.ref;
    }
    else if (!packageSpec || !packageRef) {
        return;
    }
    verboseLog(config, `Checking out The Last Harness git ref: ${packageRef}`);
    refreshGitCheckout(config, {
        targetDir: packageRoot,
        repo: packageRepo,
        ref: packageRef,
        label: "The Last Harness package checkout",
        missingMessage: `expected installed package checkout not found or invalid: ${packageRoot}`,
    }, gitCheckoutIo());
}
function installHarnessPackage(config) {
    verboseLog(config, `Using isolated Pi agent dir: ${config.agentDir}`);
    if (config.dryRun)
        printCommand(["mkdir", "-p", config.agentDir]);
    else
        mkdirSync(config.agentDir, { recursive: true });
    backupExistingSettingsBeforePiInstall(config);
    log(config, "Installing The Last Harness package...");
    verboseLog(config, `Package source: ${config.packageSource}`);
    const piPackageSource = packageSourcePiSource(config.packageSource, { agentDir: config.agentDir });
    assertGitSourceTargetSafe(config, config.packageSource, "The Last Harness package checkout", gitCheckoutIo());
    runIsolatedPi(config, [absolutePiCmd(config), "install", piPackageSource]);
    refreshHarnessPackageCheckout(config);
    if (config.packageSourceIsDefault)
        return;
    const packageSpec = criticalGitSourceSpec(config.packageSource, { agentDir: config.agentDir });
    if (packageSpec?.ref) {
        verboseLog(config, "Pinned custom git package source was refreshed directly; skipping pi update.");
        return;
    }
    if (config.dryRun) {
        log(config, `Would refresh custom package source if it is already installed: PI_CODING_AGENT_DIR=${config.agentDir} ${absolutePiCmd(config)} update ${piPackageSource}`);
        return;
    }
    runIsolatedPi(config, [absolutePiCmd(config), "update", piPackageSource]);
}
async function mergeSettings(config) {
    if (config.noSettings) {
        log(config, "Skipping settings/keybinding merge (--no-settings).");
        return;
    }
    if (!(await ensureSupportFilesPrepared(config, supportFileIo())))
        return;
    const args = [
        config.supportFilePaths.MERGE_SCRIPT,
        config.supportFilePaths.DEFAULTS_FILE,
        "--settings",
        config.settingsPath,
        "--package-source",
        packageSourcePiSource(config.packageSource, { agentDir: config.agentDir }),
    ];
    if (config.supportFilePaths.DEFAULT_EXTENSIONS_FILE) {
        args.push("--default-extensions", config.supportFilePaths.DEFAULT_EXTENSIONS_FILE);
    }
    if (config.dryRun)
        args.push("--dry-run");
    if (config.force)
        args.push("--force");
    if (config.quiet || (!config.verbose && !config.dryRun))
        args.push("--quiet");
    log(config, "Applying isolated settings...");
    verboseLog(config, `Settings path: ${config.settingsPath}`);
    runNodeScript(config, args[0], args.slice(1));
    if (!config.supportFilePaths.KEYBINDINGS_MERGE_SCRIPT || !config.supportFilePaths.KEYBINDINGS_DEFAULTS_FILE)
        return;
    const keybindingArgs = [
        config.supportFilePaths.KEYBINDINGS_MERGE_SCRIPT,
        config.supportFilePaths.KEYBINDINGS_DEFAULTS_FILE,
        "--keybindings",
        config.keybindingsPath,
    ];
    if (config.dryRun)
        keybindingArgs.push("--dry-run");
    if (config.quiet || (!config.verbose && !config.dryRun))
        keybindingArgs.push("--quiet");
    log(config, "Applying isolated keybindings...");
    verboseLog(config, `Keybindings path: ${config.keybindingsPath}`);
    runNodeScript(config, keybindingArgs[0], keybindingArgs.slice(1));
}
async function installSupportFilesToProfile(config) {
    if (!installableSupportFilesArePrepared(config))
        await ensureSupportFilesPrepared(config, supportFileIo());
    if (!installableSupportFilesArePrepared(config))
        return;
    const requireSubagentPrompts = settingsFileRequiresTlhSubagentPrompts(config.supportFilePaths.DEFAULTS_FILE, {
        noSettings: config.noSettings,
    });
    const subagentsSrc = requireSubagentPrompts
        ? findTlhSubagentsDirFromSources(config, {
            localRepoDir: findLocalRepoDir(config) || "",
            prompts: config.subagentPrompts,
        })
        : "";
    const supportSubagentsDir = join(config.supportDir, "agents", "subagents");
    if (config.dryRun) {
        printCommand(["mkdir", "-p", config.supportDir]);
        for (const file of installableSupportFiles({ noSettings: config.noSettings })) {
            const sourcePath = config.supportFilePaths[file.variable];
            if (sourcePath)
                printCommand(["cp", sourcePath, join(config.supportDir, file.installName)]);
        }
        if (requireSubagentPrompts) {
            if (subagentsSrc) {
                printCommand(["mkdir", "-p", supportSubagentsDir]);
                for (const prompt of config.subagentPrompts) {
                    printCommand(["cp", join(subagentsSrc, prompt), join(supportSubagentsDir, prompt)]);
                }
            }
            else {
                log(config, "Would require TLH subagent prompts before enabling bundled subagents in settings.");
            }
        }
        else {
            log(config, "Would skip TLH subagent prompts because this ref does not enable bundled subagents in settings.");
        }
        if (subagentExtensionConfigNeedsProvisioning(config)) {
            log(config, "Would provision missing TLH subagent extension defaults (extensions/subagent/config.json): toolDescriptionMode: compact; control.activeNoticeAfterMs: 270000 (4m30).");
        }
        else {
            log(config, "Would leave existing subagent extension config (extensions/subagent/config.json) untouched.");
        }
        return;
    }
    ensureSafeProfileDir(config, "tlh", "TLH support directory");
    for (const file of installableSupportFiles({ noSettings: config.noSettings })) {
        const sourcePath = config.supportFilePaths[file.variable];
        if (sourcePath)
            copySafeProfileFile(config, sourcePath, `tlh/${file.installName}`, `TLH support file ${file.installName}`);
    }
    provisionSubagentExtensionConfig(config);
    if (!requireSubagentPrompts)
        return;
    if (!subagentsSrc) {
        throw new Error("TLH subagent prompts not found; re-run installer from a complete checkout or package.");
    }
    const missingPrompts = missingTlhSubagentPrompts(subagentsSrc, { prompts: config.subagentPrompts });
    if (missingPrompts.length > 0) {
        throw new Error(`TLH subagent prompts are incomplete (${missingPrompts.join(" ")}); re-run installer from a complete checkout or package.`);
    }
    const installedSubagentsDir = copyTlhSubagentPrompts(config, subagentsSrc, { prompts: config.subagentPrompts });
    const installedMissing = missingTlhSubagentPrompts(installedSubagentsDir, { prompts: config.subagentPrompts });
    if (installedMissing.length > 0) {
        throw new Error(`failed to install TLH subagent prompts (${installedMissing.join(" ")}); re-run installer from a complete checkout or package.`);
    }
}
async function writeInstallState(config) {
    if (!config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT || !existsSync(config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT)) {
        if (!(await ensureSupportFilesPrepared(config, supportFileIo()))) {
            if (config.dryRun) {
                log(config, `Would write tlh update metadata: ${config.statePath}`);
                return;
            }
            throw new Error(`install-state support files are unavailable for ref ${config.ref}`);
        }
    }
    if (!config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT || !existsSync(config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT)) {
        if (config.dryRun) {
            log(config, `Would write tlh update metadata: ${config.statePath}`);
            return;
        }
        throw new Error(`install-state support script not found for ref ${config.ref}; re-run the installer from a release that includes scripts/tlh-install-state.mjs`);
    }
    const args = [
        "--state-path",
        config.statePath,
        "--repo",
        config.repo,
        "--ref",
        config.ref,
        "--track",
        config.updateTrack,
        "--package-source",
        config.packageSource,
        "--package-source-is-default",
        String(config.packageSourceIsDefault),
        "--raw-base",
        config.rawBase,
        "--agent-dir",
        config.agentDir,
        "--bin-dir",
        config.binDir,
        "--wrapper-name",
        config.wrapperName,
    ];
    const existingPiInstalledByTlhPreference = readPiInstalledByTlhPreference(config);
    const piInstalledByTlhForWrite = config.piInstalledByTlh === true || existingPiInstalledByTlhPreference === true
        ? true
        : config.piInstalledByTlh;
    // Write piInstalledByTlh when: (a) this run installed Pi, (b) TLH ownership is already
    // known to be true and must survive the full install-state rewrite, (c) an explicit override
    // was provided, or (d) the state file does not yet exist (genuine fresh install).
    const writePiInstalledByTlh = piInstalledByTlhForWrite === true
        || config.piInstalledByTlhOverride !== undefined
        || !existsSync(config.statePath);
    if (writePiInstalledByTlh && piInstalledByTlhForWrite !== undefined) {
        args.push("--pi-installed-by-tlh", String(piInstalledByTlhForWrite));
    }
    if (config.dryRun)
        args.push("--dry-run");
    if (config.quiet)
        args.push("--quiet");
    runNodeScript(config, config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT, args);
}
function outputLines(output) {
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function splitDefaultExtensionSources(sourcesOutput, criticalSourcesOutput) {
    const criticalSourceSet = new Set(outputLines(criticalSourcesOutput));
    const sources = outputLines(sourcesOutput);
    const criticalSources = [];
    const nonCriticalSources = [];
    for (const source of sources) {
        if (criticalSourceSet.has(source))
            criticalSources.push(source);
        else
            nonCriticalSources.push(source);
    }
    return { sources, criticalSources, nonCriticalSources };
}
function ensureCriticalGitSourceCheckout(config, source) {
    const spec = criticalGitSourceSpec(source, { agentDir: config.agentDir });
    if (!spec)
        return true;
    assertGitSourceTargetSafe(config, source, "critical git extension checkout", gitCheckoutIo());
    if (!spec.ref)
        return true;
    return refreshGitCheckout(config, {
        targetDir: spec.targetDir,
        repo: spec.repo,
        ref: spec.ref,
        label: "critical git extension checkout",
        missingMessage: `critical git extension checkout is missing or invalid: ${spec.targetDir}`,
        warnOnMissing: true,
    }, gitCheckoutIo());
}
function criticalDefaultGitSources(config, sources) {
    return sources.filter((source) => criticalGitSourceSpec(source, { agentDir: config.agentDir }));
}
function preflightCriticalDefaultExtensionTargets(config, sources) {
    const gitSources = criticalDefaultGitSources(config, sources);
    if (gitSources.length === 0)
        return;
    detailLog(config, `${config.dryRun ? "Would preflight" : "Preflighting"} ${gitSources.length} critical bundled default git checkout target(s) before any settings-wide default extension update.`);
    for (const source of gitSources) {
        assertGitSourceTargetSafe(config, source, "critical default extension package checkout", gitCheckoutIo());
    }
}
function installCriticalDefaultExtension(config, source) {
    verboseLog(config, `Installing critical bundled default extension package: ${source}`);
    const installSource = packageSourcePiSource(source, { agentDir: config.agentDir });
    assertGitSourceTargetSafe(config, source, "critical default extension package checkout", gitCheckoutIo());
    try {
        runIsolatedPi(config, [absolutePiCmd(config), "install", installSource]);
    }
    catch {
        throw new Error(`critical default extension package install failed: ${source}. Fix the package install and rerun the installer; this isolation-critical default cannot be disabled.`);
    }
    if (!ensureCriticalGitSourceCheckout(config, source)) {
        throw new Error(`critical default extension package checkout validation failed: ${source}. Fix the package checkout and rerun the installer; this isolation-critical default cannot be disabled.`);
    }
}
function updateDefaultExtensionSourceBestEffort(config, source) {
    verboseLog(config, `Installing bundled default extension package: ${source}`);
    try {
        runIsolatedPi(config, [absolutePiCmd(config), "update", source]);
        return true;
    }
    catch {
        warn(`default extension package update failed; continuing: ${source}`);
        return false;
    }
}
function updateDefaultExtensionSourcesBestEffort(config, sources) {
    let failures = 0;
    for (const source of sources) {
        if (!updateDefaultExtensionSourceBestEffort(config, source))
            failures += 1;
    }
    return failures;
}
function updateNonCriticalDefaultExtensions(config, sources) {
    if (sources.length === 0)
        return 0;
    const fallbackDescription = `${sources.length} non-critical bundled default source(s)`;
    if (config.dryRun) {
        log(config, "Dry run: settings-wide extension refresh will run from merged settings.");
    }
    else {
        verboseLog(config, `Running settings-wide extension refresh from merged settings; fallback retries only ${fallbackDescription} individually.`);
    }
    try {
        runIsolatedPi(config, [absolutePiCmd(config), "update", "--extensions"]);
    }
    catch {
        warn(`settings-wide extension refresh from merged settings failed; falling back to per-source updates for only ${fallbackDescription}`);
        return updateDefaultExtensionSourcesBestEffort(config, sources);
    }
    if (config.dryRun) {
        log(config, `If the settings-wide extension refresh fails, the installer would retry only ${fallbackDescription} individually.`);
    }
    return 0;
}
function installDefaultExtensions(config) {
    if (config.noSettings) {
        log(config, "Skipping bundled default extensions (--no-settings).");
        return;
    }
    if (!config.supportFilePaths.TLH_DEFAULTS_SCRIPT || !config.supportFilePaths.DEFAULT_EXTENSIONS_FILE) {
        if (config.dryRun)
            log(config, "Would install bundled default extension packages after settings merge.");
        return;
    }
    let sourcesOutput;
    let criticalSourcesOutput;
    try {
        sourcesOutput = runNodeScript(config, config.supportFilePaths.TLH_DEFAULTS_SCRIPT, [
            "--settings",
            config.settingsPath,
            "--defaults",
            config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
            "sources",
        ], { captureStdout: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to read bundled default extension sources: ${message}`, { cause: error });
    }
    try {
        criticalSourcesOutput = runNodeScript(config, config.supportFilePaths.TLH_DEFAULTS_SCRIPT, [
            "--settings",
            config.settingsPath,
            "--defaults",
            config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
            "critical-sources",
        ], { captureStdout: true });
    }
    catch (error) {
        if (defaultExtensionsFileRequiresCriticalInstall(config.supportFilePaths.DEFAULT_EXTENSIONS_FILE, {
            noSettings: config.noSettings,
        })) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`failed to read critical bundled default extension sources: ${message}`, { cause: error });
        }
        warn("installed default-extension helper does not support critical source queries; treating this ref as having no critical defaults.");
        criticalSourcesOutput = "";
    }
    const { sources, criticalSources, nonCriticalSources } = splitDefaultExtensionSources(sourcesOutput, criticalSourcesOutput);
    if (sources.length === 0) {
        log(config, "No bundled default extensions are enabled.");
        return;
    }
    log(config, `Installing bundled default extensions (${sources.length})...`);
    preflightCriticalDefaultExtensionTargets(config, criticalSources);
    const failures = updateNonCriticalDefaultExtensions(config, nonCriticalSources);
    if (failures !== 0)
        warn(`${failures} bundled default extension package(s) failed to update`);
    for (const source of criticalSources)
        installCriticalDefaultExtension(config, source);
    if (failures === 0)
        verboseLog(config, "Bundled default extensions installed.");
}
function gnosisInstallSkippedByEnv(config) {
    const value = config.env?.TLH_SKIP_GNOSIS_INSTALL;
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
function configureGnosis(config) {
    if (gnosisInstallSkippedByEnv(config)) {
        log(config, "Skipping Gnosis integration (TLH_SKIP_GNOSIS_INSTALL is set).");
        return;
    }
    if (!config.supportFilePaths.TLH_GNOSIS_SCRIPT || !existsSync(config.supportFilePaths.TLH_GNOSIS_SCRIPT)) {
        throw new Error(`required Gnosis support script not found for ref ${config.ref}: scripts/tlh-gnosis.mjs`);
    }
    const args = [
        "--agent-dir",
        config.agentDir,
        "--target",
        join(config.agentDir, "bin", "gn"),
        "--gnosis-repo",
        config.gnosisRepo,
        "--gnosis-version",
        config.gnosisVersion,
        "configure-install",
    ];
    if (config.dryRun)
        args.push("--dry-run", "--detail");
    else if (config.verbose)
        args.push("--detail");
    if (config.quiet)
        args.push("--quiet");
    try {
        config.gnosisSummary = runNodeScript(config, config.supportFilePaths.TLH_GNOSIS_SCRIPT, args, { captureStdout: true }).trimEnd();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to configure Gnosis integration: ${message}`, { cause: error });
    }
}
function configureTickets(config) {
    if (!config.supportFilePaths.TLH_TICKETS_SCRIPT) {
        if (config.dryRun && config.supportFilesDryRunSkipped) {
            log(config, "Would configure required tk ticket integration after fetching support files.");
            return;
        }
        throw new Error(`required tk ticket support script not found for ref ${config.ref}; re-run the installer from a release that includes scripts/tlh-tickets.mjs`);
    }
    const args = [
        "--settings",
        config.settingsPath,
        "--agent-dir",
        config.agentDir,
        "--target",
        join(config.agentDir, "bin", "tk"),
        "--wrapper-name",
        config.wrapperName,
        "configure-install",
    ];
    if (config.dryRun)
        args.push("--dry-run", "--detail");
    else if (config.verbose)
        args.push("--detail");
    if (config.quiet)
        args.push("--quiet");
    config.ticketsSummary = runNodeScript(config, config.supportFilePaths.TLH_TICKETS_SCRIPT, args, { captureStdout: true }).trimEnd();
}
function wrapperIsManaged(config) {
    if (!existsSync(config.wrapperPath))
        return false;
    try {
        const line = readFileSync(config.wrapperPath, "utf8").split(/\r?\n/)[2] || "";
        return line === "# Managed by The Last Harness installer";
    }
    catch {
        return false;
    }
}
function writeWrapperDryRunWithoutHelper(config) {
    if (existsSync(config.wrapperPath) && !wrapperIsManaged(config) && !config.force) {
        warn(`would not overwrite unmanaged existing wrapper: ${config.wrapperPath}`);
        return;
    }
    printCommand(["mkdir", "-p", config.binDir]);
    if (existsSync(config.wrapperPath))
        log(config, `Would overwrite wrapper: ${config.wrapperPath}`);
    else
        log(config, `Would create wrapper: ${config.wrapperPath}`);
}
async function writeWrapper(config) {
    if (config.noWrapper) {
        log(config, "Skipping wrapper creation (--no-wrapper).");
        return;
    }
    if (config.dryRun || config.verbose)
        log(config, `Installing wrapper command: ${config.wrapperPath}`);
    else
        log(config, "Creating wrapper command...");
    if (!config.supportFilePaths.TLH_WRAPPER_SCRIPT || !existsSync(config.supportFilePaths.TLH_WRAPPER_SCRIPT)) {
        if (!(await ensureSupportFilesPrepared(config, supportFileIo()))) {
            if (config.dryRun) {
                writeWrapperDryRunWithoutHelper(config);
                return;
            }
            throw new Error(`wrapper support files are unavailable for ref ${config.ref}`);
        }
    }
    if (!config.supportFilePaths.TLH_WRAPPER_SCRIPT || !existsSync(config.supportFilePaths.TLH_WRAPPER_SCRIPT)) {
        if (config.dryRun) {
            writeWrapperDryRunWithoutHelper(config);
            return;
        }
        throw new Error(`wrapper support script not found for ref ${config.ref}; re-run the installer from a release that includes scripts/tlh-wrapper.mjs`);
    }
    const args = [
        "--agent-dir",
        config.agentDir,
        "--bin-dir",
        config.binDir,
        "--wrapper-name",
        config.wrapperName,
        `--package-root=${config.packageHelperRoot}`,
    ];
    if (config.piCmd)
        args.push("--pi-cmd", config.piCmd);
    if (config.dryRun)
        args.push("--dry-run");
    if (config.force)
        args.push("--force");
    if (config.quiet)
        args.push("--quiet");
    runNodeScript(config, config.supportFilePaths.TLH_WRAPPER_SCRIPT, args);
}
function pathContainsBinDir(config) {
    return `:${config.env.PATH || ""}:`.includes(`:${config.binDir}:`);
}
function printSummary(config) {
    log(config, "");
    log(config, "Done. The Last Harness is ready.");
    if (!config.noWrapper) {
        if (pathContainsBinDir(config)) {
            log(config, `Start with: ${config.wrapperName}`);
        }
        else {
            warn(`${config.binDir} is not on PATH. Add it with: export PATH="${config.binDir}:$PATH"`);
            log(config, `Start with: ${config.wrapperName}`);
        }
        detailLog(config, `Wrapper: ${config.wrapperPath}`);
    }
    else {
        log(config, `Start with: PI_CODING_AGENT_DIR="${config.agentDir}" "${dirname(config.agentDir)}/runtime/bin/pi"`);
    }
    detailLog(config, `Settings: ${config.settingsPath}`);
    if (config.gnosisSummary)
        detailLog(config, config.gnosisSummary);
    if (config.ticketsSummary)
        detailLog(config, config.ticketsSummary);
    detailLog(config, "Normal Pi config was not modified: ~/.pi/agent");
    if (!config.noWrapper) {
        detailLog(config, `Uninstall: rm -f "${config.wrapperPath}" && rm -rf "${config.agentDir}"`);
    }
    else {
        detailLog(config, `Uninstall: rm -rf "${config.agentDir}"`);
    }
}
async function runInstallFlow(config) {
    log(config, "The Last Harness installer");
    detailLog(config, `Isolated profile: ${config.agentDir}`);
    if (!config.packageSourceIsDefault || config.verbose)
        log(config, `Package source: ${config.packageSource}`);
    verboseLog(config, `Repository: ${config.repo}`);
    verboseLog(config, `Update track: ${config.updateTrack}`);
    validateInputs(config);
    requireCommand(config, "npm");
    requireCommand(config, "git");
    await preflightRuntimeSupportFiles(config, supportFileIo());
    const piInstalledByTlhPreference = readPiInstalledByTlhPreference(config);
    const { installed: piInstalledByTlh, piCmd } = installPiIfNeeded(config);
    // A runtime installed by this run is always TLH-owned, even if an update passed through a
    // stale false/absent value from an older install-state. Otherwise preserve the explicit
    // override or previously recorded ownership state when present, and fall back to false only
    // for genuine fresh installs that reused an existing non-TLH Pi.
    config.piInstalledByTlh = piInstalledByTlh
        ? true
        : piInstalledByTlhPreference !== undefined
            ? piInstalledByTlhPreference
            : false;
    config.piCmd = piCmd;
    installHarnessPackage(config);
    await installSupportFilesToProfile(config);
    await mergeSettings(config);
    cleanupLegacyManagedProfileArtifacts(config);
    if (!config.noSettings)
        cleanupRetiredProfileFiles(config);
    if (!config.noSettings)
        cleanupOldSettingsBackups(config);
    await writeInstallState(config);
    installDefaultExtensions(config);
    configureGnosis(config);
    configureTickets(config);
    await writeWrapper(config);
    printSummary(config);
}
function printSupportManifest(config) {
    const manifest = formatSupportFileManifest({ noSettings: config.noSettings });
    process.stdout.write(`${manifest}\n`);
}
async function run(argv = process.argv.slice(2), env = process.env) {
    const parsedArgs = parseArgs(argv, env);
    if (parsedArgs.help) {
        process.stdout.write(usage());
        return;
    }
    assertSupportedNodeRuntime();
    const config = buildInstallConfig(parsedArgs, env);
    if (config.printSupportManifest) {
        printSupportManifest(config);
        return;
    }
    try {
        await runInstallFlow(config);
    }
    finally {
        if (config.tmpDir)
            rmSync(config.tmpDir, { recursive: true, force: true });
    }
}
function isMainModule() {
    if (!process.argv[1])
        return false;
    try {
        const scriptPath = realpathSync.native(resolve(process.argv[1]));
        const modulePath = realpathSync.native(fileURLToPath(import.meta.url));
        return scriptPath === modulePath;
    }
    catch {
        return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
    }
}
if (isMainModule()) {
    run().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`error: ${message}`);
        process.exitCode = 1;
    });
}
export { MIN_NODE_VERSION, RUNTIME_MARKER_FILENAME, RUNTIME_OWNED_TOPLEVEL, assertSupportedNodeRuntime, buildInstallConfig, expandPath, installDefaultExtensions, nodeVersionMeetsMinimum, parseArgs, run, usage, validateInputs, };
