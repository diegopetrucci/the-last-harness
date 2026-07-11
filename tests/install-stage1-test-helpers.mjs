import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

export function readPiLog(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
}

export function readPiLogRecords(path) {
	return readPiLog(path).map((line) => {
		const [agentDir, cwd, ...commandParts] = line.split("|");
		return { agentDir, cwd, command: commandParts.join("|") };
	});
}
