import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const historyDir = dirname(fileURLToPath(import.meta.url));
const tlhRoot = resolve(historyDir, "../..");
const sourceRepo = resolve(process.argv[2] ?? process.env.SOURCE_REPO ?? "");

if (!process.argv[2] && !process.env.SOURCE_REPO) {
  console.error("Usage: node docs/subagents-history/verify-import.mjs /path/to/pi-subagents-nether");
  process.exit(2);
}

const manifest = JSON.parse(
  await readFile(resolve(historyDir, "import-manifest.json"), "utf8"),
);
const sourceCommit = manifest.snapshot.sourceCommit;
const importCommit = manifest.snapshot.tlhImportCommit;

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git -C ${repo} ${args.join(" ")} failed:\n${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

function gitText(repo, args) {
  return git(repo, args).toString("utf8").trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseTree(bytes) {
  const entries = new Map();
  for (const record of bytes.toString("utf8").split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const [mode, objectType, oid] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    entries.set(path, { mode, objectType, oid });
  }
  return entries;
}

assert.equal(
  gitText(sourceRepo, ["rev-parse", `${sourceCommit}^{commit}`]),
  sourceCommit,
  "source commit identity differs",
);
assert.equal(
  gitText(sourceRepo, ["rev-parse", `${sourceCommit}^{tree}`]),
  manifest.snapshot.sourceTree,
  "source tree identity differs",
);
assert.equal(
  gitText(tlhRoot, ["rev-parse", `${importCommit}^{commit}`]),
  importCommit,
  "TLH import commit identity differs",
);
assert.equal(
  gitText(tlhRoot, ["merge-base", importCommit, "HEAD"]),
  importCommit,
  "TLH import commit is not an ancestor of HEAD",
);
const importParents = gitText(tlhRoot, ["show", "-s", "--format=%P", importCommit])
  .split(/\s+/)
  .filter(Boolean);
assert.equal(importParents.length, 1, "TLH import commit is not single-parent");

const sourceTree = parseTree(
  git(sourceRepo, ["ls-tree", "-rz", "--full-tree", sourceCommit]),
);
assert.equal(sourceTree.size, manifest.counts.trackedSourceFiles);

const manifestSourcePaths = new Set();
const includedDestinations = new Set();
const historicalArchiveDestinations = new Set();
const importSnapshotTree = parseTree(
  git(tlhRoot, [
    "ls-tree",
    "-rz",
    "--full-tree",
    importCommit,
    "--",
    "docs/subagents-history/source",
    "extensions/subagents",
  ]),
);
const currentArchiveTree = parseTree(
  git(tlhRoot, [
    "ls-tree",
    "-rz",
    "--full-tree",
    "HEAD",
    "--",
    "docs/subagents-history/source",
  ]),
);

for (const entry of manifest.includedFiles) {
  assert(!manifestSourcePaths.has(entry.sourcePath), `duplicate source path: ${entry.sourcePath}`);
  manifestSourcePaths.add(entry.sourcePath);
  assert(!includedDestinations.has(entry.destinationPath), `duplicate destination: ${entry.destinationPath}`);
  includedDestinations.add(entry.destinationPath);

  const expectedDestination = entry.category === "functional-snapshot"
    ? `extensions/subagents/${entry.sourcePath}`
    : `docs/subagents-history/source/${entry.sourcePath}`;
  assert.equal(entry.destinationPath, expectedDestination, `mapping differs: ${entry.sourcePath}`);
  assert.equal(entry.destinationMode, entry.sourceMode, `manifest mode differs: ${entry.sourcePath}`);

  const source = sourceTree.get(entry.sourcePath);
  assert(source, `source path missing: ${entry.sourcePath}`);
  assert.deepEqual(
    source,
    {
      mode: entry.sourceMode,
      objectType: entry.sourceObjectType,
      oid: entry.sourceBlobOid,
    },
    `source Git metadata differs: ${entry.sourcePath}`,
  );

  const sourceBytes = git(sourceRepo, ["cat-file", "blob", entry.sourceBlobOid]);
  assert.equal(sha256(sourceBytes), entry.sha256, `source SHA-256 differs: ${entry.sourcePath}`);

  const destination = importSnapshotTree.get(entry.destinationPath);
  assert(destination, `imported destination missing: ${entry.destinationPath}`);
  assert.deepEqual(
    destination,
    {
      mode: entry.destinationMode,
      objectType: entry.sourceObjectType,
      oid: entry.sourceBlobOid,
    },
    `imported destination Git metadata differs: ${entry.destinationPath}`,
  );
  const importedDestinationBytes = git(tlhRoot, ["cat-file", "blob", destination.oid]);
  assert(
    sourceBytes.equals(importedDestinationBytes),
    `imported destination bytes differ: ${entry.destinationPath}`,
  );
  assert.equal(
    sha256(importedDestinationBytes),
    entry.sha256,
    `imported destination SHA-256 differs: ${entry.destinationPath}`,
  );

  if (entry.category === "historical-source-archive") {
    historicalArchiveDestinations.add(entry.destinationPath);
    const currentArchive = currentArchiveTree.get(entry.destinationPath);
    assert(currentArchive, `current historical archive missing: ${entry.destinationPath}`);
    assert.deepEqual(
      currentArchive,
      destination,
      `current historical archive Git metadata differs: ${entry.destinationPath}`,
    );

    const currentArchiveBytes = await readFile(resolve(tlhRoot, entry.destinationPath));
    assert(
      sourceBytes.equals(currentArchiveBytes),
      `current historical archive bytes differ: ${entry.destinationPath}`,
    );
    const destinationStat = await stat(resolve(tlhRoot, entry.destinationPath));
    assert(destinationStat.isFile(), `historical archive is not a regular file: ${entry.destinationPath}`);
    const expectedExecutable = entry.destinationMode === "100755";
    assert.equal(
      (destinationStat.mode & 0o111) !== 0,
      expectedExecutable,
      `historical archive working-tree executable mode differs: ${entry.destinationPath}`,
    );
  }
}

assert.equal(importSnapshotTree.size, includedDestinations.size, "unexpected imported destination file");
for (const destinationPath of importSnapshotTree.keys()) {
  assert(includedDestinations.has(destinationPath), `unexpected imported destination: ${destinationPath}`);
}
assert.equal(
  currentArchiveTree.size,
  historicalArchiveDestinations.size,
  "unexpected current historical archive file",
);
for (const destinationPath of currentArchiveTree.keys()) {
  assert(
    historicalArchiveDestinations.has(destinationPath),
    `unexpected current historical archive: ${destinationPath}`,
  );
}

for (const entry of manifest.excludedFiles) {
  assert(!manifestSourcePaths.has(entry.sourcePath), `duplicate source path: ${entry.sourcePath}`);
  manifestSourcePaths.add(entry.sourcePath);
  const source = sourceTree.get(entry.sourcePath);
  assert(source, `excluded source path missing: ${entry.sourcePath}`);
  assert.deepEqual(
    source,
    {
      mode: entry.sourceMode,
      objectType: entry.sourceObjectType,
      oid: entry.sourceBlobOid,
    },
    `excluded source Git metadata differs: ${entry.sourcePath}`,
  );
  const sourceBytes = git(sourceRepo, ["cat-file", "blob", entry.sourceBlobOid]);
  assert.equal(sha256(sourceBytes), entry.sha256, `excluded SHA-256 differs: ${entry.sourcePath}`);
}
assert.equal(manifestSourcePaths.size, sourceTree.size, "manifest does not partition the source tree");
for (const sourcePath of sourceTree.keys()) {
  assert(manifestSourcePaths.has(sourcePath), `unclassified source path: ${sourcePath}`);
}

const archiveBytes = git(sourceRepo, ["archive", "--format=tar", sourceCommit]);
assert.equal(
  sha256(archiveBytes),
  manifest.fullSourceArchive.sha256,
  "full source archive SHA-256 differs",
);

for (const ledger of Object.values(manifest.historicalLedgers)) {
  const contents = await readFile(resolve(tlhRoot, ledger.destinationPath), "utf8");
  const entryCount = contents.split("\n").filter((line) => line.length > 0).length;
  assert.equal(entryCount, ledger.entryCount, `ledger entry count differs: ${ledger.destinationPath}`);
}

const sourceAncestors = new Set(gitText(sourceRepo, ["rev-list", sourceCommit]).split("\n"));
const tlhReachable = new Set(gitText(tlhRoot, ["rev-list", "--all"]).split("\n"));
const reachableSourceAncestors = [...sourceAncestors].filter((oid) => tlhReachable.has(oid));
assert.deepEqual(reachableSourceAncestors, [], "source Git ancestors are reachable from TLH refs");

console.log(JSON.stringify({
  sourceCommit,
  sourceTree: manifest.snapshot.sourceTree,
  tlhImportCommit: importCommit,
  importCommitAncestorOfHead: true,
  importedDestinationFilesVerified: manifest.includedFiles.length,
  currentHistoricalArchiveFilesVerified: historicalArchiveDestinations.size,
  excludedFilesVerified: manifest.excludedFiles.length,
  fullSourceArchiveSha256: manifest.fullSourceArchive.sha256,
  gnosisEntriesVerified: manifest.historicalLedgers.gnosis.entryCount,
  reachableSourceAncestors: reachableSourceAncestors.length,
}, null, 2));
