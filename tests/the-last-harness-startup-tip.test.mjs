import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TLH_STARTUP_TIPS, getTlhStartupTip, selectTlhStartupTip } = await jiti.import(
	"../extensions/the-last-harness/startup-tip.ts",
);

test("selectTlhStartupTip chooses from the curated TLH startup tip list", () => {
	assert.ok(TLH_STARTUP_TIPS.length > 0, "expected at least one curated TLH startup tip");
	assert.equal(selectTlhStartupTip(() => 0), TLH_STARTUP_TIPS[0]);
	assert.equal(selectTlhStartupTip(() => 0.999999), TLH_STARTUP_TIPS.at(-1));
});

test("getTlhStartupTip returns one process-scoped selection from the curated list", () => {
	const startupTip = getTlhStartupTip();

	assert.ok(startupTip, "expected a TLH startup tip to be selected at module startup");
	assert.ok(TLH_STARTUP_TIPS.includes(startupTip), "expected the startup tip to come from the curated TLH list");
	assert.equal(getTlhStartupTip(), startupTip);
});

test("TLH startup tips cover key TLH affordances with concise user-facing phrasing", () => {
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/review")), "expected a /review startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/annotate-git-diff")), "expected an /annotate-git-diff startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/annotate-last-message")), "expected an /annotate-last-message startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/context")), "expected a /context startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/usage")), "expected a /usage startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("Shift+Tab")), "expected a primary-agent cycling startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/fork")), "expected a /fork startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/tree")), "expected a /tree startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/name")), "expected a /name startup tip");

	const rushTip = TLH_STARTUP_TIPS.find((tip) => tip.includes("Rush"));
	assert.ok(rushTip, "expected a Rush primary-agent startup tip");
	assert.match(rushTip, /Shift\+Tab/u, "expected the Rush startup tip to mention Shift+Tab");
	assert.match(rushTip, /small bounded task/u, "expected the Rush startup tip to frame Rush for small bounded tasks");

	const productTip = TLH_STARTUP_TIPS.find((tip) => tip.includes("product"));
	assert.ok(productTip, "expected a product primary-agent startup tip");
	assert.match(productTip, /Shift\+Tab/u, "expected the product startup tip to mention Shift+Tab");
	assert.match(productTip, /framing, tradeoffs, or implementation-ready ticket shaping/u, "expected the product startup tip to frame product work");

	const bugHunterTip = TLH_STARTUP_TIPS.find((tip) => tip.includes("bug-hunter"));
	assert.ok(bugHunterTip, "expected a bug-hunter primary-agent startup tip");
	assert.match(bugHunterTip, /Shift\+Tab/u, "expected the bug-hunter startup tip to mention Shift+Tab");
	assert.match(bugHunterTip, /read-only debugging and root-cause analysis/u, "expected the bug-hunter startup tip to frame read-only debugging");

	const shellTip = TLH_STARTUP_TIPS.find((tip) => tip.includes("!") && tip.includes("!!"));
	assert.ok(shellTip, "expected a !/!! shell-command startup tip");
	assert.match(shellTip, /!/u, "expected the shell-command startup tip to mention !");
	assert.match(shellTip, /!!/u, "expected the shell-command startup tip to mention !!");
	assert.match(
		shellTip,
		/without adding the output to the model context/u,
		"expected the !! shell-command startup tip to explain that output stays out of model context",
	);

	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/tlh-changelog")), "expected a /tlh-changelog startup tip");
	assert.ok(
		TLH_STARTUP_TIPS.includes("Run `tlh doctor` in your terminal to check if your tlh installation is healthy"),
		"expected the exact tlh doctor startup tip wording",
	);
	assert.ok(
		TLH_STARTUP_TIPS.includes(
			"Run /analyse-tlh-sessions to review recent tlh sessions for recurring issues (note: it's an expensive check!)",
		),
		"expected the exact /analyse-tlh-sessions startup tip wording",
	);
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("oracle")), "expected an oracle startup tip");
	assert.equal(TLH_STARTUP_TIPS.some((tip) => tip.includes("footer data")), false, "expected startup tips to avoid awkward footer-data phrasing");

	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/tokens")), "expected a /tokens startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("contrarian")), "expected a contrarian startup tip");
	const webSearchTip = TLH_STARTUP_TIPS.find((tip) => /search the web/i.test(tip));
	assert.ok(webSearchTip, "expected a web search startup tip");
	assert.match(webSearchTip, /just ask/i, "expected the web search startup tip to keep concise ask-based wording");

	assert.ok(
		TLH_STARTUP_TIPS.some((tip) => tip.includes("ci-failure-investigation")),
		"expected a ci-failure-investigation startup tip",
	);

	const prCiTip = TLH_STARTUP_TIPS.find((tip) => /PR/i.test(tip) && /CI/i.test(tip));
	assert.ok(prCiTip, "expected a PR CI monitoring startup tip");
	assert.match(prCiTip, /monitor/i, "expected the PR CI startup tip to mention monitoring");
	assert.match(prCiTip, /report/i, "expected the PR CI startup tip to mention reporting");
	assert.match(prCiTip, /fail/i, "expected the PR CI startup tip to mention failures");
});
