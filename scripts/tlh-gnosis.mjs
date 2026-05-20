#!/usr/bin/env node
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

const VALIDATION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_GNOSIS_REPO = "skorokithakis/gnosis";

function usage() {
	return `Usage: tlh-gnosis.mjs <command>

Installer-internal helper for managing The Last Harness Gnosis integration.

Commands:
  install-managed      Install managed gn binary into the isolated profile (installer internal)
  configure-install    Ensure a usable gn binary is available for the isolated profile (installer internal)
  validate [path]      Validate a gnosis binary, or print the first valid candidate

Options:
  --agent-dir <dir>    Isolated Pi agent dir (default: ~/.the-last-harness/agent, or PI_CODING_AGENT_DIR)
  --target <path>      Managed gn install target (default: <agent-dir>/bin/gn)
  --gnosis-repo <r>    Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)
  --gnosis-version <v> Gnosis version to install (default: latest)
  --detail             Print verbose/dry-run installer details
  --dry-run            Print intended changes without writing
  --quiet              Only print errors
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		agentDir: undefined,
		target: undefined,
		gnosisRepo: process.env.TLH_GNOSIS_REPO || DEFAULT_GNOSIS_REPO,
		gnosisVersion: process.env.TLH_GNOSIS_VERSION || "latest",
		command: undefined,
		commandArgs: [],
		dryRun: false,
		detail: false,
		quiet: false,
		help: false,
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
		if (arg === "--detail") {
			args.detail = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			continue;
		}
		if (arg === "--agent-dir") {
			args.agentDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			args.agentDir = arg.slice("--agent-dir=".length);
			continue;
		}
		if (arg === "--target") {
			args.target = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--target=")) {
			args.target = arg.slice("--target=".length);
			continue;
		}
		if (arg === "--gnosis-repo") {
			args.gnosisRepo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--gnosis-repo=")) {
			args.gnosisRepo = arg.slice("--gnosis-repo=".length);
			continue;
		}
		if (arg === "--gnosis-version") {
			args.gnosisVersion = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--gnosis-version=")) {
			args.gnosisVersion = arg.slice("--gnosis-version=".length);
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (!args.command) {
			args.command = arg;
		} else {
			args.commandArgs.push(arg);
		}
	}

	return args;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(argAgentDir) {
	return expandHome(argAgentDir || process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent"));
}

function candidateCommands(agentDir) {
	const candidates = [join(agentDir, "bin", "gn"), "gn"];
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command) {
	for (const args of [["help", "plan"], ["help", "review"]]) {
		const result = spawnSync(command, args, { stdio: "ignore", timeout: VALIDATION_TIMEOUT_MS });
		if (result.error || result.status !== 0) return false;
	}
	return true;
}

function commandPath(command) {
	const result = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim().split(/\r?\n/)[0] || undefined;
}

function normalizeValidCandidate(candidate) {
	if (candidate === "gn") return commandPath("gn") || candidate;
	return candidate;
}

function findValidGnosis(agentDir) {
	for (const candidate of candidateCommands(agentDir)) {
		if (validateGnosisCommand(candidate)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function managedGnosisTargetPath(args, agentDir) {
	const agentRoot = resolve(expandHome(agentDir));
	return resolve(expandHome(args.target || join(agentRoot, "bin", "gn")));
}

function findValidGnosisForConfigure(args, agentDir) {
	const managedTarget = validateManagedGnosisTarget(args, agentDir);
	for (const candidate of [managedTarget, "gn"]) {
		if (validateGnosisCommand(candidate)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function logStderr(args, message) {
	if (!args.quiet) console.error(message);
}

function warnStderr(message) {
	console.error(`warning: ${message}`);
}

function gnosisPlatform() {
	let os;
	if (process.platform === "darwin") os = "darwin";
	else if (process.platform === "linux") os = "linux";
	else return undefined;

	let arch;
	if (process.arch === "arm64") arch = "arm64";
	else if (process.arch === "x64") arch = "amd64";
	else return undefined;

	return { os, arch };
}

function unsupportedGnosisPlatformMessage() {
	return `Unsupported platform for managed Gnosis install: ${process.platform}/${process.arch}. Prebuilt gn binaries are only available for darwin/linux on x64/arm64.`;
}

async function fetchWithTimeout(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			"User-Agent": "tlh-gnosis-installer",
			...(options.headers || {}),
		},
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return response;
}

async function resolveGnosisVersion(args) {
	if (args.gnosisVersion && args.gnosisVersion !== "latest") {
		return args.gnosisVersion.replace(/^v/, "");
	}

	const response = await fetchWithTimeout(`https://github.com/${args.gnosisRepo}/releases/latest`, { method: "HEAD", redirect: "follow" });
	const latestUrl = response.url || "";
	const version = latestUrl.split("/").pop()?.replace(/^v/, "");
	if (!version || version === "latest") {
		throw new Error("latest release redirect did not include a version");
	}
	return version;
}

