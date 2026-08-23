import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUNDLED_DEVELOPER_AGENT_NAME,
	normalizeTkTicketMetadata,
	parseTkTicketTitle,
	resolveDispatchTkTicketMetadata,
	resolveExplicitTkTicketMetadata,
	sanitizeTkTicketTitle,
} from "../../src/runs/shared/tk-ticket.ts";

describe("tk ticket helpers", () => {
	it("parses and sanitizes terminal-safe ticket titles without clipping", () => {
		assert.equal(parseTkTicketTitle("---\nid: psr-raw4\n---\n# Show active tk title\n"), "Show active tk title");
		assert.equal(sanitizeTkTicketTitle("\u001b[31mActive\u001b[0m\n\u0007\u009b ticket title"), "Active ticket title");
		assert.equal(sanitizeTkTicketTitle("x".repeat(100)), "x".repeat(100));
	});

	it("requires explicit tickets only for the marked TLH developer dispatch", () => {
		assert.equal(BUNDLED_DEVELOPER_AGENT_NAME, "developer");
		assert.match(
			resolveDispatchTkTicketMetadata({ name: "developer", tkTicketRequired: true }, undefined).error ?? "",
			/requires.*explicit ticket/i,
		);
		assert.equal(resolveDispatchTkTicketMetadata({ name: "developer" }, undefined).error, undefined);
		assert.equal(
			resolveDispatchTkTicketMetadata({ name: "developer", tkTicketRequired: false }, undefined).error,
			undefined,
		);
		assert.match(
			resolveDispatchTkTicketMetadata({ name: "reviewer", tkTicketRequired: true }, "psr-raw4").error ?? "",
			/only supported.*TLH developer/i,
		);
		assert.deepEqual(
			resolveDispatchTkTicketMetadata({ name: "developer", tkTicketRequired: true }, "psr-raw4", {
				cwd: "/repo",
				findTicketFile: () => ({ id: "psr-raw4", path: "/repo/.tickets/psr-raw4.md" }),
				readFileSync: () => "---\nid: psr-raw4\n---\n# Explicit ticket title\n",
			}),
			{ metadata: { id: "psr-raw4", title: "Explicit ticket title" } },
		);
	});

	it("resolves explicit ticket IDs and rejects invalid or missing tickets", () => {
		assert.deepEqual(
			resolveExplicitTkTicketMetadata("psr-raw4", {
				cwd: "/repo",
				findTicketFile: () => ({ id: "psr-raw4", path: "/repo/.tickets/psr-raw4.md" }),
				readFileSync: () => "---\nid: psr-raw4\n---\n# Explicit ticket title\n",
			}),
			{ metadata: { id: "psr-raw4", title: "Explicit ticket title" } },
		);
		assert.match(
			resolveExplicitTkTicketMetadata("missing", { cwd: "/repo", findTicketFile: () => undefined }).error ?? "",
			/not found/,
		);
		assert.match(resolveExplicitTkTicketMetadata("bad/id", { cwd: "/repo" }).error ?? "", /only letters/);
		assert.match(resolveExplicitTkTicketMetadata("", { cwd: "/repo" }).error ?? "", /non-empty/);
	});

	it("normalizes runtime tk ticket metadata", () => {
		assert.deepEqual(normalizeTkTicketMetadata({ id: "psr-raw4", title: "Unsafe\u009b title" }), {
			id: "psr-raw4",
			title: "Unsafe title",
		});
		assert.equal(normalizeTkTicketMetadata({ id: "bad id", title: "Unsafe title" }), undefined);
		assert.equal(normalizeTkTicketMetadata({ id: "psr-raw4", title: "\u009b\u0007" }), undefined);
	});
});
