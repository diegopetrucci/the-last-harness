#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { readDefaultExtensions } from "./lib/default-extensions.mjs";
import { parseGitSource } from "./lib/tlh-install-package-source.mjs";
import { requiredValue } from "./lib/tlh-install-utils.mjs";

const EXACT_VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_TOKEN_RE =
  /(?:^|[^0-9A-Za-z])((?:v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?))(?=$|[^0-9A-Za-z])/;
const COMMIT_SHA_GIT_REF_RE = /^[0-9a-f]{7,40}$/i;
const FLOATING_GIT_REF_RE = /^(?:head|latest|main|master|trunk|develop)$/i;
const BRANCH_LIKE_GIT_REF_RE =
  /^(?:feature|features|release|releases|hotfix|bugfix|fix|feat|chore|develop|dev)(?:$|[/-])/i;
const DEFAULT_GNOSIS_SCRIPT_PATHS = Object.freeze([
  "scripts/tlh-gnosis.mts",
  "scripts/tlh-gnosis.mjs",
  "scripts/tlh-install.mjs",
]);
const DEFAULT_PI_INSTALL_SCRIPT_PATHS = Object.freeze([
  "scripts/tlh-install.mts",
  "scripts/tlh-install.mjs",
]);
const DEFAULT_MODEL_SELECTION_SCOPE_PATH = "extensions/the-last-harness/model-selection-scope.ts";
const DEFAULT_INSTALL_SH_PATH = "install.sh";
const MANAGED_PI_DEPENDENCIES = Object.freeze([
  { field: "peerDependencies", name: "@earendil-works/pi-coding-agent" },
  { field: "devDependencies", name: "@earendil-works/pi-coding-agent" },
  { field: "devDependencies", name: "@earendil-works/pi-agent-core" },
  { field: "devDependencies", name: "@earendil-works/pi-ai" },
  { field: "peerDependencies", name: "@earendil-works/pi-tui" },
  { field: "devDependencies", name: "@earendil-works/pi-tui" },
]);
const PI_CODING_AGENT_LOCK_PATH = "node_modules/@earendil-works/pi-coding-agent";
const ALLOWED_LOCAL_DEPENDENCY_PREFIXES = Object.freeze(["file:", "link:", "workspace:"]);

function usage() {
  return `Usage: node scripts/check-package-versions.mjs [options]

Validate tracked version metadata and TLH-managed dependency pins.

Options:
  --package <path>             package.json path (default: package.json)
  --lockfile <path>            package-lock.json path (default: package-lock.json)
  --default-extensions <path>  Bundled default-extension manifest (default: config/default-extensions.json)
  --install-sh <path>          install.sh path for TLH_PINNED_PI_VERSION validation (default: install.sh)
  --model-selection-scope <path> Authoritative model-selection scope to validate PINNED_PI_VERSION in (default: extensions/the-last-harness/model-selection-scope.ts)
  --node-modules-dir <path>    node_modules directory to check installed versions against (default: derived from --package path)
  --gnosis-script <path>       Managed Gnosis script to validate (repeatable; defaults: scripts/tlh-gnosis.mts, scripts/tlh-gnosis.mjs, scripts/tlh-install.mjs)
  --pi-install-script <path>   TLH install script to validate PINNED_PI_VERSION in (repeatable; defaults: scripts/tlh-install.mts, scripts/tlh-install.mjs)
  --runtime-manifest-dir <dir> Directory with package.json+package-lock.json for Pi runtime lock validation (default: config/pi-runtime; pass "" to skip)
  -h, --help                   Show this help
`;
}

