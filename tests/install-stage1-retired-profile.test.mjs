import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { cleanupLegacyManagedProfileArtifacts } from "../scripts/tlh-install.mjs";
import { captureConsole, makeTempDir } from "./install-stage1-test-helpers.mjs";

function metadataReaderWithFailures(failures) {
  return (path) => {
    const failure = failures.get(path);
    if (failure) {
      const error = new Error(failure.message);
      error.code = failure.code;
      throw error;
    }
    return lstatSync(path);
  };
}

test("cleanupLegacyManagedProfileArtifacts removes regular legacy managed RTK files", (t) => {
  const root = makeTempDir("tlh-cleanup-legacy-rtk-present-");
  const agentDir = join(root, "agent");
  const legacyManagedRtk = join(agentDir, "bin", "rtk");
  const legacyManagedHelper = join(agentDir, "tlh", "tlh-rtk.mjs");
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  writeFileSync(legacyManagedRtk, "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(legacyManagedHelper, "legacy helper\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  cleanupLegacyManagedProfileArtifacts({ agentDir, dryRun: false, quiet: true, verbose: false });

  assert.equal(existsSync(legacyManagedRtk), false);
  assert.equal(existsSync(legacyManagedHelper), false);
});

test("cleanupLegacyManagedProfileArtifacts preserves symlinked and parent-symlink RTK paths", (t) => {
  if (process.platform === "win32") return;
  const root = makeTempDir("tlh-cleanup-legacy-rtk-symlink-");
  const agentDir = join(root, "agent");
  const externalDir = join(root, "external-bin");
  const externalRtk = join(externalDir, "rtk");
  mkdirSync(externalDir, { recursive: true });
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  writeFileSync(externalRtk, "#!/bin/sh\nexit 0\n", "utf8");
  symlinkSync(externalDir, join(agentDir, "bin"), "dir");
  symlinkSync(externalRtk, join(agentDir, "tlh", "tlh-rtk.mjs"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  cleanupLegacyManagedProfileArtifacts({ agentDir, dryRun: false, quiet: true, verbose: false });

  assert.equal(existsSync(externalRtk), true);
  assert.equal(existsSync(join(agentDir, "bin", "rtk")), true);
  assert.equal(existsSync(join(agentDir, "tlh", "tlh-rtk.mjs")), true);
});

test("cleanupLegacyManagedProfileArtifacts skips missing metadata and processes later files", (t) => {
  const root = makeTempDir("tlh-cleanup-legacy-rtk-missing-metadata-");
  const agentDir = join(root, "agent");
  const missingFile = join(agentDir, "bin", "rtk");
  const laterFile = join(agentDir, "tlh", "tlh-rtk.mjs");
  mkdirSync(dirname(missingFile), { recursive: true });
  mkdirSync(dirname(laterFile), { recursive: true });
  writeFileSync(missingFile, "legacy rtk\n", "utf8");
  writeFileSync(laterFile, "legacy helper\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const metadataReader = metadataReaderWithFailures(
    new Map([[missingFile, { code: "ENOENT", message: "simulated missing entry" }]]),
  );
  assert.doesNotThrow(() =>
    cleanupLegacyManagedProfileArtifacts({
      agentDir,
      dryRun: false,
      quiet: true,
      verbose: false,
      cleanupMetadata: metadataReader,
    }),
  );

  assert.equal(existsSync(missingFile), true, "missing metadata entry must be preserved");
  assert.equal(existsSync(laterFile), false, "later eligible file must still be removed");
});

test("cleanupLegacyManagedProfileArtifacts warns on metadata errors and processes later files", (t) => {
  const root = makeTempDir("tlh-cleanup-legacy-rtk-metadata-error-");
  const agentDir = join(root, "agent");
  const unreadableFile = join(agentDir, "bin", "rtk");
  const laterFile = join(agentDir, "tlh", "tlh-rtk.mjs");
  mkdirSync(dirname(unreadableFile), { recursive: true });
  mkdirSync(dirname(laterFile), { recursive: true });
  writeFileSync(unreadableFile, "legacy rtk\n", "utf8");
  writeFileSync(laterFile, "legacy helper\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const metadataReader = metadataReaderWithFailures(
    new Map([[unreadableFile, { code: "EIO", message: "simulated metadata failure" }]]),
  );
  const stderr = captureConsole("error", () => {
    assert.doesNotThrow(() =>
      cleanupLegacyManagedProfileArtifacts({
        agentDir,
        dryRun: false,
        quiet: true,
        verbose: false,
        cleanupMetadata: metadataReader,
      }),
    );
  });

  assert.equal(existsSync(unreadableFile), true, "unreadable metadata entry must be preserved");
  assert.equal(existsSync(laterFile), false, "later eligible file must still be removed");
  assert.match(stderr, /simulated metadata failure/);
});

test("cleanupLegacyManagedProfileArtifacts preserves non-files and unrelated profile content", (t) => {
  const root = makeTempDir("tlh-cleanup-legacy-rtk-nonfiles-");
  const agentDir = join(root, "agent");
  const legacyManagedRtkDirectory = join(agentDir, "bin", "rtk");
  const unrelatedBinary = join(agentDir, "bin", "keep");
  const unrelatedSupportFile = join(agentDir, "tlh", "keep.mjs");
  mkdirSync(legacyManagedRtkDirectory, { recursive: true });
  mkdirSync(join(agentDir, "tlh", "tlh-rtk.mjs"), { recursive: true });
  writeFileSync(unrelatedBinary, "keep\n", "utf8");
  writeFileSync(unrelatedSupportFile, "keep\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  cleanupLegacyManagedProfileArtifacts({ agentDir, dryRun: false, quiet: true, verbose: false });

  assert.equal(existsSync(legacyManagedRtkDirectory), true);
  assert.equal(existsSync(join(agentDir, "tlh", "tlh-rtk.mjs")), true);
  assert.equal(existsSync(unrelatedBinary), true);
  assert.equal(existsSync(unrelatedSupportFile), true);
});

test("cleanupLegacyManagedProfileArtifacts dry-run logs removal without deleting files", (t) => {
  const root = makeTempDir("tlh-cleanup-legacy-rtk-dryrun-");
  const agentDir = join(root, "agent");
  const legacyManagedRtk = join(agentDir, "bin", "rtk");
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  writeFileSync(legacyManagedRtk, "#!/bin/sh\nexit 0\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stdout = captureConsole("log", () =>
    cleanupLegacyManagedProfileArtifacts({ agentDir, dryRun: true, quiet: false, verbose: false }),
  );

  assert.equal(existsSync(legacyManagedRtk), true);
  assert.match(stdout, /Would remove retired profile file.*bin[\\/]rtk/);
});
