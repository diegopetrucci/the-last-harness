import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { __testing, readSystemClipboard, writeSystemClipboard } = await jiti.import(
	"../extensions/annotate-git-diff/clipboard.ts",
);

const { MAX_CLIPBOARD_BYTES } = __testing;

test("clipboard reader falls back across linux commands and preserves the bounded maxBuffer", () => {
	const calls = [];
	const text = readSystemClipboard({
		platform: "linux",
		runner(command, args, options) {
			calls.push({ command, args, options });
			if (command === "wl-paste") {
				return { status: 1, stderr: "missing wayland" };
			}
			if (command === "xclip") {
				return { status: 0, stdout: Buffer.from("copied text") };
			}
			return { status: 1, stderr: "unexpected" };
		},
	});

	assert.equal(text, "copied text");
	assert.deepEqual(
		calls.map(({ command }) => command),
		["wl-paste", "xclip"],
	);
	assert.deepEqual(
		calls.map(({ options }) => options.maxBuffer),
		[MAX_CLIPBOARD_BYTES, MAX_CLIPBOARD_BYTES],
	);
});

test("clipboard writer falls back across linux commands and forwards input text", () => {
	const calls = [];
	writeSystemClipboard("review output", {
		platform: "linux",
		runner(command, args, options) {
			calls.push({ command, args, options });
			if (command === "wl-copy") {
				return { status: null, signal: "SIGTERM", stderr: "terminated" };
			}
			if (command === "xclip") {
				return { status: 0, stdout: "" };
			}
			return { status: 1, stderr: "unexpected" };
		},
	});

	assert.deepEqual(
		calls.map(({ command }) => command),
		["wl-copy", "xclip"],
	);
	assert.deepEqual(
		calls.map(({ options }) => options.input),
		["review output", "review output"],
	);
});

test("clipboard failures report every attempted command and honor injected platform labels", () => {
	assert.throws(
		() =>
			readSystemClipboard({
				platform: "aix",
				runner() {
					throw new Error("runner should not be used");
				},
			}),
		/system clipboard is unsupported on aix/i,
	);

	assert.throws(
		() =>
			writeSystemClipboard("review output", {
				platform: "linux",
				runner(command) {
					if (command === "wl-copy") {
						return { status: 1, stderr: "failed wayland" };
					}
					if (command === "xclip") {
						return { error: new Error("xclip missing") };
					}
					return { status: 1, stderr: "xsel failed" };
				},
			}),
		/No system clipboard command succeeded\. wl-copy --type text\/plain: wl-copy --type text\/plain exited with 1: failed wayland; xclip -selection clipboard -in: xclip missing; xsel --clipboard --input: xsel --clipboard --input exited with 1: xsel failed/,
	);
});
