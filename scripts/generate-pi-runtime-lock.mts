#!/usr/bin/env node
/**
 * generate-pi-runtime-lock — regenerate config/pi-runtime/package-lock.json.
 *
 * Reads PINNED_PI_VERSION from scripts/tlh-install.mts, writes
 * config/pi-runtime/package.json with the exact pin, then runs
 * npm install --package-lock-only inside config/pi-runtime/ to produce
 * a lockfileVersion 3 lock with the full nested dependency graph.
 *
 * npm --package-lock-only reuses resolutions from an existing lock, which is
 * what keeps regeneration byte-stable for an unchanged pin. To force a fresh
 * resolution (e.g. a security-only dependency refresh), delete
 * config/pi-runtime/package-lock.json before running this script.
 *
 * Usage:
 *   node scripts/generate-pi-runtime-lock.mjs
 *   npm run generate:pi-runtime-lock
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const RUNTIME_MANIFEST_DIR = join(repoRoot, "config", "pi-runtime");
const RUNTIME_PACKAGE_JSON = join(RUNTIME_MANIFEST_DIR, "package.json");
const RUNTIME_PACKAGE_LOCK = join(RUNTIME_MANIFEST_DIR, "package-lock.json");
const TLH_INSTALL_MTS = join(repoRoot, "scripts", "tlh-install.mts");

function readDeclaredStringConstant(filePath: string, name: string): string {
  const source = readFileSync(filePath, "utf8");
  const pattern = new RegExp(
    `(?:^|\\n)const\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*["']([^"'\\n]+)["'];`,
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Missing ${name} constant in ${filePath}`);
  }
  return match[1];
}

function main(): void {
  // Read the pinned Pi version from the authoritative source
  const pinnedPiVersion = readDeclaredStringConstant(TLH_INSTALL_MTS, "PINNED_PI_VERSION");
  process.stdout.write(`generate-pi-runtime-lock: pinned Pi version is ${pinnedPiVersion}\n`);

  // Write (or overwrite) the minimal manifest
  const manifest = {
    name: "tlh-pi-runtime",
    version: pinnedPiVersion,
    private: true,
    dependencies: {
      [PI_PACKAGE_NAME]: pinnedPiVersion,
    },
  };
  writeFileSync(RUNTIME_PACKAGE_JSON, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`generate-pi-runtime-lock: wrote ${RUNTIME_PACKAGE_JSON}\n`);

  // npm --package-lock-only reuses an existing lock's resolutions to stay byte-stable;
  // delete config/pi-runtime/package-lock.json first to force a fresh resolution.

  // Run npm install --package-lock-only
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCmd,
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--install-strategy=nested",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: RUNTIME_MANIFEST_DIR,
      stdio: "inherit",
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw new Error(`npm install failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  if (!existsSync(RUNTIME_PACKAGE_LOCK)) {
    throw new Error(`npm did not produce ${RUNTIME_PACKAGE_LOCK}`);
  }

  process.stdout.write(`generate-pi-runtime-lock: wrote ${RUNTIME_PACKAGE_LOCK}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`generate-pi-runtime-lock: ${message}\n`);
  process.exitCode = 1;
}
