import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, "..");
const runnerPath = join(testsDir, "package-runtime-smoke-runner.mjs");
const expectedEntrypoints = [
	"./extensions/annotate-git-diff/index.js",
	"./extensions/rtk.js",
	"./extensions/the-last-harness.js",
];
const requiredPackedAssets = [
	"CHANGELOG.md",
	"agents/primary/architect.md",
	"agents/subagents/developer.md",
	"extensions/annotate-git-diff/web/app.js",
	"extensions/annotate-git-diff/web/index.html",
	"extensions/annotate-git-diff/web/review-state.js",
	"extensions/the-last-harness/annotate-last-message/web/app.js",
	"extensions/the-last-harness/annotate-last-message/web/index.html",
	"extensions/the-last-harness-primary-agent.mjs",
	"extensions/the-last-harness-subagent-safety.mjs",
	"package.json",
];

function isolatedEnv(root, agentDir) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			key === "PI_CODING_AGENT_DIR"
			|| key === "PI_SUBAGENT_CHILD"
			|| key.startsWith("RTK_")
			|| key.startsWith("TLH_")
		) {
			delete env[key];
		}
	}
	return {
		...env,
		HOME: join(root, "home"),
		PI_CODING_AGENT_DIR: agentDir,
		TLH_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		TLH_SKIP_TELEMETRY: "1",
		TLH_SKIP_UPDATE_CHECK: "1",
	};
}

test("packed TLH generated JavaScript loads and reloads through pinned Pi 0.80.6", (t) => {
	const root = mkdtempSync(join(tmpdir(), "tlh-package-runtime-smoke-"));
	const binDir = join(root, "bin");
	const packDir = join(root, "pack");
	const extractDir = join(root, "extract");
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const path of [binDir, packDir, extractDir, cwd, agentDir, homeDir]) mkdirSync(path, { recursive: true });

	const rtkStubPath = join(binDir, "rtk");
	writeFileSync(rtkStubPath, "#!/usr/bin/env bash\nset -euo pipefail\nif [[ ${1:-} == --version ]]; then\n\techo 'rtk 0.23.0'\n\texit 0\nfi\nexit 1\n");
	chmodSync(rtkStubPath, 0o755);

	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			tlh: {
				primaryAgent: { enabled: false, selected: "disabled" },
				telemetry: { enabled: false },
				updateCheck: { enabled: false },
			},
		}, null, 2)}\n`,
	);

	const env = isolatedEnv(root, agentDir);
	env.PATH = [binDir, env.PATH || ""].filter(Boolean).join(":");
	const packResult = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
		cwd: repoRoot,
		encoding: "utf8",
		env,
	});
	assert.equal(packResult.status, 0, packResult.stderr || packResult.stdout);
	const [pack] = JSON.parse(packResult.stdout);
	assert.equal(pack.name, "the-last-harness");

	const packedPaths = new Set(pack.files.map((file) => file.path));
	const generatedExtensionPaths = globSync("extensions/**/*.ts", { cwd: repoRoot })
		.filter((path) => !path.endsWith(".d.ts"))
		.map((path) => path.replace(/\.ts$/, ".js"))
		.sort();
	assert.equal(generatedExtensionPaths.length, 66);
	for (const generatedPath of generatedExtensionPaths) {
		assert.ok(packedPaths.has(generatedPath), `npm pack omitted generated extension module ${generatedPath}`);
	}
	for (const assetPath of requiredPackedAssets) {
		assert.ok(packedPaths.has(assetPath), `npm pack omitted runtime asset ${assetPath}`);
	}

	const tarballPath = join(packDir, pack.filename);
	const extractResult = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8", env });
	assert.equal(extractResult.status, 0, extractResult.stderr || extractResult.stdout);
	const packageRoot = join(extractDir, "package");
	const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(packedManifest.pi.extensions, expectedEntrypoints);
	assert.equal(packedManifest.peerDependencies["@earendil-works/pi-coding-agent"], "0.80.6");
	assert.equal(packedManifest.peerDependencies["@earendil-works/pi-tui"], "0.80.6");

	// npm pack intentionally excludes installed dependencies. Link the checkout's already-pinned,
	// offline node_modules into the disposable package so Pi can execute the packed artifact.
	symlinkSync(join(repoRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
	const runtimeResult = spawnSync(process.execPath, [runnerPath, packageRoot, cwd, agentDir], {
		cwd,
		encoding: "utf8",
		env,
		timeout: 60_000,
	});
	assert.equal(runtimeResult.status, 0, runtimeResult.stderr || runtimeResult.stdout);
	const runtimeEvidence = JSON.parse(runtimeResult.stdout.trim());
	assert.equal(runtimeEvidence.piVersion, "0.80.6");
	assert.deepEqual(runtimeEvidence.entrypoints, expectedEntrypoints.map((path) => path.slice(2)));
	assert.equal(runtimeEvidence.factoryExecutions, 2);
	assert.ok(runtimeEvidence.changelogBytes > 1000);
	assert.ok(runtimeEvidence.reviewHtmlBytes > 100_000);
	assert.ok(runtimeEvidence.annotateHtmlBytes > 1000);
});