function parseArgs(argv) {
  const args = {
    packagePath: "package.json",
    lockfilePath: "package-lock.json",
    defaultExtensionsPath: "config/default-extensions.json",
    installShPath: DEFAULT_INSTALL_SH_PATH,
    modelSelectionScopePath: DEFAULT_MODEL_SELECTION_SCOPE_PATH,
    nodeModulesDir: "",
    runtimeManifestDir: "config/pi-runtime",
    gnosisScriptPaths: [...DEFAULT_GNOSIS_SCRIPT_PATHS],
    piInstallScriptPaths: [...DEFAULT_PI_INSTALL_SCRIPT_PATHS],
    help: false,
  };
  let customGnosisScripts = false;
  let customPiInstallScripts = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--package") {
      args.packagePath = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--lockfile") {
      args.lockfilePath = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--default-extensions") {
      args.defaultExtensionsPath = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--install-sh") {
      args.installShPath = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--model-selection-scope") {
      args.modelSelectionScopePath = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--node-modules-dir") {
      args.nodeModulesDir = requiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === "--runtime-manifest-dir") {
      // Empty string is a valid value meaning "skip runtime manifest check"
      args.runtimeManifestDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--gnosis-script") {
      if (!customGnosisScripts) {
        args.gnosisScriptPaths = [];
        customGnosisScripts = true;
      }
      args.gnosisScriptPaths.push(requiredValue(argv, index + 1, arg));
      index += 1;
      continue;
    }
    if (arg === "--pi-install-script") {
      if (!customPiInstallScripts) {
        args.piInstallScriptPaths = [];
        customPiInstallScripts = true;
      }
      args.piInstallScriptPaths.push(requiredValue(argv, index + 1, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--package=")) {
      args.packagePath = arg.slice("--package=".length);
      if (!args.packagePath) throw new Error("--package requires a value");
      continue;
    }
    if (arg.startsWith("--lockfile=")) {
      args.lockfilePath = arg.slice("--lockfile=".length);
      if (!args.lockfilePath) throw new Error("--lockfile requires a value");
      continue;
    }
    if (arg.startsWith("--default-extensions=")) {
      args.defaultExtensionsPath = arg.slice("--default-extensions=".length);
      if (!args.defaultExtensionsPath) throw new Error("--default-extensions requires a value");
      continue;
    }
    if (arg.startsWith("--install-sh=")) {
      args.installShPath = arg.slice("--install-sh=".length);
      if (!args.installShPath) throw new Error("--install-sh requires a value");
      continue;
    }
    if (arg.startsWith("--model-selection-scope=")) {
      args.modelSelectionScopePath = arg.slice("--model-selection-scope=".length);
      if (!args.modelSelectionScopePath)
        throw new Error("--model-selection-scope requires a value");
      continue;
    }
    if (arg.startsWith("--node-modules-dir=")) {
      args.nodeModulesDir = arg.slice("--node-modules-dir=".length);
      if (!args.nodeModulesDir) throw new Error("--node-modules-dir requires a value");
      continue;
    }
    if (arg.startsWith("--runtime-manifest-dir=")) {
      // Empty string value means "skip runtime manifest check"
      args.runtimeManifestDir = arg.slice("--runtime-manifest-dir=".length);
      continue;
    }
    if (arg.startsWith("--gnosis-script=")) {
      const value = arg.slice("--gnosis-script=".length);
      if (!value) throw new Error("--gnosis-script requires a value");
      if (!customGnosisScripts) {
        args.gnosisScriptPaths = [];
        customGnosisScripts = true;
      }
      args.gnosisScriptPaths.push(value);
      continue;
    }
    if (arg.startsWith("--pi-install-script=")) {
      const value = arg.slice("--pi-install-script=".length);
      if (!value) throw new Error("--pi-install-script requires a value");
      if (!customPiInstallScripts) {
        args.piInstallScriptPaths = [];
        customPiInstallScripts = true;
      }
      args.piInstallScriptPaths.push(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTextFile(path) {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${path}: ${message}`, { cause: error });
  }
}

function readJsonFile(path) {
  const raw = readTextFile(path);

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`, { cause: error });
  }
}

function readRequiredVersion(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing string version at ${label}`);
  }
  return value;
}

function versionEntries({ packagePath, lockfilePath }, packageJson, packageLock) {
  return [
    {
      label: `${packagePath}#version`,
      value: readRequiredVersion(packageJson.version, `${packagePath}#version`),
    },
    {
      label: `${lockfilePath}#version`,
      value: readRequiredVersion(packageLock.version, `${lockfilePath}#version`),
    },
    {
      label: `${lockfilePath}#packages[""].version`,
      value: readRequiredVersion(
        packageLock.packages?.[""]?.version,
        `${lockfilePath}#packages[""].version`,
      ),
    },
  ];
}

function assertMatchingVersions(entries) {
  const distinctVersions = new Set(entries.map(({ value }) => value));
  if (distinctVersions.size <= 1) return entries[0].value;

  const details = entries
    .map(({ label, value }) => `  - ${label}: ${JSON.stringify(value)}`)
    .join("\n");
  throw new Error(`Version metadata mismatch:\n${details}`);
}

function isPinnedExactVersion(value) {
  return EXACT_VERSION_RE.test(String(value ?? "").trim());
}

