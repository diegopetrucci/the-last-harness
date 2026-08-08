import test from "node:test";
import { assert, join, mkdirSync, runTickets, tempFixture, writeFileSync } from "./test-helpers.mjs";

test("runTickets ignores inherited PI_CODING_AGENT_DIR and TLH_* environment", () => {
	const fixture = tempFixture();
	const defaultAgent = join(fixture.home, ".the-last-harness", "agent");
	const inheritedPiAgent = join(fixture.dir, "inherited-pi-agent");
	const inheritedTlhAgent = join(fixture.dir, "inherited-tlh-agent");
	for (const agentDir of [defaultAgent, inheritedPiAgent, inheritedTlhAgent]) {
		mkdirSync(agentDir, { recursive: true });
	}
	writeFileSync(join(defaultAgent, "settings.json"), `${JSON.stringify({ tlh: { tickets: { enabled: true } } })}\n`);
	writeFileSync(
		join(inheritedPiAgent, "settings.json"),
		`${JSON.stringify({ tlh: { tickets: { enabled: false } } })}\n`,
	);
	writeFileSync(
		join(inheritedTlhAgent, "settings.json"),
		`${JSON.stringify({ tlh: { tickets: { enabled: false } } })}\n`,
	);

	const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTlhAgentDir = process.env.TLH_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = inheritedPiAgent;
		process.env.TLH_AGENT_DIR = inheritedTlhAgent;

		const result = runTickets(["status"], { env: { HOME: fixture.home } });

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /setting: enabled/);
	} finally {
		if (previousPiAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
		}
		if (previousTlhAgentDir === undefined) {
			delete process.env.TLH_AGENT_DIR;
		} else {
			process.env.TLH_AGENT_DIR = previousTlhAgentDir;
		}
	}
});
