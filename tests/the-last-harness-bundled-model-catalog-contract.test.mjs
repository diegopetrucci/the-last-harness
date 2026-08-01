import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadPrimaryAgents, loadSubagentMetadata } = await jiti.import("../extensions/the-last-harness/prompts.ts");

function collectBundledModelReferences() {
	const references = new Map();
	const bundledAgents = [...loadPrimaryAgents().values(), ...loadSubagentMetadata()];

	for (const agent of bundledAgents) {
		for (const [field, values] of [
			["model", agent.model ? [agent.model] : []],
			["tlhOpenaiModels", agent.tlhOpenaiModels ?? []],
			["tlhAnthropicModels", agent.tlhAnthropicModels ?? []],
		]) {
			for (const value of values) {
				const sources = references.get(value) ?? [];
				sources.push(`${agent.name}:${field}`);
				references.set(value, sources);
			}
		}
	}

	return [...references.entries()].sort(([left], [right]) => left.localeCompare(right));
}

test("bundled agent model references resolve in the pinned built-in ModelRuntime catalog without auth or network", async (t) => {
	const runtimeDir = mkdtempSync(join(tmpdir(), "tlh-bundled-model-catalog-"));
	t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));

	const runtime = await ModelRuntime.create({
		authPath: join(runtimeDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const references = collectBundledModelReferences();

	assert.ok(references.length > 0, "expected bundled model references");
	for (const [reference, sources] of references) {
		const [provider, modelId, ...rest] = reference.split("/");
		assert.equal(rest.length, 0, `expected canonical provider/model reference for ${reference}`);
		assert.ok(provider, `expected provider in ${reference}`);
		assert.ok(modelId, `expected model id in ${reference}`);

		const model = runtime.getModel(provider, modelId);
		assert.ok(model, `${reference} from ${sources.join(", ")} should exist in the pinned built-in catalog`);
		assert.equal(model.id, modelId);
		assert.equal(model.provider, provider);
	}
});
