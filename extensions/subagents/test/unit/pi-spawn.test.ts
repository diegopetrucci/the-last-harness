import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { getPiSpawnCommand, resolvePiCliScript, resolveWindowsPiCliScript, type PiSpawnDeps } from "../../src/runs/shared/pi-spawn.ts";

function makeDeps(input: {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existing?: string[];
	packageJsonPath?: string;
	packageJsonContent?: string;
	packageEntry?: string;
	installedPackageRoot?: string;
	env?: NodeJS.ProcessEnv;
}): PiSpawnDeps {
	const existing = new Set(input.existing ?? []);
	const packageJsonPath = input.packageJsonPath;
	const packageJsonContent = input.packageJsonContent;
	return {
		platform: input.platform,
		execPath: input.execPath,
		argv1: input.argv1,
		existsSync: (filePath) => existing.has(filePath),
		readFileSync: (_filePath, _encoding) => {
			if (!packageJsonPath || !packageJsonContent) {
				throw new Error("package json not configured");
			}
			return packageJsonContent;
		},
		resolvePackageJson: packageJsonPath ? () => packageJsonPath : undefined,
		resolvePackageEntry: input.packageEntry ? () => input.packageEntry! : undefined,
		resolveInstalledPackageRoot: () => input.installedPackageRoot,
		env: input.env ?? {},
	};
}