async function downloadToFile(url, path) {
	const response = await fetchWithTimeout(url);
	const content = Buffer.from(await response.arrayBuffer());
	writeFileSync(path, content);
}

async function fetchText(url) {
	const response = await fetchWithTimeout(url);
	return response.text();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function checksumForAsset(checksumsText, assetName) {
	for (const line of checksumsText.split(/\r?\n/)) {
		const [checksum, filename] = line.trim().split(/\s+/);
		if (!checksum || !filename) continue;
		if (filename.replace(/^\.\//, "") === assetName) return checksum;
	}
	return undefined;
}

async function verifyGnosisArchive(args, archivePath, assetName, version) {
	const checksumsUrl = `https://github.com/${args.gnosisRepo}/releases/download/v${version}/checksums.txt`;
	const checksumsText = await fetchText(checksumsUrl);
	const expected = checksumForAsset(checksumsText, assetName);
	if (!expected) {
		throw new Error(`Gnosis checksums did not include ${assetName}`);
	}
	const actual = sha256File(archivePath);
	if (actual !== expected) {
		throw new Error(`Gnosis checksum verification failed for ${assetName}`);
	}
}

function extractTarGzip(archivePath, extractDir) {
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "ignore" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to extract Gnosis release archive");
}

function findFileNamed(root, name) {
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			const found = findFileNamed(path, name);
			if (found) return found;
		} else if (stats.isFile() && entry === name) {
			return path;
		}
	}
	return undefined;
}

function resolvedManagedAgentDir(agentDir) {
	return realpathForCompare(resolve(expandHome(agentDir)));
}

function assertManagedGnosisTempPath(path, agentDir, label, { mustExist = false, expectDirectory = false, expectFile = false } = {}) {
	const stats = lstatIfExists(path);
	if (!stats) {
		if (mustExist) {
			throw new Error(`Refusing to install managed Gnosis because temporary ${label} was not created: ${path}`);
		}
	} else {
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed Gnosis through symlinked temporary ${label}: ${path}`);
		}
		if (expectDirectory && !stats.isDirectory()) {
			throw new Error(`Refusing to install managed Gnosis because temporary ${label} is not a directory: ${path}`);
		}
		if (expectFile && !stats.isFile()) {
			throw new Error(`Refusing to install managed Gnosis because temporary ${label} is not a file: ${path}`);
		}
	}

	const resolvedAgentDir = resolvedManagedAgentDir(agentDir);
	const resolvedPath = stats ? realpathSync(path) : realpathForCompare(path);
	if (!isPathInsideOrEqual(resolvedPath, resolvedAgentDir)) {
		throw new Error(`Refusing to install managed Gnosis because temporary ${label} resolves outside the isolated tlh profile: ${path} (resolves to ${resolvedPath}; profile: ${resolvedAgentDir})`);
	}
}

function createManagedGnosisTempTarget(args, agentDir, target) {
	validateManagedGnosisTarget(args, agentDir);
	const targetParent = dirname(target);
	mkdirSync(targetParent, { recursive: true });
	validateManagedGnosisTarget(args, agentDir);

	const tempDir = mkdtempSync(join(targetParent, ".tlh-gnosis-"));
	assertManagedGnosisTempPath(tempDir, agentDir, "install directory", { mustExist: true, expectDirectory: true });

	const tempTarget = join(tempDir, "gn");
	assertManagedGnosisTempPath(tempTarget, agentDir, "binary", { mustExist: false });
	return { tempDir, tempTarget };
}

function copyFileExclusive(source, target, mode) {
	let fd;
	try {
		const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag, mode);
		writeFileSync(fd, readFileSync(source));
		fchmodSync(fd, mode);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

async function installManagedGnosis(args, agentDir) {
	const target = validateManagedGnosisTarget(args, agentDir);
	const platform = gnosisPlatform();
	if (!platform) throw new Error(unsupportedGnosisPlatformMessage());

	if (args.dryRun) {
		logStderr(args, `Would install Gnosis into isolated profile: ${target}`);
		logStderr(args, `Would download latest compatible release from https://github.com/${args.gnosisRepo}`);
		return target;
	}

	let version;
	try {
		version = await resolveGnosisVersion(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(`could not resolve latest Gnosis release; install manually from https://github.com/${args.gnosisRepo} (${message})`);
		return undefined;
	}

	const assetName = `gnosis_${version}_${platform.os}_${platform.arch}.tar.gz`;
	const url = `https://github.com/${args.gnosisRepo}/releases/download/v${version}/${assetName}`;
	let downloadTempDir;
	let installTempDir;
	let tempTarget;

	try {
		downloadTempDir = mkdtempSync(join(tmpdir(), "tlh-gnosis-"));
		const archivePath = join(downloadTempDir, "gnosis.tar.gz");
		const extractDir = join(downloadTempDir, "extract");
		mkdirSync(extractDir, { recursive: true });

		logStderr(args, `Installing Gnosis ${version} into isolated profile: ${target}`);
		await downloadToFile(url, archivePath);
		await verifyGnosisArchive(args, archivePath, assetName, version);
		extractTarGzip(archivePath, extractDir);

		const extracted = findFileNamed(extractDir, "gn");
		if (!extracted) throw new Error("Gnosis release archive did not contain a gn binary");

		({ tempDir: installTempDir, tempTarget } = createManagedGnosisTempTarget(args, agentDir, target));
		copyFileExclusive(extracted, tempTarget, 0o755);
		assertManagedGnosisTempPath(tempTarget, agentDir, "binary", { mustExist: true, expectFile: true });
		if (!validateGnosisCommand(tempTarget)) {
			throw new Error("downloaded Gnosis binary did not validate");
		}

		assertManagedGnosisTempPath(tempTarget, agentDir, "binary", { mustExist: true, expectFile: true });
		const finalTarget = validateManagedGnosisTarget(args, agentDir);
		renameSync(tempTarget, finalTarget);
		return finalTarget;
	} catch (error) {
		if (tempTarget) rmSync(tempTarget, { force: true });
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(message);
		return undefined;
	} finally {
		if (installTempDir) rmSync(installTempDir, { recursive: true, force: true });
		if (downloadTempDir) rmSync(downloadTempDir, { recursive: true, force: true });
	}
}

async function commandInstallManaged(args, agentDir) {
	const installedPath = await installManagedGnosis(args, agentDir);
	if (!installedPath) {
		process.exitCode = 1;
		return;
	}
	console.log(installedPath);
}

function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function isUnderNormalPiConfig(path) {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedPath = realpathForCompare(path);
	return resolvedPath === normalPiRoot || resolvedPath.startsWith(`${normalPiRoot}${sep}`);
}

function assertNotNormalPiPath(path, label) {
	if (isUnderNormalPiConfig(path)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness gnosis command (${label}): ${path}`);
	}
}

function lstatIfExists(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && ["ENOENT", "ENOTDIR"].includes(error.code)) return undefined;
		throw error;
	}
}

function isPathInsideOrEqual(path, root) {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function assertManagedGnosisAgentDir(agentDir) {
	const stats = lstatIfExists(agentDir);
	if (!stats) return;

	let directoryStats = stats;
	if (stats.isSymbolicLink()) {
		try {
			directoryStats = statSync(agentDir);
		} catch {
			throw new Error(`Refusing to install managed Gnosis because agent dir does not resolve to a directory: ${agentDir}`);
		}
	}

	if (!directoryStats.isDirectory()) {
		throw new Error(`Refusing to install managed Gnosis because agent dir is not a directory: ${agentDir}`);
	}
}

function assertNoSymlinkedManagedTargetParents(target, boundary) {
	const parent = dirname(target);
	if (!isPathInsideOrEqual(parent, boundary)) return;

	const relativeParent = relative(boundary, parent);
	if (!relativeParent) return;

	let current = boundary;
	for (const part of relativeParent.split(sep).filter(Boolean)) {
		current = join(current, part);
		const stats = lstatIfExists(current);
		if (!stats) return;
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed Gnosis through symlinked target parent component: ${current}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to install managed Gnosis because target parent component is not a directory: ${current}`);
		}
	}
}

