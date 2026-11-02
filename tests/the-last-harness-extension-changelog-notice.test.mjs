import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installTlhExtensionChangelogNoticeOverride } = await jiti.import(
  "../extensions/the-last-harness/extension-changelog-notice.ts",
);

const proto = InteractiveMode.prototype;
const MARKER = Symbol.for("tlh.extensionChangelogNoticePatched");

// Canary: run before patching; fails if Pi renames/removes the private method.
test("upstream drift canary: getExtensionChangelogUpdates exists before patching", () => {
  assert.equal(typeof proto.getExtensionChangelogUpdates, "function");
});

test("override returns [] without touching settings, and is idempotent", () => {
  installTlhExtensionChangelogNoticeOverride();
  const patched = proto.getExtensionChangelogUpdates;
  installTlhExtensionChangelogNoticeOverride();
  assert.equal(proto.getExtensionChangelogUpdates, patched);

  let writes = 0;
  const target = {
    settingsManager: {
      setExtensionChangelogVersion() {
        writes += 1;
      },
    },
  };
  assert.deepEqual(patched.call(target), []);
  assert.equal(writes, 0);
});

test("missing method warns and does not throw", () => {
  const original = proto.getExtensionChangelogUpdates;
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    delete proto[MARKER];
    proto.getExtensionChangelogUpdates = undefined;
    assert.doesNotThrow(() => installTlhExtensionChangelogNoticeOverride());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /getExtensionChangelogUpdates/);
    assert.equal(proto[MARKER], undefined);
  } finally {
    console.warn = warn;
    proto.getExtensionChangelogUpdates = original;
    proto[MARKER] = true;
  }
});
