import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installTlhPackageUpdateNotificationOverride } = await jiti.import(
	"../extensions/the-last-harness/package-update-notice.ts",
);

function findTextComponent(children) {
	return children.find((child) => child instanceof Text || child?.constructor?.name === "Text");
}

test("TLH package-update startup notice directs users to tlh update --extensions and preserves packages", () => {
	installTlhPackageUpdateNotificationOverride();

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

	InteractiveMode.prototype.showPackageUpdateNotification.call(target, [
		"npm:@acme/first-extension",
		"git:github.com/acme/second-extension",
	]);

	const text = findTextComponent(children);
	assert.ok(text, "expected a text component in the startup notice");
	assert.equal(renderRequests, 1);
	assert.match(text.text, /TLH extension updates are available\. Run `tlh update --extensions` to update them\./);
	assert.match(text.text, / - npm:@acme\/first-extension/);
	assert.match(text.text, / - git:github\.com\/acme\/second-extension/);
	assert.doesNotMatch(text.text, /Packages:/);
	assert.doesNotMatch(text.text, /TLH Extension\/Package Updates Available/);
	assert.doesNotMatch(text.text, /pi update/);
});
