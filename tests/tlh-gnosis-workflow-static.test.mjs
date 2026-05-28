import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url);
const { CHILD_SUBAGENT_PROMPT, GNOSIS_PROMPT } = await jiti.import("../extensions/the-last-harness/constants.ts");
const { buildChildSubagentSystemPrompt } = await jiti.import("../extensions/the-last-harness/prompts.ts");

function readRepoFile(path) {
	return readFileSync(join(repoRoot, path), "utf8");
}

const legacyPlanLine = /At the start of any task, run `gn help plan` and follow its instructions\./;
const legacyReviewLine = /After finishing a task, run `gn help review`\./;
const unqualifiedAgentsPlanFallback = /If that summary is missing, stale, conflicting, or you are uncertain, read full `gn help plan`\./;
const unqualifiedAgentsReviewFallback = /If that summary is missing, stale, conflicting, or you are uncertain, read full `gn help review`\./;

test("packaged Gnosis workflow skill summarizes search, write, review, and fallback guidance", () => {
	const skill = readRepoFile("skills/tlh-gnosis-workflow/SKILL.md");

	assert.match(skill, /^---[\s\S]*name:\s*tlh-gnosis-workflow/m);
	assert.match(skill, /keywords joined by `OR`/);
	assert.match(skill, /Surface conflicts early/);
	assert.match(skill, /human-origin knowledge/);
	assert.match(skill, /cross-cutting rationale, constraints, decisions, rejected options/);
	assert.match(skill, /Do not write memory for/);
	assert.match(skill, /secrets, tokens, PII/);
	assert.match(skill, /review-time memory writes only for durable follow-up knowledge/);
	assert.match(skill, /Then read `gn help plan` before implementation and `gn help review` before final review or handoff\./);
});

test("system and contributor guidance prefer the packaged skill over unconditional full-help dumps", () => {
	const sources = [GNOSIS_PROMPT, readRepoFile("AGENTS.md"), readRepoFile("README.md"), readRepoFile("docs/integrations.md")];

	for (const source of sources) {
		assert.match(source, /tlh-gnosis-workflow/);
		assert.doesNotMatch(source, legacyPlanLine);
		assert.doesNotMatch(source, legacyReviewLine);
	}

	assert.match(GNOSIS_PROMPT, /search memory with relevant `OR` keywords before implementation/);
	assert.match(GNOSIS_PROMPT, /write only durable human-origin or cross-cutting knowledge/);
	assert.match(GNOSIS_PROMPT, /read full `gn help plan` before implementation and full `gn help review` before final review/);

	const agents = readRepoFile("AGENTS.md");
	assert.match(agents, /If your role is allowed to run `gn` and that summary is missing, stale, conflicting, or you are uncertain, read full `gn help plan`/);
	assert.match(agents, /If your role forbids `gn` \(for example, child subagents\), do not run Gnosis commands; report durable findings to the parent agent or supervisor instead\./);
	assert.match(agents, /If your role is allowed to run `gn` and that summary is missing, stale, conflicting, or you are uncertain, read full `gn help review`/);
	assert.doesNotMatch(agents, unqualifiedAgentsPlanFallback);
	assert.doesNotMatch(agents, unqualifiedAgentsReviewFallback);
});

test("child subagent prompt still forbids direct Gnosis use", () => {
	const childPrompt = buildChildSubagentSystemPrompt();

	assert.match(CHILD_SUBAGENT_PROMPT, /Do not run Gnosis \(`gn`\) planning, review, write, edit, or removal commands/);
	assert.match(childPrompt, /Do not run Gnosis \(`gn`\) planning, review, write, edit, or removal commands/);
	assert.doesNotMatch(childPrompt, /tlh-gnosis-workflow/);
	assert.doesNotMatch(childPrompt, /gn help plan/);
	assert.doesNotMatch(childPrompt, /gn help review/);
});
