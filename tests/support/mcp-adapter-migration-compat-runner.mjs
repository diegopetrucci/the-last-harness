import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const childPath = fileURLToPath(
  new URL("./mcp-adapter-migration-compat-child.mjs", import.meta.url),
);
const fixtureEnv = process.env.TLH_MCP_COMPAT_FIXTURES_DIR?.trim();
const artifactSpecs = [
  {
    version: "2.36.0",
    size: 1_631_495,
    integrity:
      "sha512-EaEDdtS9/hVb8Qo4Z9Je26XJsVCJZO64KHC0rQ6ZQydtyGAiU7Tm6jWsM0L4enisCvd1bO0FotuAXPmjZgDXzA==",
  },
  {
    version: "5.0.0",
    size: 1_954_135,
    integrity:
      "sha512-iaclivBniWgCHE5sYeEs95RYsXxHfyunkyoLUGV03LPb2B6rfALXE/XtQTwJQIk9nToiqhEe7YVpGI+mdCVVYQ==",
  },
];
const parserArtifactSpecs = [
  {
    name: "smol-toml",
    version: "1.6.1",
    integrity:
      "sha512-dWUG8F5sIIARXih1DTaQAX4SsiTXhInKf1buxdY9DIg4ZYPZK5nGM1VRIYmEbDbsHt7USo99xSLFu5Q1IqTmsg==",
    requiredMembers: [
      "package/dist/index.cjs",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/package.json",
    ],
  },
  {
    name: "smol-toml",
    version: "1.9.0",
    integrity:
      "sha512-hpd+HLON7HdZXqYchMM/+LaTTbdK0AU3NngIJ4KVyWbY9bfQqdL9cD+4yf6dUoU2Ap4VsU0JkQi6FxAI1B2mXQ==",
    requiredMembers: [
      "package/dist/index.cjs",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/package.json",
    ],
  },
  {
    name: "strip-json-comments",
    version: "5.0.3",
    integrity:
      "sha512-1tB5mhVo7U+ETBKNf92xT4hrQa3pm0MZ0PQvuDnWgAAGHDsfp4lPSpiS6psrSiet87wyGPh9ft6wmhOMQ0hDiw==",
    requiredMembers: ["package/index.d.ts", "package/index.js", "package/package.json"],
  },
];
const zodArtifactSpec = {
  name: "zod",
  version: "3.25.76",
  range: "^3.25.0 || ^4.0.0",
  integrity:
    "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
  requiredMembers: [
    "package/index.cjs",
    "package/index.d.cts",
    "package/index.js",
    "package/package.json",
  ],
};
const loaderParserSelections = {
  "2.36.0": [
    { name: "smol-toml", version: "1.6.1", range: "^1.6.1" },
    { name: "strip-json-comments", version: "5.0.3", range: "^5.0.3" },
  ],
  "5.0.0": [
    { name: "smol-toml", version: "1.9.0", range: "^1.9.0" },
    { name: "strip-json-comments", version: "5.0.3", range: "^5.0.3" },
  ],
};
let materialized;

function artifactPath(root, version) {
  return join(root, `diegopetrucci-pi-mcp-adapter-${version}.tgz`);
}

function parserArtifactPath(root, spec) {
  return join(root, `${spec.name}-${spec.version}.tgz`);
}

function safeRegistryEnv(root) {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    USER: "tlh-loader-fixture",
    LOGNAME: "tlh-loader-fixture",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_globalconfig: join(root, "npm-globalrc"),
    npm_config_cache: join(root, "npm-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function materializeFromRegistry(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "npmrc"), "", { mode: 0o600 });
  writeFileSync(join(root, "npm-globalrc"), "", { mode: 0o600 });
  writeFileSync(join(root, "gitconfig"), "", { mode: 0o600 });
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "npm-cache"), { recursive: true });
  for (const spec of artifactSpecs) {
    const expected = artifactPath(root, spec.version);
    const result = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        root,
        `@diegopetrucci/pi-mcp-adapter@${spec.version}`,
      ],
      {
        cwd: repoRoot,
        env: safeRegistryEnv(root),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(expected), true, `npm pack did not create ${expected}`);
  }
  for (const spec of parserArtifactSpecs) {
    const expected = parserArtifactPath(root, spec);
    const result = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        root,
        `${spec.name}@${spec.version}`,
      ],
      {
        cwd: repoRoot,
        env: safeRegistryEnv(root),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(expected), true, `npm pack did not create ${expected}`);
  }
  const zodPath = parserArtifactPath(root, zodArtifactSpec);
  assert.equal(existsSync(zodPath), false, `refusing to overwrite zod fixture: ${zodPath}`);
  const zodResult = spawnSync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
      `${zodArtifactSpec.name}@${zodArtifactSpec.version}`,
    ],
    {
      cwd: repoRoot,
      env: safeRegistryEnv(root),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(zodResult.status, 0, `${zodResult.stdout}\n${zodResult.stderr}`);
  assert.equal(existsSync(zodPath), true, `npm pack did not create ${zodPath}`);
}

