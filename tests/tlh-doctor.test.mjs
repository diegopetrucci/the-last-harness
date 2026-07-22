import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const doctorScript = join(repoRoot, "scripts", "tlh-doctor.mjs");
const mergeSettingsScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const defaultExtensionsPath = join(repoRoot, "config", "default-extensions.json");

function tempFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "tlh-doctor-test-"));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const runtimeDir = join(root, "runtime");
	const fakebin = join(root, "fakebin");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	mkdirSync(fakebin, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, home, agentDir, runtimeDir, fakebin };
}

function writeExecutable(path, content) {
	writeFileSync(path, content, "utf8");
	chmodSync(path, 0o755);
}

function runDoctor(args, options = {}) {
	const env = { ...process.env, ...(options.env || {}) };
	return spawnSync(process.execPath, [doctorScript, ...args], {
		cwd: options.cwd || repoRoot,
		encoding: "utf8",
		env,
	});
}

function configureHealthyFixture(t) {
	const fixture = tempFixture(t);
	const settingsPath = join(fixture.agentDir, "settings.json");
	writeFileSync(settingsPath, "{}\n", "utf8");

	const mergeResult = spawnSync(process.execPath, [
		mergeSettingsScript,
		settingsDefaultsPath,
		"--settings", settingsPath,
		"--default-extensions", defaultExtensionsPath,
	], {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agentDir },
	});
	assert.equal(mergeResult.status, 0, `${mergeResult.stdout}\n${mergeResult.stderr}`);

	const subagentsDir = join(fixture.agentDir, "tlh", "agents", "subagents");
	mkdirSync(dirname(subagentsDir), { recursive: true });
	cpSync(join(repoRoot, "agents", "subagents"), subagentsDir, { recursive: true });

	const runtimeBin = join(fixture.runtimeDir, "bin");
	mkdirSync(runtimeBin, { recursive: true });
	writeExecutable(join(runtimeBin, "pi"), "#!/bin/sh\necho 'pi 0.81.1'\n");
	writeFileSync(join(fixture.runtimeDir, ".tlh-runtime-owned"), JSON.stringify({
		schemaVersion: 1,
		packageName: "@earendil-works/pi-coding-agent",
		runtimeAbsPath: fixture.runtimeDir,
		origin: "created",
	}, null, 2));

	mkdirSync(join(fixture.agentDir, "tlh"), { recursive: true });
	writeFileSync(join(fixture.agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
	}, null, 2));

	writeExecutable(join(fixture.fakebin, "gn"), `#!/bin/sh
case "$1 $2" in
  "help plan"|"help review") exit 0 ;;
  *) exit 1 ;;
esac
`);
	writeExecutable(join(fixture.fakebin, "tk"), `#!/bin/sh
case "$1" in
  help|--help|-h)
    echo 'Usage: tk <command> [args]'
    echo 'ticket system'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);
	writeExecutable(join(fixture.fakebin, "rtk"), `#!/bin/sh
case "$1" in
  --version)
    echo 'rtk 0.43.0'
    exit 0
    ;;
  rewrite)
    shift
    printf 'rtk %s %s\n' "$1" "$2"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);
	writeExecutable(join(fixture.fakebin, "gh"), "#!/bin/sh\nexit 0\n");

	mkdirSync(join(fixture.agentDir, "extensions", "pi-web-access"), { recursive: true });
	writeFileSync(join(fixture.agentDir, "extensions", "pi-web-access", "settings.json"), JSON.stringify({ exaApiKey: "hidden" }, null, 2));
	writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"] } } }, null, 2));

	return fixture;
}