function splitNpmPackageSpec(spec) {
  const text = String(spec ?? "")
    .trim()
    .replace(/^npm:/, "")
    .trim();
  if (!text) return { name: "", version: "" };
  if (text.startsWith("@")) {
    const secondAt = text.indexOf("@", 1);
    if (secondAt === -1) return { name: text, version: "" };
    return {
      name: text.slice(0, secondAt),
      version: text.slice(secondAt + 1),
    };
  }
  const separator = text.lastIndexOf("@");
  if (separator === -1) return { name: text, version: "" };
  return {
    name: text.slice(0, separator),
    version: text.slice(separator + 1),
  };
}

function isExactRegistryDependencySpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (isPinnedExactVersion(trimmed)) return true;
  if (!trimmed.startsWith("npm:")) return false;

  const { name, version } = splitNpmPackageSpec(trimmed);
  return Boolean(name) && isPinnedExactVersion(version);
}

function extractExactVersionToken(value) {
  const match = String(value ?? "").match(VERSION_TOKEN_RE);
  return match?.[1] || "";
}

function hasAllowedLocalDependencyPrefix(spec) {
  const trimmed = String(spec ?? "").trim();
  return ALLOWED_LOCAL_DEPENDENCY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseGithubDependencySpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed.startsWith("github:")) return undefined;

  const source = trimmed.slice("github:".length).trim();
  if (!source) return undefined;
  const hashIndex = source.lastIndexOf("#");
  if (hashIndex < 0) return { repo: source, ref: "" };
  return {
    repo: source.slice(0, hashIndex).trim(),
    ref: source.slice(hashIndex + 1).trim(),
  };
}

function stripArchiveExtension(value) {
  return String(value ?? "").replace(/\.(?:tar\.gz|tgz|zip)$/i, "");
}

function isPinnedGitRef(ref) {
  const trimmed = String(ref ?? "").trim();
  if (!trimmed) return false;
  if (/^semver:/i.test(trimmed)) {
    return isPinnedExactVersion(trimmed.slice("semver:".length).trim());
  }
  if (/^refs\/tags\//i.test(trimmed)) {
    return isPinnedGitRef(trimmed.slice("refs/tags/".length));
  }
  if (/^refs\/heads\//i.test(trimmed) || /^heads\//i.test(trimmed)) return false;
  if (COMMIT_SHA_GIT_REF_RE.test(trimmed)) return true;
  if (trimmed.includes("/")) return false;
  if (FLOATING_GIT_REF_RE.test(trimmed) || BRANCH_LIKE_GIT_REF_RE.test(trimmed)) return false;
  return Boolean(extractExactVersionToken(trimmed));
}

function isPinnedGitLikeDependencySpec(spec) {
  const trimmed = String(spec ?? "").trim();
  const githubSpec = parseGithubDependencySpec(trimmed);
  if (githubSpec) {
    return Boolean(githubSpec.repo) && isPinnedGitRef(githubSpec.ref);
  }

  const normalized = trimmed.startsWith("git+") ? trimmed.slice(4) : trimmed;
  const gitSource = parseGitSource(normalized);
  return Boolean(gitSource) && isPinnedGitRef(gitSource.ref);
}

function isPinnedUrlDependencySpec(spec) {
  const trimmed = String(spec ?? "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  const pathname = decodeURIComponent(parsed.pathname || "");
  if (/\/releases\/latest(?:\/|$)/i.test(pathname)) return false;
  const segments = pathname.split("/").filter(Boolean);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "download" && segments[index - 1] === "releases") {
      return isPinnedGitRef(stripArchiveExtension(segments[index + 1] || ""));
    }
    if (segment === "archive" || segment === "tarball" || segment === "zipball") {
      if (segments[index + 1] === "refs") {
        if (segments[index + 2] === "tags") {
          return isPinnedGitRef(stripArchiveExtension(segments[index + 3] || ""));
        }
        if (segments[index + 2] === "heads") {
          return false;
        }
        return false;
      }
      if (segments[index + 1]) {
        return isPinnedGitRef(stripArchiveExtension(segments[index + 1] || ""));
      }
    }
  }

  return Boolean(extractExactVersionToken(pathname));
}

function isPinnedDependencySpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) return false;
  if (isPinnedExactVersion(trimmed)) return true;
  if (trimmed.startsWith("npm:")) {
    const { name, version } = splitNpmPackageSpec(trimmed);
    return Boolean(name) && isPinnedExactVersion(version);
  }
  if (hasAllowedLocalDependencyPrefix(trimmed)) return true;
  if (trimmed.startsWith("http:") || trimmed.startsWith("https:")) {
    return isPinnedUrlDependencySpec(trimmed);
  }
  return isPinnedGitLikeDependencySpec(trimmed);
}

function validatePinnedDependencyMap(value, label, problems, allowNested) {
  if (!isPlainObject(value)) {
    problems.push(`${label} must be an object`);
    return;
  }

  for (const [name, spec] of Object.entries(value)) {
    const dependencyLabel = `${label}.${name}`;
    if (allowNested && isPlainObject(spec)) {
      validatePinnedDependencyMap(spec, dependencyLabel, problems, true);
      continue;
    }
    if (typeof spec !== "string" || spec.trim().length === 0) {
      problems.push(`Missing string dependency spec at ${dependencyLabel}`);
      continue;
    }
    if (!isPinnedDependencySpec(spec)) {
      problems.push(
        `${dependencyLabel} must use an exact version or pinned non-registry source, found ${JSON.stringify(spec)}`,
      );
    }
  }
}

function validatePinnedDependencies(packageJson, packagePath, problems) {
  for (const field of ["dependencies", "devDependencies", "overrides"]) {
    const value = packageJson[field];
    if (value === undefined) continue;
    validatePinnedDependencyMap(value, `${packagePath}#${field}`, problems, field === "overrides");
  }
}

function validateDefaultExtensionPins(defaultExtensionsPath, problems) {
  let defaultExtensions;
  try {
    defaultExtensions = readDefaultExtensions(defaultExtensionsPath);
  } catch (error) {
    problems.push(error.message);
    return;
  }

  for (const extension of defaultExtensions) {
    const label = `${defaultExtensionsPath}#${extension.id}.source`;
    if (extension.source.startsWith("npm:")) {
      const { name, version } = splitNpmPackageSpec(extension.source);
      if (!name || !isPinnedExactVersion(version)) {
        problems.push(
          `${label} must pin npm defaults to an exact version, found ${JSON.stringify(extension.source)}`,
        );
      }
      continue;
    }

    const gitSource = parseGitSource(extension.source);
    if (!gitSource) {
      problems.push(
        `${label} must use a pinned npm or git source, found ${JSON.stringify(extension.source)}`,
      );
      continue;
    }
    if (!gitSource.ref) {
      problems.push(
        `${label} must pin git defaults to an explicit ref, found ${JSON.stringify(extension.source)}`,
      );
      continue;
    }
    if (!isPinnedGitRef(gitSource.ref)) {
      problems.push(
        `${label} must pin git defaults to a tag- or commit-like ref, found ${JSON.stringify(extension.source)}`,
      );
    }
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readDeclaredStringConstant(path, name) {
  const source = readTextFile(path);
  const pattern = new RegExp(`(?:^|\\n)const\\s+${escapeRegex(name)}\\s*=\\s*["']([^"'\\n]+)["'];`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Missing ${name} constant in ${path}`);
  }
  return match[1];
}

function readShellStringVariable(path, name) {
  const source = readTextFile(path);
  const pattern = new RegExp(`(?:^|\\n)${escapeRegex(name)}="([^"\\n]+)"(?:$|\\n)`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Missing ${name} variable in ${path}`);
  }
  return match[1];
}

