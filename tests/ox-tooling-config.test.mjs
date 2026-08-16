import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const configPath = resolve(repoRoot, ".oxfmtrc.json");
const packagePath = resolve(repoRoot, "package.json");
const lockfilePath = resolve(repoRoot, "package-lock.json");
const gitattributesPath = resolve(repoRoot, ".gitattributes");
const formattingSurfaceRoots = ["scripts/", "tests/", "extensions/"];
const extensionHtmlIgnores = [
  "extensions/annotate-git-diff/web/index.html",
  "extensions/the-last-harness/annotate-last-message/web/index.html",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readGeneratedRuntimePaths() {
  return readFileSync(gitattributesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("linguist-generated=true"))
    .map((line) => line.split(/\s+/)[0])
    .filter((path) => formattingSurfaceRoots.some((root) => path.startsWith(root)))
    .filter((path) => /\.(?:js|mjs)$/.test(path));
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${source}$`);
}

function matchesIgnorePattern(pattern, path) {
  return globToRegExp(pattern).test(path);
}

test("Oxfmt configuration keeps generated mirrors and existing HTML assets out of formatting", () => {
  assert.equal(
    existsSync(resolve(repoRoot, "biome.json")),
    false,
    "Biome configuration must be removed",
  );

  const config = readJson(configPath);
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "ignorePatterns"]);
  assert.equal(config.$schema, "./node_modules/oxfmt/configuration_schema.json");
  assert.ok(Array.isArray(config.ignorePatterns));
  for (const htmlPath of extensionHtmlIgnores) {
    assert.ok(
      config.ignorePatterns.includes(htmlPath),
      `Oxfmt must ignore existing HTML asset ${htmlPath}`,
    );
  }
  assert.equal(
    config.ignorePatterns.filter((pattern) => extensionHtmlIgnores.includes(pattern)).length,
    extensionHtmlIgnores.length,
    "Oxfmt must retain exactly the two existing HTML safety exclusions",
  );

  const generatedRuntimePaths = readGeneratedRuntimePaths();
  assert.ok(
    generatedRuntimePaths.length > 0,
    "the generated runtime registry must contain formatting-surface outputs",
  );
  for (const generatedPath of generatedRuntimePaths) {
    assert.ok(
      config.ignorePatterns.some((pattern) => matchesIgnorePattern(pattern, generatedPath)),
      `Oxfmt must ignore registered generated runtime output ${generatedPath}`,
    );
  }

  const unmatchedPatterns = config.ignorePatterns.filter(
    (pattern) =>
      !extensionHtmlIgnores.includes(pattern) &&
      !generatedRuntimePaths.some((generatedPath) => matchesIgnorePattern(pattern, generatedPath)),
  );
  assert.deepEqual(
    unmatchedPatterns,
    [],
    "every Oxfmt ignore must protect a registered output or HTML asset",
  );
});

test("package scripts invoke Ox tools with default rule selection over the existing source surface and validation gate", () => {
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockfilePath);
  assert.equal(packageJson.devDependencies["@biomejs/biome"], undefined);
  assert.equal(packageJson.devDependencies.oxlint, "1.78.0");
  assert.equal(packageJson.devDependencies.oxfmt, "0.63.0");
  assert.equal(packageLock.packages[""].devDependencies.oxlint, "1.78.0");
  assert.equal(packageLock.packages[""].devDependencies.oxfmt, "0.63.0");
  assert.equal(packageLock.packages["node_modules/oxlint"].version, "1.78.0");
  assert.equal(packageLock.packages["node_modules/oxfmt"].version, "0.63.0");
  assert.equal(packageLock.packages["node_modules/@biomejs/biome"], undefined);
  assert.equal(packageJson.scripts.lint, "oxlint --deny-warnings scripts tests extensions");
  assert.equal(packageJson.scripts.format, "oxfmt scripts tests extensions");
  assert.equal(packageJson.scripts["format:check"], "oxfmt --check scripts tests extensions");
  assert.match(
    packageJson.scripts.validate,
    /npm run lint && npm run format:check && npm run lint:sh/,
    "validate must run Oxfmt checking between Oxlint and ShellCheck",
  );
});
