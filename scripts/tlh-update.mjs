#!/usr/bin/env node
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const DEFAULT_WRAPPER_NAME = "tlh";
const VALID_TRACKS = new Set(["latest-release", "pinned-tag", "ref", "custom"]);
const DOWNLOAD_TIMEOUT_MS = 30_000;

function usage() {
	return `Usage: tlh update [options]

Run The Last Harness installer update flow for the current isolated profile.

Options:
  --agent-dir DIR       Isolated profile dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR         Wrapper install dir (default: ~/.local/bin)
  --wrapper-name NAME   Wrapper command name (default: tlh)
  --track TRACK         Override update track: latest-release, pinned-tag, ref, custom
  --ref REF             Override git ref/tag for pinned-tag or ref tracks
  --repo OWNER/REPO     Override GitHub repository
  --package-source SRC  Preserve a custom package source via TLH_PACKAGE_SOURCE
  --dry-run             Print the update plan without downloading or running installer
  --force               Pass --force to the installer
  --no-pi-install       Pass --no-pi-install to the installer
  --no-settings         Pass --no-settings to the installer
  --no-wrapper          Pass --no-wrapper to the installer
  --with-gnosis         Force install/re-enable Gnosis through the installer
  --without-gnosis      Opt out of Gnosis integration through the installer
  --no-gnosis           Alias for --without-gnosis
  --quiet               Suppress installer progress output
  --verbose             Show underlying installer output
  -h, --help            Show this help
`;
}

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function defaultAgentDir() {
	return process.env.TLH_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultBinDir() {
	return process.env.TLH_BIN_DIR || join(homedir(), ".local", "bin");
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseArgs(argv) {
	const args = {
		agentDir: defaultAgentDir(),
		binDir: defaultBinDir(),
		wrapperName: process.env.TLH_WRAPPER_NAME || DEFAULT_WRAPPER_NAME,
		repo: process.env.TLH_REPO,
		track: undefined,
		ref: undefined,
		packageSource: process.env.TLH_PACKAGE_SOURCE,
		dryRun: false,
		force: false,
		noPiInstall: false,
		noSettings: false,
		noWrapper: false,
		gnosisMode: undefined,
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
			continue;
		}
		if (arg === "--force") {
			args.force = true;
			continue;
		}
		if (arg === "--no-pi-install") {
			args.noPiInstall = true;
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
		if (arg === "--with-gnosis") {
			args.gnosisMode = "with";
			continue;
		}
		if (arg === "--without-gnosis" || arg === "--no-gnosis") {
			args.gnosisMode = "without";
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
		if (arg === "--agent-dir") {
			args.agentDir = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--bin-dir") {
			args.binDir = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--wrapper-name") {
			args.wrapperName = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--track") {
			args.track = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--ref") {
			args.ref = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--repo") {
			args.repo = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--package-source") {
			args.packageSource = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			args.agentDir = arg.slice("--agent-dir=".length);
			continue;
		}
		if (arg.startsWith("--bin-dir=")) {
			args.binDir = arg.slice("--bin-dir=".length);
			continue;
		}
		if (arg.startsWith("--wrapper-name=")) {
			args.wrapperName = arg.slice("--wrapper-name=".length);
			continue;
		}
		if (arg.startsWith("--track=")) {
			args.track = arg.slice("--track=".length);
			continue;
		}
		if (arg.startsWith("--ref=")) {
			args.ref = arg.slice("--ref=".length);
			continue;
		}
		if (arg.startsWith("--repo=")) {
			args.repo = arg.slice("--repo=".length);
			continue;
		}
		if (arg.startsWith("--package-source=")) {
			args.packageSource = arg.slice("--package-source=".length);
			continue;
		}
		throw new Error(`Unknown option for tlh update: ${arg}`);
	}

	args.agentDir = expandHome(args.agentDir);
	args.binDir = expandHome(args.binDir);
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

function readJson(path) {
	const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	return JSON.parse(content);
}

function packageSourceOf(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
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
	if (typeof source !== "string") return undefined;
	let value = source.trim();
	if (!value) return undefined;
	if (value.startsWith("git:")) value = value.slice("git:".length).trim();
	if (value.startsWith("git+")) value = value.slice("git+".length);

	let host = "";
	let repoPathWithRef = "";
	const scpLike = value.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] || "";
		repoPathWithRef = scpLike[2] || "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			host = parsed.hostname;
			repoPathWithRef = parsed.pathname.replace(/^\/+/, "");
			if (parsed.hash && !repoPathWithRef.includes("#")) {
				repoPathWithRef = `${repoPathWithRef}${parsed.hash}`;
			}
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = value.indexOf("/");
		if (slashIndex === -1) return undefined;
		host = value.slice(0, slashIndex);
		repoPathWithRef = value.slice(slashIndex + 1);
	}

	if (host !== "github.com") return undefined;
	const split = splitRefFromPath(repoPathWithRef);
	const repoPath = split.path.replace(/\.git$/, "").replace(/^\/+/, "");
	const segments = repoPath.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	return {
		repo: `${segments[0]}/${segments[1]}`,
		ref: split.ref,
	};
}

function trackForPackageRef(ref) {
	if (!ref) return "ref";
	return isSemverTag(ref) ? "pinned-tag" : "ref";
}

function normalizeState(raw, fallback = {}) {
	if (!raw || typeof raw !== "object") return undefined;
	const repo = typeof raw.repo === "string" && raw.repo.trim() ? raw.repo.trim() : fallback.repo;
	const track = typeof raw.track === "string" && raw.track.trim() ? raw.track.trim() : fallback.track;
	const ref = typeof raw.ref === "string" && raw.ref.trim() ? raw.ref.trim() : fallback.ref;
	const packageSource = typeof raw.packageSource === "string" && raw.packageSource.trim() ? raw.packageSource.trim() : fallback.packageSource;
	if (!repo || !track || !VALID_TRACKS.has(track)) return undefined;
	return {
		schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : undefined,
		repo,
		track,
		ref,
		packageSource,
		packageSourceIsDefault: raw.packageSourceIsDefault === true,
		inferred: raw.inferred === true,
	};
}

function inferStateFromSettings(agentDir, requestedRepo) {
	const path = settingsPath(agentDir);
	if (!existsSync(path)) return undefined;
	const settings = readJson(path);
	if (!Array.isArray(settings.packages)) return undefined;

	let fallback;
	for (const entry of settings.packages) {
		const source = packageSourceOf(entry);
		const parsed = parseGitHubPackageSource(source);
		if (!parsed) continue;
		const candidate = {
			schemaVersion: 1,
			repo: parsed.repo,
			track: trackForPackageRef(parsed.ref),
			ref: parsed.ref || "main",
			packageSource: source,
			packageSourceIsDefault: parsed.repo === DEFAULT_REPO,
			inferred: true,
		};
		if (requestedRepo && parsed.repo === requestedRepo) return candidate;
		if (parsed.repo === DEFAULT_REPO) return candidate;
		if (!fallback && parsed.repo.endsWith("/the-last-harness")) fallback = candidate;
	}
	return fallback;
}

function loadState(args) {
	const path = installStatePath(args.agentDir);
	if (existsSync(path)) {
		try {
			const state = normalizeState(readJson(path));
			if (state) return state;
		} catch (error) {
			if (!args.quiet) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`warning: could not read ${path}: ${message}`);
			}
		}
	}

	const inferred = inferStateFromSettings(args.agentDir, args.repo);
	if (inferred) return inferred;
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
	const changesStoredCustomTarget =
		state?.packageSourceIsDefault === false &&
		!args.packageSource &&
		((args.ref && args.ref !== state.ref) || (args.repo && args.repo !== state.repo) || (args.track && args.track !== state.track));
	if (changesStoredCustomTarget) {
		throw new Error(
			"This install uses a custom package source. Pass --package-source with any --track, --repo, or --ref override so package code and update metadata stay aligned.",
		);
	}

	if (!track || !VALID_TRACKS.has(track)) {
		throw new Error("Could not determine update track. Re-run the installer with --track latest-release, --track pinned-tag, or --track ref.");
	}
	if (track === "custom") {
		throw new Error(
			"This install is marked as a custom update track. Re-run the appropriate installer command manually, or run tlh update with --track, --ref, and --package-source overrides.",
		);
	}
	if ((track === "pinned-tag" || track === "ref") && !ref) {
		throw new Error(`Update track '${track}' requires a ref. Pass --ref <ref>.`);
	}
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
			ref,
			packageSource,
			packageSourceIsDefault,
			url: `https://github.com/${repo}/releases/download/${encodeURIComponent(ref)}/install.sh`,
		};
	}
	return {
		repo,
		track,
		ref,
		packageSource,
		packageSourceIsDefault,
		url: `https://raw.githubusercontent.com/${repo}/${encodePathRef(ref)}/install.sh`,
	};
}

