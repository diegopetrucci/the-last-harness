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
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/diff-review")), "expected a /diff-review startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/annotate-last-message")), "expected an /annotate-last-message startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/context")), "expected a /context startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/usage")), "expected a /usage startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/switch-primary-agent")), "expected a primary-agent switching startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("Shift+Tab")), "expected a primary-agent cycling startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("Ctrl+Shift+E")), "expected a TLH header toggle startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/tree")), "expected a /tree startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/name")), "expected a /name startup tip");
	assert.ok(TLH_STARTUP_TIPS.some((tip) => tip.includes("/reload")), "expected a /reload startup tip");

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
	assert.equal(TLH_STARTUP_TIPS.some((tip) => tip.includes("footer data")), false, "expected startup tips to avoid awkward footer-data phrasing");
});
