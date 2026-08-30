import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TLH_STARTUP_TIPS, getTlhStartupTip, selectTlhStartupTip } = await jiti.import(
  "../extensions/the-last-harness/startup-tip.ts",
);

test("selectTlhStartupTip chooses from the curated TLH startup tip list", () => {
  assert.ok(TLH_STARTUP_TIPS.length > 0, "expected at least one curated TLH startup tip");
  assert.equal(
    selectTlhStartupTip(() => 0),
    TLH_STARTUP_TIPS[0],
  );
  assert.equal(
    selectTlhStartupTip(() => 0.999999),
    TLH_STARTUP_TIPS.at(-1),
  );
});

test("the curated startup tips explain pi-transcribe setup and microphone usage", () => {
  assert.ok(
    TLH_STARTUP_TIPS.some((tip) => tip.includes("/transcribe") && tip.includes("Ctrl+Alt+Z")),
    "expected a pi-transcribe setup tip with its default shortcut",
  );
});

test("the curated startup tips include exactly one disabled-mode affordance", () => {
  const disabledModeTip =
    "Use “disabled” mode (Shift+Tab) to keep TLH’s tools and subagents without architect-specific guidance.";

  assert.equal(
    TLH_STARTUP_TIPS.filter((tip) => tip === disabledModeTip).length,
    1,
    "expected exactly one approved disabled-mode startup tip",
  );
});

test("the curated startup list preserves one custom-agent and defaults tip", () => {
  const projectTips = TLH_STARTUP_TIPS.filter((tip) => tip.includes(".tlh/agents"));
  assert.deepEqual(projectTips, [
    "Project custom subagents live in .tlh/agents/custom/<UPPERCASE-SLUG>.md; ask TLH to use one by name.",
  ]);
  const defaultsTip =
    "Pin model or effort defaults per role for a project using .tlh/defaults.json at the repository root.";
  assert.deepEqual(
    TLH_STARTUP_TIPS.filter((tip) => tip === defaultsTip),
    [defaultsTip],
  );
  assert.equal(
    TLH_STARTUP_TIPS.some((tip) => /trust|\/reload|\/reconcile/i.test(tip)),
    false,
    "the curated startup list must not add trust, reload, or reconciliation reminders",
  );
});

test("getTlhStartupTip returns one process-scoped selection from the curated list", () => {
  const startupTip = getTlhStartupTip();

  assert.ok(startupTip, "expected a TLH startup tip to be selected at module startup");
  assert.ok(
    TLH_STARTUP_TIPS.includes(startupTip),
    "expected the startup tip to come from the curated TLH list",
  );
  assert.equal(getTlhStartupTip(), startupTip);
});
