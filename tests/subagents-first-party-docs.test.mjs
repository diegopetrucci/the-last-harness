import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const historyRoot = join(repoRoot, "docs", "subagents-history");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

const nicoLicense = `MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

test("subagents runtime is a first-party root entrypoint without an external default", () => {
	const packageJson = readJson(join(repoRoot, "package.json"));
	const defaults = readJson(join(repoRoot, "config", "default-extensions.json"));
	assert.ok(packageJson.pi.extensions.includes("./extensions/subagents/src/extension/index.js"));
	assert.equal(
		defaults.some((entry) => entry.id === "subagents" || entry.aliases?.includes("pi-subagents") || /pi-subagents/i.test(entry.source)),
		false,
	);
});

test("shipped subagents notice exactly preserves Nico Bailon's MIT notice", () => {
	const notice = readFileSync(join(repoRoot, "extensions", "subagents", "LICENSE"), "utf8");
	assert.equal(notice, nicoLicense);
	assert.equal(sha256(notice), "2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c");

	const rootLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8");
	assert.match(rootLicense, /Copyright \(c\) 2026 Diego Petrucci/);
	assert.notEqual(rootLicense, notice);

	const history = readFileSync(join(historyRoot, "HISTORY.md"), "utf8");
	assert.match(history, /6e8266fb65c68d6e3d3392104450a8c9716d45f2/);
	assert.match(history, /checkpoint contained no root `LICENSE` file/);
});

test("immutable subagent history archive matches its manifest and exact ledgers", () => {
	const manifest = readJson(join(historyRoot, "import-manifest.json"));
	const historicalEntries = manifest.includedFiles.filter((entry) => entry.category === "historical-source-archive");
	assert.equal(historicalEntries.length, 17);
	assert.equal(manifest.counts.historicalArchiveFiles, 17);
	assert.equal(manifest.scope.gitBundleIncluded, false);

	const expectedPaths = new Set(historicalEntries.map((entry) => entry.destinationPath));
	const actualPaths = new Set(
		listFiles(join(historyRoot, "source")).map((path) => relative(repoRoot, path)),
	);
	assert.deepEqual([...actualPaths].sort(), [...expectedPaths].sort());
	assert.equal([...actualPaths].some((path) => /\.(?:bundle|pack)$/i.test(path)), false);

	for (const entry of historicalEntries) {
		const path = join(repoRoot, entry.destinationPath);
		assert.equal(sha256(readFileSync(path)), entry.sha256, entry.destinationPath);
		assert.equal((statSync(path).mode & 0o111) !== 0, entry.destinationMode === "100755", entry.destinationPath);
	}

	const gnosisPath = join(repoRoot, manifest.historicalLedgers.gnosis.destinationPath);
	const upstreamPath = join(repoRoot, manifest.historicalLedgers.upstreamAdoption.destinationPath);
	assert.equal(readFileSync(gnosisPath, "utf8").split("\n").filter(Boolean).length, 29);
	assert.equal(readFileSync(upstreamPath, "utf8").split("\n").filter(Boolean).length, 6);
	assert.equal(sha256(readFileSync(gnosisPath)), "c94da350f1851bb233eecbd574d4514a177d98153cb6960fc0cceeaadbe07586");
});