function validateManagedGnosisTarget(args, agentDir) {
	const agentRoot = resolve(expandHome(agentDir));
	const target = managedGnosisTargetPath(args, agentDir);

	assertNotNormalPiPath(agentRoot, "agent dir");
	assertNotNormalPiPath(target, "managed gn target");
	if (!isPathInsideOrEqual(target, agentRoot)) {
		throw new Error(`Refusing to install managed Gnosis outside the configured tlh profile path: ${target} (profile: ${agentRoot})`);
	}
	assertManagedGnosisAgentDir(agentRoot);

	const targetStats = lstatIfExists(target);
	if (targetStats?.isSymbolicLink()) {
		throw new Error(`Refusing to install managed Gnosis over symlinked target file: ${target}`);
	}
	if (targetStats && !targetStats.isFile()) {
		throw new Error(`Refusing to install managed Gnosis over non-file target: ${target}`);
	}

	const resolvedAgentDir = realpathForCompare(agentRoot);
	assertNoSymlinkedManagedTargetParents(target, agentRoot);
	assertNoSymlinkedManagedTargetParents(target, resolvedAgentDir);

	const resolvedTarget = realpathForCompare(target);
	if (!isPathInsideOrEqual(resolvedTarget, resolvedAgentDir)) {
		throw new Error(`Refusing to install managed Gnosis outside the isolated tlh profile: ${target} (resolves to ${resolvedTarget}; profile: ${resolvedAgentDir})`);
	}

	return target;
}