function createFakeDoctorPackageRoot(root, { gnosisDelayMs = 0 } = {}) {
	const packageRoot = join(root, "fake-package-root");
	mkdirSync(join(packageRoot, "config"), { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	cpSync(settingsDefaultsPath, join(packageRoot, "config", "settings.defaults.json"));
	cpSync(defaultExtensionsPath, join(packageRoot, "config", "default-extensions.json"));
	cpSync(join(repoRoot, "agents", "subagents"), join(packageRoot, "agents", "subagents"), { recursive: true });

	writeExecutable(join(packageRoot, "scripts", "merge-settings.mjs"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
const result = spawnSync(process.execPath, [${JSON.stringify(mergeSettingsScript)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);

	writeExecutable(join(packageRoot, "scripts", "tlh-gnosis.mjs"), `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const command = args[0];
const agentDir = args[args.indexOf("--agent-dir") + 1];
const marker = ${JSON.stringify(join(root, "gnosis-helper.log"))};
appendFileSync(marker, command + "\\n");
if (command === "configure-install") {
  await delay(${JSON.stringify(gnosisDelayMs)});
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  writeFileSync(join(agentDir, "bin", "gn"), "#!/bin/sh\\nexit 0\\n");
}
if (command === "validate") {
  process.stdout.write(existsSync(join(agentDir, "bin", "gn")) ? join(agentDir, "bin", "gn") + "\\n" : "gn\\n");
}
`);

	writeExecutable(join(packageRoot, "scripts", "tlh-tickets.mjs"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args[0];
const marker = ${JSON.stringify(join(root, "tickets-helper.log"))};
appendFileSync(marker, command + "\\n");
if (command === "status") {
  process.stdout.write("active: yes\\ncommand: tk\\n");
}
`);

	writeExecutable(join(packageRoot, "scripts", "tlh-rtk.mjs"), `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const command = args[0];
const agentDir = args[args.indexOf("--agent-dir") + 1];
const marker = ${JSON.stringify(join(root, "rtk-helper.log"))};
appendFileSync(marker, command + "\\n");
if (command === "install-managed") {
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  writeFileSync(join(agentDir, "bin", "rtk"), "#!/bin/sh\\nexit 0\\n");
}
if (command === "validate") {
  process.stdout.write(existsSync(join(agentDir, "bin", "rtk")) ? join(agentDir, "bin", "rtk") + "\\n" : "rtk\\n");
}
`);

	return packageRoot;
}

function createWrapperDoctorProbePackageRoot(root) {
	const packageRoot = join(root, "wrapper-doctor-package-root");
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	writeExecutable(join(packageRoot, "scripts", "tlh-doctor.mjs"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
let agentDir;
let settingsPath;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--agent-dir") {
    agentDir = args[index + 1];
    index += 1;
    continue;
  }
  if (args[index] === "--settings") {
    settingsPath = args[index + 1];
    index += 1;
  }
}
writeFileSync(${JSON.stringify(join(root, "wrapper-doctor-call.json"))}, JSON.stringify({
  argv: args,
  derivedAgentDir: agentDir,
  derivedSettingsPath: settingsPath ?? join(agentDir, "settings.json"),
  env: {
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  },
}, null, 2));
`);
	return packageRoot;
}

function runGeneratedWrapper(root, { agentDir, packageRoot, argv, pathEntries }) {
	const binDir = join(root, "wrapper-bin");
	const wrapperPath = join(binDir, "tlh");
	mkdirSync(binDir, { recursive: true });
	writeExecutable(wrapperPath, renderWrapper({
		agentDir,
		binDir,
		wrapperName: "tlh",
		packageRoot,
		piCmd: "",
	}));
	return spawnSync("/bin/bash", [wrapperPath, ...argv], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: pathEntries.join(delimiter),
		},
	});
}

test("renderWrapper intercepts tlh doctor", () => {
	const script = renderWrapper({
		agentDir: "/tmp/agent",
		binDir: "/tmp/bin",
		wrapperName: "tlh",
		packageRoot: "/tmp/pkg",
		piCmd: "/tmp/runtime/bin/pi",
	});

	assert.match(script, /if \[\[ "\$\{1:-\}" == "doctor" \]\]; then/);
	assert.match(script, /scripts\/tlh-doctor\.mjs/);
	assert.match(script, /PATH="\$\{tlh_sanitized_path\}" exec/);
	assert.match(script, /--package-root "\$\{default_tlh_package_root\}"/);
	assert.doesNotMatch(script, /doctor\.mjs" --agent-dir "\$\{default_agent_dir\}" --settings /);
});

test("generated wrapper doctor derives settings from an overridden agent dir without using the wrapper profile bin", (t) => {
	const fixture = tempFixture(t);
	const defaultAgentDir = join(fixture.root, "default-agent");
	const otherAgentDir = join(fixture.root, "other-agent");
	const defaultAgentBin = join(defaultAgentDir, "bin");
	const fakebin = join(fixture.root, "doctor-path");
	const packageRoot = createWrapperDoctorProbePackageRoot(fixture.root);
	mkdirSync(defaultAgentBin, { recursive: true });
	mkdirSync(otherAgentDir, { recursive: true });
	mkdirSync(fakebin, { recursive: true });
	writeExecutable(join(defaultAgentBin, "gh"), "#!/bin/sh\nexit 99\n");

	const result = runGeneratedWrapper(fixture.root, {
		agentDir: defaultAgentDir,
		packageRoot,
		argv: ["doctor", "--agent-dir", otherAgentDir],
		pathEntries: [defaultAgentBin, fakebin, dirname(process.execPath)],
	});
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, output);

	const record = JSON.parse(readFileSync(join(fixture.root, "wrapper-doctor-call.json"), "utf8"));
	assert.equal(record.derivedAgentDir, otherAgentDir);
	assert.equal(record.derivedSettingsPath, join(otherAgentDir, "settings.json"));
	assert.equal(record.argv.includes("--settings"), false);
	assert.equal(record.env.PI_CODING_AGENT_DIR, defaultAgentDir);
	assert.equal(record.env.PATH.split(delimiter)[0], fakebin);
	assert.equal(record.env.PATH.split(delimiter).includes(defaultAgentBin), false);
});

test("generated wrapper doctor preserves an explicit --settings override", (t) => {
	const fixture = tempFixture(t);
	const defaultAgentDir = join(fixture.root, "default-agent");
	const otherAgentDir = join(fixture.root, "other-agent");
	const explicitSettingsPath = join(fixture.root, "custom-settings.json");
	const packageRoot = createWrapperDoctorProbePackageRoot(fixture.root);
	mkdirSync(join(defaultAgentDir, "bin"), { recursive: true });
	mkdirSync(otherAgentDir, { recursive: true });
	writeFileSync(explicitSettingsPath, "{}\n", "utf8");

	const result = runGeneratedWrapper(fixture.root, {
		agentDir: defaultAgentDir,
		packageRoot,
		argv: ["doctor", "--agent-dir", otherAgentDir, "--settings", explicitSettingsPath],
		pathEntries: [join(defaultAgentDir, "bin"), dirname(process.execPath)],
	});
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, output);

	const record = JSON.parse(readFileSync(join(fixture.root, "wrapper-doctor-call.json"), "utf8"));
	assert.equal(record.derivedAgentDir, otherAgentDir);
	assert.equal(record.derivedSettingsPath, explicitSettingsPath);
	assert.deepEqual(record.argv.slice(-4), ["--agent-dir", otherAgentDir, "--settings", explicitSettingsPath]);
});

test("tlh doctor returns success for a healthy isolated profile", (t) => {
	const fixture = configureHealthyFixture(t);
	const result = runDoctor(["--agent-dir", fixture.agentDir, "--package-root", repoRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(output, /OK\s+profile isolation\/settings:/);
	assert.match(output, /OK\s+settings drift:/);
	assert.match(output, /OK\s+bundled subagent resources:/);
	assert.match(output, /OK\s+private runtime marker\/version hints:/);
	assert.match(output, /OK\s+managed gn validation:/);
	assert.match(output, /OK\s+managed tk validation:/);
	assert.match(output, /(OK|WARN)\s+managed rtk validation:/);
	assert.match(output, /OK\s+gh availability\/auth:/);
	assert.match(output, /OK\s+MCP\/web-search prerequisites:/);
	assert.match(output, /Summary: .*0 FAIL/);
});

test("tlh doctor fails when pointed at normal Pi config without running protected profile helpers", (t) => {
	const fixture = tempFixture(t);
	const protectedAgentDir = join(fixture.home, ".pi", "agent");
	const markerPath = join(fixture.root, "protected-gn-ran");
	const ghMarkerPath = join(fixture.root, "protected-gh-ran");
	const protectedBinDir = join(protectedAgentDir, "bin");
	mkdirSync(protectedBinDir, { recursive: true });
	writeFileSync(join(protectedAgentDir, "settings.json"), "{}\n", "utf8");
	writeExecutable(join(protectedBinDir, "gn"), `#!/bin/sh
printf ran >${JSON.stringify(markerPath)}
exit 0
`);
	writeExecutable(join(protectedBinDir, "gh"), `#!/bin/sh
printf ran >${JSON.stringify(ghMarkerPath)}
exit 0
`);

	const result = runDoctor(["--agent-dir", protectedAgentDir, "--package-root", repoRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${protectedBinDir}${delimiter}${dirname(process.execPath)}`,
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 1, output);
	assert.match(output, /FAIL\s+profile isolation\/settings: agent dir is inside ~\/\.pi; profile not inspected/);
	assert.doesNotMatch(output, /settings drift:/);
	assert.doesNotMatch(output, /bundled subagent resources:/);
	assert.doesNotMatch(output, /private runtime marker\/version hints:/);
	assert.doesNotMatch(output, /managed gn validation:/);
	assert.doesNotMatch(output, /managed tk validation:/);
	assert.doesNotMatch(output, /managed rtk validation:/);
	assert.doesNotMatch(output, /gh availability\/auth:/);
	assert.equal(existsSync(markerPath), false, "doctor must not execute helpers from protected profile bin");
	assert.equal(existsSync(ghMarkerPath), false, "doctor must not execute gh from protected profile bin");
	assert.match(output, /Summary: .*FAIL/);
});

test("tlh doctor refuses normal Pi settings path before parsing", (t) => {
	const fixture = tempFixture(t);
	const protectedSettings = join(fixture.home, ".pi", "agent", "settings.json");
	mkdirSync(dirname(protectedSettings), { recursive: true });
	writeFileSync(protectedSettings, "{ not valid json\n", "utf8");

	const result = runDoctor([
		"--agent-dir", fixture.agentDir,
		"--settings", protectedSettings,
		"--package-root", repoRoot,
	], {
		env: {
			HOME: fixture.home,
			PATH: dirname(process.execPath),
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 1, output);
	assert.match(output, /FAIL\s+profile isolation\/settings: isolated agent dir; settings path is inside ~\/\.pi; settings not read/);
	assert.doesNotMatch(output, /Invalid JSON/i);
	assert.doesNotMatch(output, /settings drift:/);
	assert.doesNotMatch(output, /MCP\/web-search prerequisites:/);
	assert.doesNotMatch(output, /managed tk validation:/);
});

test("tlh doctor reports repairable settings drift without mutating settings or creating backups", (t) => {
	const fixture = configureHealthyFixture(t);
	const settingsPath = join(fixture.agentDir, "settings.json");
	const driftedSettings = {
		subagents: {
			disableBuiltins: false,
			agentOverrides: {
				developer: { model: "kept" },
			},
		},
		packages: ["git:github.com/example/unmanaged-extension"],
	};
	writeFileSync(settingsPath, JSON.stringify(driftedSettings, null, 2));
	const settingsBeforeDoctor = readFileSync(settingsPath, "utf8");
	const backupsBeforeDoctor = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	const result = runDoctor(["--agent-dir", fixture.agentDir, "--package-root", repoRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const settingsAfterDoctor = readFileSync(settingsPath, "utf8");
	const backupsAfterDoctor = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	assert.equal(result.status, 0, output);
	assert.match(output, /WARN\s+settings drift:/);
	assert.match(output, /pending packaged change\(s\) \(/);
	assert.equal(settingsAfterDoctor, settingsBeforeDoctor, "plain doctor must not rewrite drifted settings");
	assert.equal(backupsAfterDoctor, backupsBeforeDoctor, "plain doctor must not create settings backups");
	assert.doesNotMatch(output, /Repair actions:/);
});


test("tlh doctor drift summary does not disclose credential-like package sources", (t) => {
	const fixture = configureHealthyFixture(t);
	const settingsPath = join(fixture.agentDir, "settings.json");
	const driftedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
	driftedSettings.packages = [
		...driftedSettings.packages,
		"https://alice:token-123@github.com/nicobailon/pi-web-access.git#main",
	];
	writeFileSync(settingsPath, JSON.stringify(driftedSettings, null, 2));
	const settingsBeforeDoctor = readFileSync(settingsPath, "utf8");
	const backupsBeforeDoctor = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	const result = runDoctor(["--agent-dir", fixture.agentDir, "--package-root", repoRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const settingsAfterDoctor = readFileSync(settingsPath, "utf8");
	const backupsAfterDoctor = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	assert.equal(result.status, 0, output);
	assert.match(output, /WARN\s+settings drift:/);
	assert.match(output, /pending packaged change\(s\) \(/);
	assert.doesNotMatch(output, /alice|token-123|nicobailon|https?:\/\//i);
	assert.equal(settingsAfterDoctor, settingsBeforeDoctor, "plain doctor must stay read-only for drift checks");
	assert.equal(backupsAfterDoctor, backupsBeforeDoctor, "plain doctor must not create settings backups");
});

test("tlh doctor reports stale bundled subagent prompts as repairable drift", (t) => {
	const fixture = configureHealthyFixture(t);
	const stalePromptPath = join(fixture.agentDir, "tlh", "agents", "subagents", "contrarian.md");
	writeFileSync(stalePromptPath, "stale contrarian prompt\n", "utf8");

	const result = runDoctor(["--agent-dir", fixture.agentDir, "--package-root", repoRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 1, output);
	assert.match(output, /FAIL\s+bundled subagent resources: restoration needed for 1 prompt\(s\): contrarian\.md/);
	assert.equal(readFileSync(stalePromptPath, "utf8"), "stale contrarian prompt\n");
});


test("tlh doctor --repair restores isolated settings drift, preserves user values, and creates a backup", (t) => {
	const fixture = configureHealthyFixture(t);
	const packageRoot = createFakeDoctorPackageRoot(fixture.root);
	const settingsPath = join(fixture.agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			disableBuiltins: false,
			agentOverrides: {
				developer: { model: "kept" },
			},
		},
		packages: ["git:github.com/example/unmanaged-extension"],
	}, null, 2));
	const stalePromptPath = join(fixture.agentDir, "tlh", "agents", "subagents", "contrarian.md");
	writeFileSync(stalePromptPath, "stale contrarian prompt\n", "utf8");
	const backupsBeforeRepair = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	const result = runDoctor(["--repair", "--agent-dir", fixture.agentDir, "--package-root", packageRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const repairedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
	const backupsAfterRepair = readdirSync(fixture.agentDir).filter((entry) => /^settings\.json\.backup-/.test(entry)).length;

	assert.equal(result.status, 0, output);
	assert.equal(repairedSettings.subagents.disableBuiltins, true);
	assert.deepEqual(repairedSettings.subagents.agentDirs, ["tlh/agents/subagents"]);
	assert.deepEqual(repairedSettings.subagents.agentOverrides, { developer: { model: "kept" } });
	assert.ok(repairedSettings.packages.includes("git:github.com/example/unmanaged-extension"));
	assert.equal(backupsAfterRepair, backupsBeforeRepair + 1, "repair should create one additional settings backup");
	assert.equal(existsSync(join(fixture.agentDir, "tlh", "agents", "subagents", "developer.md")), true);
	assert.equal(readFileSync(stalePromptPath, "utf8"), readFileSync(join(packageRoot, "agents", "subagents", "contrarian.md"), "utf8"));
	assert.match(readFileSync(join(fixture.root, "gnosis-helper.log"), "utf8"), /configure-install/);
	assert.match(readFileSync(join(fixture.root, "tickets-helper.log"), "utf8"), /configure-install/);
	assert.match(readFileSync(join(fixture.root, "rtk-helper.log"), "utf8"), /install-managed/);
	assert.match(output, /Repair actions:/);
	assert.match(output, /OK\s+settings drift:/);
	assert.match(output, /OK\s+bundled subagent resources: restored 1 prompt\(s\) from packaged defaults/);
	assert.match(output, /WARN\s+private runtime: runtime replacement stays manual; run `tlh update` if runtime drift remains/);
	assert.match(output, /OK\s+profile isolation\/settings:/);
	assert.match(output, /OK\s+settings drift:/);
	assert.match(output, /OK\s+bundled subagent resources:/);
	assert.match(output, /Summary: .*0 FAIL/);
});

test("tlh doctor --repair repairs malformed subagents containers without --force", (t) => {
	const fixture = configureHealthyFixture(t);
	const packageRoot = createFakeDoctorPackageRoot(fixture.root);
	const settingsPath = join(fixture.agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: "broken",
		packages: ["git:github.com/example/unmanaged-extension"],
	}, null, 2));

	const result = runDoctor(["--repair", "--agent-dir", fixture.agentDir, "--package-root", packageRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const repairedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));

	assert.equal(result.status, 0, output);
	assert.deepEqual(repairedSettings.subagents, {
		disableBuiltins: true,
		agentDirs: ["tlh/agents/subagents"],
	});
	assert.ok(repairedSettings.packages.includes("git:github.com/example/unmanaged-extension"));
	assert.match(output, /OK\s+settings drift:/);
	assert.match(output, /Summary: .*0 FAIL/);
});

test("tlh doctor --repair allows managed helper repairs to run longer than diagnostics timeout", (t) => {
	const fixture = configureHealthyFixture(t);
	const packageRoot = createFakeDoctorPackageRoot(fixture.root, { gnosisDelayMs: 5500 });

	const result = runDoctor(["--repair", "--agent-dir", fixture.agentDir, "--package-root", packageRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
			EXA_API_KEY: "hidden",
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(readFileSync(join(fixture.root, "gnosis-helper.log"), "utf8"), /configure-install/);
	assert.match(output, /OK\s+managed gn install:/);
	assert.doesNotMatch(output, /ETIMEDOUT|timed out|spawnSync .*timeout/i);
});

test("tlh doctor --repair refuses settings paths outside the isolated profile before reading or invoking helpers", (t) => {
	const fixture = tempFixture(t);
	const packageRoot = createFakeDoctorPackageRoot(fixture.root);
	const outsideSettings = join(fixture.root, "outside-settings.json");
	writeFileSync(outsideSettings, "{ not valid json\n", "utf8");

	const result = runDoctor([
		"--repair",
		"--agent-dir", fixture.agentDir,
		"--settings", outsideSettings,
		"--package-root", packageRoot,
	], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 1, output);
	assert.match(output, /refusing repair for settings path outside isolated TLH profile/);
	assert.doesNotMatch(output, /Invalid JSON/i);
	assert.equal(readFileSync(outsideSettings, "utf8"), "{ not valid json\n");
	assert.equal(existsSync(join(fixture.root, "gnosis-helper.log")), false);
	assert.equal(existsSync(join(fixture.root, "tickets-helper.log")), false);
	assert.equal(existsSync(join(fixture.root, "rtk-helper.log")), false);
});

test("tlh doctor --repair refuses normal Pi targets before reading settings or invoking helpers", (t) => {
	const fixture = tempFixture(t);
	const packageRoot = createFakeDoctorPackageRoot(fixture.root);
	const protectedAgentDir = join(fixture.home, ".pi", "agent");
	const protectedSettings = join(protectedAgentDir, "settings.json");
	mkdirSync(protectedAgentDir, { recursive: true });
	writeFileSync(protectedSettings, "{ not valid json\n", "utf8");

	const result = runDoctor(["--repair", "--agent-dir", protectedAgentDir, "--package-root", packageRoot], {
		env: {
			HOME: fixture.home,
			PATH: `${fixture.fakebin}:${process.env.PATH}`,
		},
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 1, output);
	assert.match(output, /refusing repair for normal Pi agent dir inside ~\/\.pi/);
	assert.doesNotMatch(output, /Invalid JSON/i);
	assert.equal(readFileSync(protectedSettings, "utf8"), "{ not valid json\n");
	assert.equal(existsSync(join(fixture.root, "gnosis-helper.log")), false);
	assert.equal(existsSync(join(fixture.root, "tickets-helper.log")), false);
	assert.equal(existsSync(join(fixture.root, "rtk-helper.log")), false);
});