function readTarPackageJson(path, root) {
  const result = spawnSync("tar", ["-xOzf", path, "package/package.json"], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function verifyArtifact(root, spec) {
  const path = artifactPath(root, spec.version);
  assert.equal(existsSync(path), true, `missing released loader fixture: ${path}`);
  const data = readFileSync(path);
  assert.equal(data.byteLength, spec.size, `${spec.version} tarball size changed`);
  const actual = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  assert.equal(actual, spec.integrity, `${spec.version} tarball integrity changed`);
  return path;
}

function selectParserArtifacts(path, loaderSpec, root, parserArtifacts) {
  const packageData = readTarPackageJson(path, root);
  assert.equal(packageData.name, "@diegopetrucci/pi-mcp-adapter");
  assert.equal(packageData.version, loaderSpec.version);
  assert.equal(packageData.dependencies?.[zodArtifactSpec.name], zodArtifactSpec.range);
  const selections = loaderParserSelections[loaderSpec.version];
  assert.ok(selections, `no parser selection for ${loaderSpec.version}`);
  assert.equal(selections.length, 2);
  assert.equal(new Set(selections.map((selection) => selection.name)).size, 2);
  assert.equal(new Set(selections.map((selection) => selection.version)).size, 2);
  const expectedParserKeys =
    loaderSpec.version === "2.36.0"
      ? ["smol-toml@1.6.1", "strip-json-comments@5.0.3"]
      : ["smol-toml@1.9.0", "strip-json-comments@5.0.3"];
  assert.deepEqual(
    selections.map((selection) => `${selection.name}@${selection.version}`).sort(),
    expectedParserKeys.sort(),
  );
  const parserByKey = new Map(
    parserArtifacts.map((artifact) => [`${artifact.spec.name}@${artifact.spec.version}`, artifact]),
  );
  return selections.map((selection) => {
    assert.equal(packageData.dependencies?.[selection.name], selection.range);
    const key = `${selection.name}@${selection.version}`;
    const artifact = parserByKey.get(key);
    assert.ok(artifact, `missing selected parser artifact: ${key}`);
    assert.equal(artifact.spec.name, selection.name);
    assert.equal(artifact.spec.version, selection.version);
    return artifact;
  });
}

function verifyParserArtifact(root, spec) {
  const path = parserArtifactPath(root, spec);
  assert.equal(existsSync(path), true, `missing parser fixture: ${path}`);
  const data = readFileSync(path);
  const actual = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  assert.equal(actual, spec.integrity, `${spec.name}@${spec.version} integrity changed`);
  const listing = spawnSync("tar", ["-tzf", path], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(listing.status, 0, `${listing.stdout}\n${listing.stderr}`);
  const members = new Set(listing.stdout.split(/\r?\n/u).filter(Boolean));
  for (const member of spec.requiredMembers) {
    assert.equal(members.has(member), true, `${spec.name}@${spec.version} is missing ${member}`);
  }
  const packageJson = spawnSync("tar", ["-xOzf", path, "package/package.json"], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(packageJson.status, 0, `${packageJson.stdout}\n${packageJson.stderr}`);
  const packageData = JSON.parse(packageJson.stdout);
  assert.equal(packageData.name, spec.name);
  assert.equal(packageData.version, spec.version);
  assert.deepEqual(packageData.dependencies ?? {}, {});
  return path;
}

function collectExportTargets(value, targets) {
  if (typeof value === "string") {
    targets.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectExportTargets(entry, targets);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function verifyZodArtifact(root) {
  const path = parserArtifactPath(root, zodArtifactSpec);
  assert.equal(existsSync(path), true, `missing zod fixture: ${path}`);
  const data = readFileSync(path);
  const actual = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  assert.equal(actual, zodArtifactSpec.integrity, "zod@3.25.76 integrity changed");
  const listing = spawnSync("tar", ["-tzf", path], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(listing.status, 0, `${listing.stdout}\n${listing.stderr}`);
  const members = new Set(listing.stdout.split(/\r?\n/u).filter(Boolean));
  for (const member of zodArtifactSpec.requiredMembers) {
    assert.equal(members.has(member), true, `zod@3.25.76 is missing ${member}`);
  }
  const packageData = readTarPackageJson(path, root);
  assert.equal(packageData.name, zodArtifactSpec.name);
  assert.equal(packageData.version, zodArtifactSpec.version);
  assert.deepEqual(packageData.dependencies ?? {}, {});
  assert.deepEqual(packageData.optionalDependencies ?? {}, {});
  assert.deepEqual(packageData.peerDependencies ?? {}, {});
  const exportTargets = new Set();
  collectExportTargets(packageData.exports, exportTargets);
  assert.ok(exportTargets.size > 0, "zod@3.25.76 has no exports to verify");
  for (const target of exportTargets) {
    assert.equal(target.startsWith("./"), true, `unsupported zod export target: ${target}`);
    const member = `package/${target.slice(2)}`;
    if (target.includes("*")) {
      const pattern = new RegExp(`^${member.split("*").map(escapeRegExp).join(".*")}$`, "u");
      assert.ok(
        [...members].some((candidate) => pattern.test(candidate)),
        `zod export wildcard has no tar member: ${target}`,
      );
    } else {
      assert.equal(members.has(member), true, `zod export target is missing: ${target}`);
    }
  }
  return { path, integrity: actual, spec: zodArtifactSpec };
}

function extractParserArtifact(path, spec, nodeModulesRoot, root) {
  const scratch = join(nodeModulesRoot, `.extract-${spec.name}-${spec.version}`);
  const destination = join(nodeModulesRoot, spec.name);
  mkdirSync(scratch, { recursive: true });
  const extraction = spawnSync("tar", ["-xzf", path, "-C", scratch], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);
  assert.equal(existsSync(join(scratch, "package")), true);
  assert.equal(existsSync(destination), false, `duplicate parser overlay: ${destination}`);
  renameSync(join(scratch, "package"), destination);
  rmSync(scratch, { recursive: true, force: true });
}

function extractArtifact(path, spec, root, fixtureDependencies) {
  const destination = join(root, spec.version);
  mkdirSync(destination, { recursive: true });
  const listing = spawnSync("tar", ["-tzf", path], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(listing.status, 0, `${listing.stdout}\n${listing.stderr}`);
  const members = new Set(listing.stdout.split(/\r?\n/u).filter(Boolean));
  for (const member of ["package/dist/config.js", "package/dist/agent-dir.js"]) {
    assert.equal(members.has(member), true, `${spec.version} is missing ${member}`);
  }
  const extraction = spawnSync("tar", ["-xzf", path, "-C", destination], {
    cwd: repoRoot,
    env: safeRegistryEnv(root),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);
  const packageRoot = join(destination, "package");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, spec.version);
  const nodeModulesRoot = join(packageRoot, "node_modules");
  mkdirSync(nodeModulesRoot, { recursive: true });
  for (const fixtureDependency of fixtureDependencies) {
    extractParserArtifact(fixtureDependency.path, fixtureDependency.spec, nodeModulesRoot, root);
  }
  return {
    packageRoot,
    configPath: join(packageRoot, "dist", "config.js"),
    sourceEvidencePath: join(packageRoot, "index.ts"),
    integrity: spec.integrity,
    size: spec.size,
  };
}

export function ensurePublishedLoaders() {
  if (materialized) return materialized;
  const root = realpathTemp("tlh-mcp-loader-fixtures-");
  if (fixtureEnv) {
    for (const spec of artifactSpecs) verifyArtifact(fixtureEnv, spec);
    for (const spec of parserArtifactSpecs) verifyParserArtifact(fixtureEnv, spec);
  } else {
    materializeFromRegistry(root);
  }
  const fixtureRoot = fixtureEnv || root;
  const parserArtifacts = parserArtifactSpecs.map((spec) => ({
    spec,
    path: verifyParserArtifact(fixtureRoot, spec),
  }));
  const zodArtifact = verifyZodArtifact(fixtureRoot);
  const extractedRoot = join(root, "extracted");
  mkdirSync(extractedRoot, { recursive: true });
  const loaders = {};
  for (const spec of artifactSpecs) {
    const path = verifyArtifact(fixtureRoot, spec);
    const selectedParserArtifacts = selectParserArtifacts(path, spec, fixtureRoot, parserArtifacts);
    const fixtureDependencies = [...selectedParserArtifacts, zodArtifact];
    loaders[spec.version] = extractArtifact(path, spec, extractedRoot, fixtureDependencies);
  }
  materialized = { root, loaders, artifacts: artifactSpecs, parserArtifacts, zodArtifact };
  return materialized;
}

function realpathTemp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return resolve(path);
}

export function cleanupPublishedLoaders() {
  if (!materialized) return;
  rmSync(materialized.root, { recursive: true, force: true });
  materialized = undefined;
}

function childEnvironment(fixtureRoot) {
  const root = resolve(fixtureRoot);
  const home = join(root, "home");
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    USER: "tlh-loader-child",
    LOGNAME: "tlh-loader-child",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    TLH_AGENT_DIR: join(root, "agent"),
    MCP_OAUTH_DIR: join(root, "oauth"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    TMPDIR: join(root, "tmp"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_globalconfig: join(root, "npm-globalrc"),
    npm_config_cache: join(root, "npm-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_OPTIONAL_LOCKS: "0",
    TLH_MCP_COMPAT_FIXTURES_DIR: fixtureEnv || "",
  };
  return env;
}

export function runLoaderChild({ loaderPath, fixtureRoot, cwd, nativeEnabled }) {
  const result = spawnSync(
    process.execPath,
    [childPath, loaderPath, fixtureRoot, cwd, nativeEnabled ? "true" : "false"],
    {
      cwd: repoRoot,
      env: childEnvironment(fixtureRoot),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `released loader child failed (${loaderPath}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout.trim());
}

export function normalizeFixturePaths(value, fixtureRoot) {
  if (typeof value === "string") return value.replaceAll(resolve(fixtureRoot), "<fixture>");
  if (Array.isArray(value)) return value.map((entry) => normalizeFixturePaths(entry, fixtureRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeFixturePaths(entry, fixtureRoot)]),
    );
  }
  return value;
}
