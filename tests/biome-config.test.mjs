import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const biomeConfigPath = resolve(testDir, "..", "biome.json");

test("biome.json parses as strict JSON", () => {
	const raw = readFileSync(biomeConfigPath, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		assert.fail(`biome.json failed strict JSON.parse: ${err.message}`);
	}
	assert.equal(typeof parsed, "object", "biome.json root should be an object");
});

test("biome.json formatter.lineWidth is 120", () => {
	const raw = readFileSync(biomeConfigPath, "utf8");
	const parsed = JSON.parse(raw);
	assert.equal(
		parsed?.formatter?.lineWidth,
		120,
		"formatter.lineWidth must be 120; if this fails the config may be missing or using Biome defaults",
	);
});