function buildInstallerArgs(plan, args) {
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
		installerArgs.push("--ref", plan.ref);
	}
	if (args.force) installerArgs.push("--force");
	if (args.noPiInstall) installerArgs.push("--no-pi-install");
	if (args.noSettings) installerArgs.push("--no-settings");
	if (args.noWrapper) installerArgs.push("--no-wrapper");
	if (args.gnosisMode === "with") installerArgs.push("--with-gnosis");
	if (args.gnosisMode === "without") installerArgs.push("--without-gnosis");
	if (args.quiet) installerArgs.push("--quiet");
	if (args.verbose) installerArgs.push("--verbose");
	return installerArgs;
}

function shellQuote(value) {
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
	if (env.TLH_REPO) envParts.push(`TLH_REPO=${shellQuote(env.TLH_REPO)}`);
	if (env.TLH_PACKAGE_SOURCE) envParts.push(`TLH_PACKAGE_SOURCE=${shellQuote(env.TLH_PACKAGE_SOURCE)}`);
	const prefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
	console.log(`Would run: ${prefix}bash <downloaded install.sh> ${installerArgs.map(shellQuote).join(" ")}`);
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
	if (args.track && !VALID_TRACKS.has(args.track)) {
		throw new Error(`Invalid --track value: ${args.track}`);
	}

	const state = loadState(args);
	const plan = resolvePlan(state, args);
	const installerArgs = buildInstallerArgs(plan, args);
	const childEnv = {
		...process.env,
		TLH_REPO: plan.repo,
	};
	delete childEnv.TLH_REF;
	delete childEnv.TLH_RAW_BASE;
	delete childEnv.TLH_UPDATE_TRACK;
	if (plan.packageSource && !plan.packageSourceIsDefault) {
		childEnv.TLH_PACKAGE_SOURCE = plan.packageSource;
	} else if (args.packageSource) {
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
		if (args.verbose) console.log(`Installer: ${plan.url}`);
	}

	let temp;
	try {
		temp = await downloadInstaller(plan.url);
		const result = spawnSync("bash", [temp.installerPath, ...installerArgs], {
			stdio: "inherit",
			env: childEnv,
		});
		if (result.error) {
			throw result.error;
		}
		process.exitCode = result.status ?? (result.signal ? 1 : 0);
	} finally {
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