describe("getPiSpawnCommand", () => {
	it("honors explicit PI_SUBAGENT_PI_BINARY override on any platform, even over a resolvable Pi package", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-env-override-"));
		try {
			const packageRoot = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
			const argv1 = path.join(packageRoot, "dist", "cli.js");
			fs.mkdirSync(path.dirname(argv1), { recursive: true });
			fs.writeFileSync(argv1, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
			const args = ["--mode", "json", "Task: check output"];
			const result = getPiSpawnCommand(args, {
				platform: "win32",
				execPath: "/usr/local/bin/node",
				argv1,
				env: { PI_SUBAGENT_PI_BINARY: "/nix/store/pi-wrapper/bin/nhost-code-agent" },
			});
			assert.deepEqual(result, {
				command: "/nix/store/pi-wrapper/bin/nhost-code-agent",
				args,
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores a blank PI_SUBAGENT_PI_BINARY override and falls through to resolution", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, {
			platform: "darwin",
			env: { PI_SUBAGENT_PI_BINARY: "   " },
			resolvePackageJson: () => {
				throw new Error("package json unavailable");
			},
			resolveInstalledPackageRoot: () => undefined,
		});
		assert.deepEqual(result, { command: "pi", args });
	});

	it("uses node plus the current Pi CLI on non-Windows when argv1 belongs to the Pi package", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-argv-root-"));
		try {
			const packageRoot = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
			const argv1 = path.join(packageRoot, "dist", "cli.js");
			fs.mkdirSync(path.dirname(argv1), { recursive: true });
			fs.writeFileSync(argv1, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
			const args = ["--mode", "json", "Task: check output"];
			const result = getPiSpawnCommand(args, { platform: "darwin", execPath: "/usr/local/bin/node", argv1 });
			assert.deepEqual(result, { command: "/usr/local/bin/node", args: [fs.realpathSync(argv1), ...args] });
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not trust arbitrary runnable argv1 scripts as Pi", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-arbitrary-argv-"));
		try {
			const argv1 = path.join(tempDir, "wrapper.mjs");
			fs.writeFileSync(argv1, "export {};\n");
			const args = ["--mode", "json", "Task: check output"];
			const result = getPiSpawnCommand(args, {
				platform: "darwin",
				execPath: "/usr/local/bin/node",
				argv1,
				resolvePackageJson: () => {
					throw new Error("package json unavailable");
				},
				resolveInstalledPackageRoot: () => undefined,
			});
			assert.deepEqual(result, { command: "pi", args });
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses node plus the resolved package CLI on non-Windows instead of PATH pi", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.js",
		);
		const deps = makeDeps({
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "/usr/local/bin/node", args: [cliPath, ...args] });
	});

	it("uses the installed runtime package CLI on non-Windows when argv1 cannot resolve the runtime root", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-installed-runtime-"));
		try {
			const packageRoot = path.join(tempDir, "private-runtime");
			const packageJsonPath = path.join(packageRoot, "package.json");
			const cliPath = path.join(packageRoot, "dist", "cli", "index.js");
			const argv1 = path.join(tempDir, "pi-wrapper.mjs");
			fs.mkdirSync(path.dirname(cliPath), { recursive: true });
			fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
			fs.writeFileSync(packageJsonPath, JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "dist/cli/index.js" },
			}));
			fs.writeFileSync(argv1, "export {};\n");

			const args = ["-p", "Task: hello"];
			const result = getPiSpawnCommand(args, {
				platform: "darwin",
				execPath: "/usr/local/bin/node",
				argv1,
				resolveInstalledPackageRoot: () => packageRoot,
			});
			assert.deepEqual(result, { command: "/usr/local/bin/node", args: [cliPath, ...args] });
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to plain pi command on non-Windows when CLI script cannot be resolved", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, {
			platform: "darwin",
			argv1: undefined,
			resolvePackageJson: () => {
				throw new Error("package json unavailable");
			},
			resolveInstalledPackageRoot: () => undefined,
		});
		assert.deepEqual(result, { command: "pi", args });
	});

	it("uses node + argv1 script on Windows when argv1 belongs to the Pi package", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-windows-argv-root-"));
		try {
			const packageRoot = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
			const argv1 = path.join(packageRoot, "dist", "cli.js");
			fs.mkdirSync(path.dirname(argv1), { recursive: true });
			fs.writeFileSync(argv1, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
			const args = ["--mode", "json", 'Task: Read C:/dev/file.md and review "quotes" & pipes | too'];
			const result = getPiSpawnCommand(args, { platform: "win32", execPath: "/usr/local/bin/node", argv1 });
			assert.equal(result.command, "/usr/local/bin/node");
			assert.equal(result.args[0], fs.realpathSync(argv1));
			assert.equal(result.args[3], args[2]);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves CLI script from package bin when argv1 is not runnable JS", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(path.dirname(packageJsonPath), "dist/cli/index.js");
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], cliPath);
	});

	it("falls back to pi when Windows CLI script cannot be resolved", () => {
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/pi/subagent-runner.ts",
			existing: [],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "pi", args });
	});

	it("walks from package main entry to resolve package bin", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-spawn-package-root-"),
		);
		try {
			const packageRoot = path.join(
				tempDir,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
			);
			const entry = path.join(packageRoot, "dist", "index.js");
			const cliPath = path.join(packageRoot, "dist", "cli", "index.js");
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.mkdirSync(path.dirname(cliPath), { recursive: true });
			fs.writeFileSync(entry, "export {};\n");
			fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
			fs.writeFileSync(
				path.join(packageRoot, "package.json"),
				JSON.stringify({
					name: "@earendil-works/pi-coding-agent",
					bin: { pi: "dist/cli/index.js" },
				}),
			);
			const result = getPiSpawnCommand(["-p", "Task: hello"], {
				platform: "win32",
				execPath: "/usr/local/bin/node",
				argv1: "/opt/pi/subagent-runner.ts",
				resolvePackageEntry: () => entry,
				env: {},
			});
			assert.equal(result.command, "/usr/local/bin/node");
			assert.equal(result.args[0], cliPath);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("getPiSpawnCommand with piPackageRoot", () => {
	it("prefers explicit piPackageRoot over a competing argv1 Pi CLI", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-explicit-root-"));
		try {
			const argvPackageRoot = path.join(tempDir, "argv-runtime");
			const argv1 = path.join(argvPackageRoot, "dist", "cli.js");
			fs.mkdirSync(path.dirname(argv1), { recursive: true });
			fs.writeFileSync(argv1, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(argvPackageRoot, "package.json"), JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "dist/cli.js" },
			}));

			const explicitPackageRoot = path.join(tempDir, "private-runtime");
			const explicitCliPath = path.join(explicitPackageRoot, "dist", "cli", "index.mjs");
			fs.mkdirSync(path.dirname(explicitCliPath), { recursive: true });
			fs.writeFileSync(explicitCliPath, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(explicitPackageRoot, "package.json"), JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "dist/cli/index.mjs" },
			}));

			const result = getPiSpawnCommand(["-p", "Task: hello"], {
				platform: "darwin",
				execPath: "/usr/local/bin/node",
				argv1,
				piPackageRoot: explicitPackageRoot,
			});
			assert.deepEqual(result, {
				command: "/usr/local/bin/node",
				args: [explicitCliPath, "-p", "Task: hello"],
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers the PI_SUBAGENT_PI_BINARY env override over an explicit piPackageRoot", () => {
		const explicitPackageRoot = "/opt/private-runtime";
		const result = getPiSpawnCommand(["-p", "Task: hello"], {
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			piPackageRoot: explicitPackageRoot,
			env: { PI_SUBAGENT_PI_BINARY: "/nix/store/pi-wrapper/bin/nhost-code-agent" },
			existsSync: () => true,
			readFileSync: () => JSON.stringify({ bin: { pi: "dist/cli/index.js" } }),
		});
		assert.deepEqual(result, {
			command: "/nix/store/pi-wrapper/bin/nhost-code-agent",
			args: ["-p", "Task: hello"],
		});
	});

	it("does not fall back to ambient pi when explicit piPackageRoot is unusable", () => {
		const packageRoot = "/opt/private-runtime";
		const packageJsonPath = path.join(packageRoot, "package.json");
		const result = getPiSpawnCommand(["-p", "Task: hello"], {
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			piPackageRoot: packageRoot,
			existsSync: () => false,
			readFileSync: (filePath, _encoding) => {
				assert.equal(filePath, packageJsonPath);
				return JSON.stringify({ bin: { pi: "dist/cli/index.js" } });
			},
		});
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], "-e");
		assert.match(result.args[1], /Refusing ambient pi fallback\./);
		assert.match(result.args[1], new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	it("does not fall back to ambient pi when an installed package root is unusable", () => {
		const packageRoot = "/opt/installed-runtime";
		const packageJsonPath = path.join(packageRoot, "package.json");
		const result = getPiSpawnCommand(["-p", "Task: hello"], {
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			argv1: "/tmp/pi-wrapper.mjs",
			existsSync: () => false,
			readFileSync: (filePath, _encoding) => {
				assert.equal(filePath, packageJsonPath);
				return JSON.stringify({ bin: { pi: "dist/cli/index.js" } });
			},
			resolveInstalledPackageRoot: () => packageRoot,
		});
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], "-e");
		assert.match(result.args[1], /installed package root/);
		assert.match(result.args[1], /Refusing ambient pi fallback\./);
	});
});

describe("resolvePiCliScript", () => {
	it("supports package bin as string", () => {
		const packageJsonPath = "/opt/pi/package.json";
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.mjs",
		);
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/pi/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: "dist/cli/index.mjs" }),
			existing: [packageJsonPath, cliPath],
		});
		assert.equal(resolvePiCliScript(deps), cliPath);
		assert.equal(resolveWindowsPiCliScript(deps), cliPath);
	});
});