function detailLog(args, message) {
	if (!args.quiet && args.detail) console.error(message);
}

function gnosisInstallSkippedByEnv() {
	const value = process.env.TLH_SKIP_GNOSIS_INSTALL;
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function commandConfigureInstall(args, agentDir) {
	if (gnosisInstallSkippedByEnv()) {
		console.log("Gnosis integration: skipped (TLH_SKIP_GNOSIS_INSTALL is set)");
		return;
	}

	const validPath = findValidGnosisForConfigure(args, agentDir);
	if (validPath) {
		detailLog(args, `Found valid Gnosis binary: ${validPath}`);
		console.log(`Gnosis integration: ready (${validPath})`);
		return;
	}

	const managedPath = await installManagedGnosis(args, agentDir);
	if (managedPath) {
		console.log(`Gnosis integration: ready (${managedPath})`);
		return;
	}

	process.stderr.write("error: Gnosis managed install failed; cannot continue without a valid gn binary. Set TLH_SKIP_GNOSIS_INSTALL=1 to skip.\n");
	process.exitCode = 1;
}

function commandValidate(agentDir, commandArgs) {
	const candidate = commandArgs[0];
	if (candidate) {
		if (!validateGnosisCommand(candidate)) {
			process.exitCode = 1;
			return;
		}
		console.log(candidate);
		return;
	}

	const valid = findValidGnosis(agentDir);
	if (!valid) {
		process.exitCode = 1;
		return;
	}
	console.log(valid);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const agentDir = resolve(getAgentDir(args.agentDir));

	if (args.command === "validate") {
		commandValidate(agentDir, args.commandArgs);
		return;
	}
	if (args.command === "install-managed") {
		await commandInstallManaged(args, agentDir);
		return;
	}
	if (args.command === "configure-install") {
		await commandConfigureInstall(args, agentDir);
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`tlh-gnosis: ${message}`);
	process.exit(1);
});
