import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { activateTlhTicketRuntime } = await jiti.import("../extensions/the-last-harness/tickets.ts");

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-ticket-runtime-test-"));
	const agent = join(dir, "agent");
	const external = join(dir, "external");
	mkdirSync(agent, { recursive: true });
	mkdirSync(external, { recursive: true });
	return { dir, agent, external };
}

function writeFakeTk(path, label) {
	writeFileSync(path, `#!/bin/sh
case "\${1:-}" in
  help|--help|-h)
    echo "tk - ${label} ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    echo "${label}:\${1:-}"
    exit 0
    ;;
esac
`);
	chmodSync(path, 0o755);
}

function withPath(path, fn) {
	const previousPath = process.env.PATH;
	try {
		process.env.PATH = path;
		return fn();
	} finally {
		if (previousPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previousPath;
		}
	}
}

function pathEntries() {
	return (process.env.PATH || "").split(delimiter).filter(Boolean);
}

test("ticket runtime prepends an external configured tk path outside PATH", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const externalTk = join(fixture.external, "tk");
	writeFakeTk(externalTk, "external-configured");

	withPath("", () => {
		const command = activateTlhTicketRuntime({ tlh: { tickets: { installPath: externalTk } } }, fixture.agent);

		assert.equal(command, externalTk);
		assert.deepEqual(pathEntries(), [fixture.external]);

		const result = spawnSync("tk", ["status"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.match(result.stdout, /external-configured:status/);
	});
});

test("disabled ticket integration does not validate or prepend a configured tk path", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const externalTk = join(fixture.external, "tk");
	const sentinel = join(fixture.dir, "disabled-tk-called");
	writeFileSync(externalTk, `#!/bin/sh
printf called > ${JSON.stringify(sentinel)}
echo "Usage: tk <command> [args]"
echo "ticket system"
exit 0
`);
	chmodSync(externalTk, 0o755);

	withPath("", () => {
		const command = activateTlhTicketRuntime({ tlh: { tickets: { enabled: false, installPath: externalTk } } }, fixture.agent);

		assert.equal(command, undefined);
		assert.equal(process.env.PATH, "");
		assert.equal(existsSync(sentinel), false);
	});
});

test("ticket runtime prepends managed agent bin tk when no external path is configured", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const managedBin = join(fixture.agent, "bin");
	mkdirSync(managedBin, { recursive: true });
	writeFakeTk(join(managedBin, "tk"), "managed-agent-bin");

	withPath("", () => {
		const command = activateTlhTicketRuntime({}, fixture.agent);

		assert.equal(command, join(managedBin, "tk"));
		assert.deepEqual(pathEntries(), [managedBin]);

		const result = spawnSync("tk", ["ready"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.match(result.stdout, /managed-agent-bin:ready/);
	});
});

test("ticket runtime ignores configured commands whose basename is not tk", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const externalTicket = join(fixture.external, "ticket");
	const sentinel = join(fixture.dir, "non-tk-called");
	writeFileSync(externalTicket, `#!/bin/sh
printf called > ${JSON.stringify(sentinel)}
echo "Usage: tk <command> [args]"
echo "ticket system"
exit 0
`);
	chmodSync(externalTicket, 0o755);

	withPath("", () => {
		const command = activateTlhTicketRuntime({ tlh: { tickets: { installPath: externalTicket } } }, fixture.agent);

		assert.equal(command, undefined);
		assert.equal(process.env.PATH, "");
		assert.equal(existsSync(sentinel), false);
	});
});