function validatePinnedManagedScriptDefaults(scriptPaths, constantName, label, problems) {
  const versions = [];
  for (const path of scriptPaths) {
    let version;
    try {
      version = readDeclaredStringConstant(path, constantName);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    versions.push({ path, version });
    if (!isPinnedExactVersion(version)) {
      problems.push(
        `${path}#${constantName} must use an exact version, found ${JSON.stringify(version)}`,
      );
    }
  }

  const distinctVersions = new Set(versions.map(({ version }) => version));
  if (versions.length > 1 && distinctVersions.size > 1) {
    const details = versions
      .map(({ path, version }) => `  - ${path}: ${JSON.stringify(version)}`)
      .join("\n");
    problems.push(`${label} defaults must stay in sync:\n${details}`);
  }
}

function resolveNodeModulesDir(args) {
  if (args.nodeModulesDir) return resolve(args.nodeModulesDir);
  return join(resolve(dirname(args.packagePath)), "node_modules");
}

function collectDirectRegistryDependencies(packageJson) {
  const dependencies = [];
  const seenNames = new Set();

  for (const field of ["dependencies", "devDependencies"]) {
    const value = packageJson[field];
    if (!isPlainObject(value)) continue;

    for (const [name, spec] of Object.entries(value)) {
      if (seenNames.has(name) || !isExactRegistryDependencySpec(spec)) continue;
      seenNames.add(name);
      dependencies.push({ field, name });
    }
  }

  return dependencies;
}

function readInstalledPackageVersion(path) {
  try {
    const packageJson = readJsonFile(path);
    return typeof packageJson.version === "string" ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
}

function validateInstalledDependencies(args, packageJson, packageLock, problems) {
  const dependencies = collectDirectRegistryDependencies(packageJson);
  if (dependencies.length === 0) return;

  const nodeModulesDir = resolveNodeModulesDir(args);
  const packageEntries = isPlainObject(packageLock.packages) ? packageLock.packages : {};
  const findings = [];
  const expectedDependencies = [];

  for (const { field, name } of dependencies) {
    const directLabel = `${args.packagePath}#${field}.${name}`;
    const lockPath = `node_modules/${name}`;
    const lockLabel = `${args.lockfilePath}#packages[${JSON.stringify(lockPath)}].version`;
    const lockEntry = packageEntries[lockPath];
    const expectedVersion = lockEntry?.version;

    if (typeof expectedVersion !== "string" || !isPinnedExactVersion(expectedVersion)) {
      findings.push(
        `  - ${directLabel}: ${lockLabel} is missing a usable resolved version; run npm ci`,
      );
      continue;
    }

    expectedDependencies.push({ directLabel, name, expectedVersion });
  }

  if (!existsSync(nodeModulesDir)) {
    problems.push(
      `node_modules not found at ${nodeModulesDir} — run npm ci to install dependencies before validating`,
    );
  } else {
    for (const { directLabel, name, expectedVersion } of expectedDependencies) {
      const installedPath = join(nodeModulesDir, name, "package.json");
      const installedVersion = readInstalledPackageVersion(installedPath);
      if (typeof installedVersion !== "string" || installedVersion.trim().length === 0) {
        findings.push(
          `  - ${directLabel}: expected ${JSON.stringify(expectedVersion)}, but package is not installed (${installedPath})`,
        );
        continue;
      }

      if (installedVersion.trim() !== expectedVersion.trim()) {
        findings.push(
          `  - ${directLabel}: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(installedVersion)}`,
        );
      }
    }
  }

  if (findings.length > 0) {
    problems.push(
      `Installed dependencies are stale or mismatched — run npm ci:\n${findings.join("\n")}`,
    );
  }
}

function validatePiTypeboxPin(args, packageJson, packageLock, problems) {
  const depsSpec = packageJson.dependencies?.typebox;
  if (depsSpec !== undefined) {
    problems.push(
      `${args.packagePath}#dependencies.typebox must not exist — typebox is host-provided by Pi; declare it as a devDependency (exact pin) and peerDependency ('*') instead`,
    );
  }
  const devSpec = packageJson.devDependencies?.typebox;
  const devLabel = `${args.packagePath}#devDependencies.typebox`;
  const piSpec = packageLock.packages?.[PI_CODING_AGENT_LOCK_PATH]?.dependencies?.typebox;
  const piLabel = `${args.lockfilePath}#packages[${JSON.stringify(PI_CODING_AGENT_LOCK_PATH)}].dependencies.typebox`;

  if (typeof devSpec !== "string" || devSpec.trim().length === 0) {
    problems.push(`Missing string dependency spec at ${devLabel}`);
  }
  if (typeof piSpec !== "string" || piSpec.trim().length === 0) {
    problems.push(`Missing pinned Pi typebox dependency spec at ${piLabel}`);
    return;
  }
  if (!isPinnedExactVersion(piSpec)) {
    problems.push(`${piLabel} must use an exact version, found ${JSON.stringify(piSpec)}`);
    return;
  }
  if (
    typeof devSpec === "string" &&
    isPinnedExactVersion(devSpec) &&
    devSpec.trim() !== piSpec.trim()
  ) {
    problems.push(
      `TLH's devDependencies typebox pin must match Pi's pinned typebox version:\n  - ${devLabel}: ${JSON.stringify(devSpec.trim())}\n  - ${piLabel}: ${JSON.stringify(piSpec.trim())}`,
    );
  }

  const peerSpec = packageJson.peerDependencies?.typebox;
  const peerLabel = `${args.packagePath}#peerDependencies.typebox`;
  if (peerSpec !== "*") {
    problems.push(
      `${peerLabel} must be '*' (host-provided by Pi) — found ${
        peerSpec === undefined ? "missing" : JSON.stringify(peerSpec)
      }`,
    );
  }
}

function validateManagedPiPins(args, packageJson, problems) {
  const versions = [];

  for (const { field, name } of MANAGED_PI_DEPENDENCIES) {
    const spec = packageJson[field]?.[name];
    const label = `${args.packagePath}#${field}.${name}`;
    if (typeof spec !== "string" || spec.trim().length === 0) {
      problems.push(`Missing string dependency spec at ${label}`);
      continue;
    }
    if (!isPinnedExactVersion(spec)) {
      problems.push(`${label} must use an exact version, found ${JSON.stringify(spec)}`);
      continue;
    }
    versions.push({ label, version: spec.trim() });
  }

  try {
    const installShVersion = readShellStringVariable(args.installShPath, "TLH_PINNED_PI_VERSION");
    if (!isPinnedExactVersion(installShVersion)) {
      problems.push(
        `${args.installShPath}#TLH_PINNED_PI_VERSION must use an exact version, found ${JSON.stringify(installShVersion)}`,
      );
    } else {
      versions.push({
        label: `${args.installShPath}#TLH_PINNED_PI_VERSION`,
        version: installShVersion,
      });
    }
  } catch (error) {
    problems.push(error.message);
  }

  for (const path of [...args.piInstallScriptPaths, args.modelSelectionScopePath]) {
    try {
      const version = readDeclaredStringConstant(path, "PINNED_PI_VERSION");
      if (!isPinnedExactVersion(version)) {
        problems.push(
          `${path}#PINNED_PI_VERSION must use an exact version, found ${JSON.stringify(version)}`,
        );
        continue;
      }
      versions.push({ label: `${path}#PINNED_PI_VERSION`, version });
    } catch (error) {
      problems.push(error.message);
    }
  }

  const distinctVersions = new Set(versions.map(({ version }) => version));
  if (versions.length > 1 && distinctVersions.size > 1) {
    const details = versions
      .map(({ label, version }) => `  - ${label}: ${JSON.stringify(version)}`)
      .join("\n");
    problems.push(`Managed Pi pins must stay in sync:\n${details}`);
  }
}

/**
 * Read the canonical managed Pi version from install.sh (TLH_PINNED_PI_VERSION).
 * Returns undefined if the version cannot be read or is not pinned.
 */
function readManagedPiVersion(args) {
  try {
    const version = readShellStringVariable(args.installShPath, "TLH_PINNED_PI_VERSION");
    return isPinnedExactVersion(version) ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_RUNTIME_TOP_LEVEL_KEY = `node_modules/${PI_CODING_AGENT_PACKAGE}`;

/**
 * End-anchored pattern that matches a lock-file key only when the key's final
 * path segment is a direct @earendil-works/* package.  This correctly excludes:
 * - paths *inside* an earendil package  (e.g. node_modules/@earendil-works/chord/extra)
 * - non-earendil packages nested *inside* an earendil package
 *   (e.g. node_modules/@earendil-works/pi-ai/node_modules/@anthropic-ai/sdk)
 * Capture group 1 is the sibling name (e.g. "chord", "pi-mcp").
 */
const EARENDIL_SIBLING_KEY_RE = /(?:^|\/)node_modules\/@earendil-works\/([^/]+)$/;

/**
 * Verify every @earendil-works/* sibling entry in a lock file has a version
 * equal to the managed Pi pin.  pi-coding-agent itself (the one pinned
 * top-level package) is excluded; all others (chord, pi-agent-core, pi-ai,
 * pi-codemode, pi-mcp, pi-telemetry, pi-tui, …) must match exactly.
 *
 * Uses EARENDIL_SIBLING_KEY_RE (end-anchored) so that:
 * - paths inside an earendil package (e.g. chord/extra) are excluded, and
 * - non-earendil packages nested inside earendil (e.g. pi-ai/…/@anthropic-ai/sdk)
 *   are excluded.
 * Hoisted and doubly-nested earendil siblings are still caught.
 */
function validateEarendilSiblingVersions(lockPath, lock, managedPiVersion, problems) {
  if (!managedPiVersion) return;

  const packages = isPlainObject(lock.packages) ? lock.packages : {};

  for (const [key, entry] of Object.entries(packages)) {
    // End-anchored match: only count keys whose final segment is @earendil-works/<name>.
    const match = EARENDIL_SIBLING_KEY_RE.exec(key);
    if (!match) continue;

    const siblingName = match[1];
    if (siblingName === "pi-coding-agent") continue;

    const version = entry?.version;
    if (version !== managedPiVersion) {
      problems.push(
        `${lockPath}: ${JSON.stringify(key)} is an @earendil-works/* sibling at version ${JSON.stringify(
          version,
        )} but managed Pi pin is ${JSON.stringify(managedPiVersion)}; add npm overrides to constrain all @earendil-works/* siblings to the pinned version`,
      );
    }
  }
}

/**
 * Validate the npm `overrides` field of a manifest for @earendil-works/* drift.
 *
 * The required sibling set is derived from the corresponding lock file: any
 * @earendil-works/* package (other than pi-coding-agent) found in the lock MUST
 * be covered by an override equal to the managed Pi pin.  This makes the check
 * required (not vacuous) — removing the overrides object while siblings remain
 * in the lock is caught immediately.
 *
 * Extra earendil override keys that are not in the lock are still version-checked
 * so that hand-maintained entries cannot drift either.
 */
function validateEarendilOverrides(manifestPath, overrides, lock, managedPiVersion, problems) {
  if (!managedPiVersion) return;

  // Derive the sibling set expected from the lock.
  const lockPackages = isPlainObject(lock?.packages) ? lock.packages : {};
  const lockSiblings = new Set();
  for (const key of Object.keys(lockPackages)) {
    const match = EARENDIL_SIBLING_KEY_RE.exec(key);
    if (!match || match[1] === "pi-coding-agent") continue;
    lockSiblings.add(match[1]);
  }

  const resolvedOverrides = isPlainObject(overrides) ? overrides : {};
  const earendilKeys = Object.keys(resolvedOverrides).filter((k) =>
    k.startsWith("@earendil-works/"),
  );

  // If the lock has no earendil siblings AND there are no earendil override keys,
  // there is nothing to validate.
  if (lockSiblings.size === 0 && earendilKeys.length === 0) return;

  // Every sibling present in the lock must be covered by an override at the managed pin.
  for (const sibling of lockSiblings) {
    const key = `@earendil-works/${sibling}`;
    if (!(key in resolvedOverrides)) {
      problems.push(
        `${manifestPath}#overrides is missing "${key}"; add an override set to ${JSON.stringify(managedPiVersion)} to constrain all @earendil-works/* siblings to the pinned Pi version`,
      );
    } else if (resolvedOverrides[key] !== managedPiVersion) {
      problems.push(
        `${manifestPath}#overrides["${key}"] is ${JSON.stringify(resolvedOverrides[key])} but managed Pi pin is ${JSON.stringify(managedPiVersion)}; update all @earendil-works/* overrides to match the pinned Pi version`,
      );
    }
  }

  // Also validate earendil override keys not derived from the lock (e.g. hand-maintained
  // entries for siblings that happen to be deduped away).  Version must still match pin.
  for (const key of earendilKeys) {
    const sibling = key.slice("@earendil-works/".length);
    if (lockSiblings.has(sibling)) continue; // already checked in the loop above
    if (resolvedOverrides[key] !== managedPiVersion) {
      problems.push(
        `${manifestPath}#overrides["${key}"] is ${JSON.stringify(resolvedOverrides[key])} but managed Pi pin is ${JSON.stringify(managedPiVersion)}; update all @earendil-works/* overrides to match the pinned Pi version`,
      );
    }
  }
}

/**
 * Validate config/pi-runtime/{package.json,package-lock.json}:
 * - manifest dependency matches the managed Pi pin
 * - lockfileVersion is 3
 * - exactly one top-level node_modules entry (pi-coding-agent)
 * - every non-root entry has resolved
 * - the top-level entry and all packages not covered by a hasShrinkwrap parent have integrity
 * - every @earendil-works/* sibling resolves to the managed Pi pin
 */
function validateRuntimeManifest(args, managedPiVersion, problems) {
  if (!args.runtimeManifestDir) return;

  const manifestPath = join(args.runtimeManifestDir, "package.json");
  const lockPath = join(args.runtimeManifestDir, "package-lock.json");

  let manifest;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (error) {
    problems.push(error.message);
    return;
  }

  const piDep = manifest.dependencies?.[PI_CODING_AGENT_PACKAGE];
  if (managedPiVersion === undefined) {
    // If we can't read the managed pin, only check the manifest is structurally valid
    if (typeof piDep !== "string" || !isPinnedExactVersion(piDep)) {
      problems.push(
        `${manifestPath}#dependencies["${PI_CODING_AGENT_PACKAGE}"] must be an exact version pin, found ${JSON.stringify(piDep)}`,
      );
    }
  } else if (piDep !== managedPiVersion) {
    problems.push(
      `${manifestPath}#dependencies["${PI_CODING_AGENT_PACKAGE}"] must be ${JSON.stringify(managedPiVersion)} (matching managed Pi pin), found ${JSON.stringify(piDep)}`,
    );
  }

  let lock;
  try {
    lock = readJsonFile(lockPath);
  } catch (error) {
    problems.push(error.message);
    return;
  }

  if (lock.lockfileVersion !== 3) {
    problems.push(
      `${lockPath}#lockfileVersion must be 3, found ${JSON.stringify(lock.lockfileVersion)}`,
    );
  }

  const packages = isPlainObject(lock.packages) ? lock.packages : {};
  const nonRootKeys = Object.keys(packages).filter((k) => k !== "");

  // Check exactly one top-level package
  const topLevelKeys = nonRootKeys.filter((k) => {
    if (!k.startsWith("node_modules/")) return false;
    const rest = k.slice("node_modules/".length);
    return !rest.includes("/node_modules/");
  });

  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== PI_RUNTIME_TOP_LEVEL_KEY) {
    const found = topLevelKeys.length === 0 ? "none" : topLevelKeys.join(", ");
    problems.push(
      `${lockPath} must have exactly one top-level package (${PI_RUNTIME_TOP_LEVEL_KEY}), found: ${found}`,
    );
  }

  // Every non-root entry must have resolved
  const missingResolved = nonRootKeys.filter((k) => !packages[k].resolved);
  if (missingResolved.length > 0) {
    const sample = missingResolved.slice(0, 3).join(", ");
    problems.push(
      `${lockPath}: ${missingResolved.length} package(s) missing resolved (e.g. ${sample})`,
    );
  }

  // Every non-root entry must have integrity
  const missingIntegrity = nonRootKeys.filter((k) => !packages[k].integrity);

  if (missingIntegrity.length > 0) {
    const sample = missingIntegrity.slice(0, 3).join(", ");
    problems.push(
      `${lockPath}: ${missingIntegrity.length} package(s) missing integrity (e.g. ${sample})`,
    );
  }

  validateEarendilSiblingVersions(lockPath, lock, managedPiVersion, problems);
  validateEarendilOverrides(manifestPath, manifest.overrides, lock, managedPiVersion, problems);
}

function collectProblems(args) {
  const packageJson = readJsonFile(args.packagePath);
  const packageLock = readJsonFile(args.lockfilePath);
  const problems = [];
  const entries = versionEntries(args, packageJson, packageLock);
  let version = entries[0]?.value;

  try {
    version = assertMatchingVersions(entries);
  } catch (error) {
    problems.push(error.message);
  }

  validateInstalledDependencies(args, packageJson, packageLock, problems);
  validatePinnedDependencies(packageJson, args.packagePath, problems);
  validateManagedPiPins(args, packageJson, problems);
  validatePiTypeboxPin(args, packageJson, packageLock, problems);
  validateDefaultExtensionPins(args.defaultExtensionsPath, problems);
  validatePinnedManagedScriptDefaults(
    args.gnosisScriptPaths,
    "DEFAULT_GNOSIS_VERSION",
    "Managed Gnosis",
    problems,
  );

  const managedPiVersion = readManagedPiVersion(args);
  validateEarendilSiblingVersions(args.lockfilePath, packageLock, managedPiVersion, problems);
  validateEarendilOverrides(
    args.packagePath,
    packageJson.overrides,
    packageLock,
    managedPiVersion,
    problems,
  );
  validateRuntimeManifest(args, managedPiVersion, problems);

  return { version, problems };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const { version, problems } = collectProblems(args);
  if (problems.length > 0) {
    throw new Error(problems.join("\n\n"));
  }

  process.stdout.write(
    `check-package-versions: all tracked version fields match (${version}), and managed dependency pins are valid.\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check-package-versions: ${message}\n`);
  process.exitCode = 1;
}
