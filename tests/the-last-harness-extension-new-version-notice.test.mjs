import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installTlhNewVersionNotificationOverride } = await jiti.import(
	"../extensions/the-last-harness/new-version-notice.ts",
);

// Canary: this test must run BEFORE the no-op test to check the real unpatched prototype.
// If this test fails, a Pi version bump has renamed or removed showNewVersionNotification.
// The fail-open patch in new-version-notice.ts would then silently stop working,
// letting the upstream "Update Available — Run `pi update`" banner reappear for TLH users.
test("TLH upstream drift canary: InteractiveMode.prototype.showNewVersionNotification exists and is a function before patching", () => {
	assert.equal(
		typeof InteractiveMode.prototype.showNewVersionNotification,
		"function",
		"InteractiveMode.prototype.showNewVersionNotification must be a function — " +
			"if this fails, Pi has renamed or removed the method and the fail-open patch will silently stop suppressing the banner",
	);
});

test("TLH new-version notice override is installed as a no-op and produces no banner output", () => {
	installTlhNewVersionNotificationOverride();

	const children = [];
	let renderRequests = 0;
	const target = {
		chatContainer: {
			addChild(child) {
				children.push(child);
			},
		},
		ui: {
			requestRender() {
				renderRequests += 1;
			},
		},
	};

	// Invoke the patched method; it must silently do nothing regardless of arguments.
	InteractiveMode.prototype.showNewVersionNotification.call(target, "99.0.0");

	assert.equal(children.length, 0, "expected no banner UI children after calling the no-op override");
	assert.equal(renderRequests, 0, "expected no render requests after calling the no-op override");
});
