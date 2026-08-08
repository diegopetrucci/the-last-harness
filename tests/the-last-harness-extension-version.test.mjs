import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatVersionOutput, registerVersionCommand } = await jiti.import("../extensions/the-last-harness/version.ts");

const extensionSource = readFileSync(new URL("../extensions/the-last-harness.ts", import.meta.url), "utf8");
const versionSource = readFileSync(new URL("../extensions/the-last-harness/version.ts", import.meta.url), "utf8");

// --- formatVersionOutput ---

test("formatVersionOutput includes tlh and pi labels", () => {
	const output = formatVersionOutput("0.15.0", "0.79.1");
	assert.match(output, /tlh/);
	assert.match(output, /pi/);
});

test("formatVersionOutput includes both provided version strings verbatim", () => {
	const output = formatVersionOutput("1.2.3", "4.5.6");
	assert.match(output, /1\.2\.3/);
	assert.match(output, /4\.5\.6/);
});

test("formatVersionOutput is concise plain text without markup", () => {
	const output = formatVersionOutput("0.15.0", "0.79.1");
	assert.equal(typeof output, "string");
	assert.doesNotMatch(output, /[<>]/); // no HTML-like markup
	// Should be a single short line, not a multi-paragraph block
	assert.ok(output.length < 200, "version output should be concise");
});

// --- registerVersionCommand ---

test("registerVersionCommand registers a command named 'version'", () => {
	const registeredCommands = [];
	const pi = {
		registerCommand(name, _options) {
			registeredCommands.push(name);
		},
	};
	registerVersionCommand(pi);
	assert.ok(registeredCommands.includes("version"), "expected 'version' command to be registered");
});

test("version command handler notifies with formatted output at 'info' level", () => {
	let notified;
	const pi = {
		registerCommand(_name, options) {
			options.handler("", {
				ui: {
					notify(message, type) {
						notified = { message, type };
					},
				},
			});
		},
	};
	registerVersionCommand(pi);
	assert.ok(notified, "expected handler to call ctx.ui.notify");
	assert.equal(notified.type, "info");
	assert.match(notified.message, /tlh:/);
	assert.match(notified.message, /pi:/);
	// Both fields should be real semver strings from the running packages
	assert.match(notified.message, /\d+\.\d+\.\d+/);
});

// --- Extension wiring (static source checks) ---

test("extension source imports the version module", () => {
	assert.match(extensionSource, /from "\.\/the-last-harness\/version\.js"/);
});

test("extension source calls registerVersionCommand", () => {
	assert.match(extensionSource, /registerVersionCommand\(pi\)/);
});

test("version module reads pi version from upstream VERSION export", () => {
	assert.match(versionSource, /VERSION/);
	assert.match(versionSource, /@earendil-works\/pi-coding-agent/);
});

test("version module reads tlh version from package-version helper", () => {
	assert.match(versionSource, /getTlhVersion\(\)/);
	assert.match(versionSource, /from "\.\/package-version\.js"/);
});
