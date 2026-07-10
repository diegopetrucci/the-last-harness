import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "tlh-install-stage1-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function captureConsole(method, callback) {
	const original = console[method];
	const lines = [];
	console[method] = (...args) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		callback();
	} finally {
		console[method] = original;
	}
	return lines.join("\n");
}
