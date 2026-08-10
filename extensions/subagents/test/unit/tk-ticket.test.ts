import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	detectTkTicketId,
	normalizeTkTicketMetadata,
	parseTkTicketTitle,
	resolveTkTicketMetadata,
	resolveTkTicketTaskContext,
	sanitizeTkTicketTitle,
} from "../../src/runs/shared/tk-ticket.ts";

describe("tk ticket helpers", () => {
	it("detects explicit tk show commands from delegated tasks", () => {
		assert.equal(detectTkTicketId("First run `tk show psr-raw4` and follow it."), "psr-raw4");
		assert.equal(detectTkTicketId("No ticket here."), undefined);
	});

	it("parses and sanitizes terminal-safe ticket titles without clipping", () => {
		assert.equal(parseTkTicketTitle("---\nid: psr-raw4\n---\n# Show active tk title\n"), "Show active tk title");
		assert.equal(sanitizeTkTicketTitle("\u001b[31mActive\u001b[0m\n\u0007\u009b ticket title"), "Active ticket title");
		assert.equal(sanitizeTkTicketTitle("x".repeat(100)), "x".repeat(100));
	});

	it("resolves exactly one ticketed task with its effective child cwd", () => {
		assert.deepEqual(
			resolveTkTicketTaskContext({
				runnerCwd: "/repo",
				tasks: [{ task: "Review the result." }, { task: "Run `tk show psr-raw4` first.", cwd: "nested" }],
			}),
			{ task: "Run `tk show psr-raw4` first.", cwd: "/repo/nested", taskIndex: 1 },
		);
		assert.equal(
			resolveTkTicketTaskContext({
				runnerCwd: "/repo",
				tasks: [{ task: "Run `tk show psr-raw4` first." }, { task: "Run `tk show psr-raw9` first." }],
			}),
			undefined,
		);
	});

	it("normalizes runtime tk ticket metadata", () => {
		assert.deepEqual(normalizeTkTicketMetadata({ id: "psr-raw4", title: "Unsafe\u009b title" }), {
			id: "psr-raw4",
			title: "Unsafe title",
		});
		assert.equal(normalizeTkTicketMetadata({ id: "bad id", title: "Unsafe title" }), undefined);
		assert.equal(normalizeTkTicketMetadata({ id: "psr-raw4", title: "\u009b\u0007" }), undefined);
	});

	it("resolves metadata from a TICKETS_DIR root relative to the task cwd", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tk-ticket-env-"));
		const originalTicketsDir = process.env.TICKETS_DIR;
		try {
			const taskCwd = path.join(root, "workspace", "child", "nested");
			const ticketsDir = path.join(taskCwd, "custom-tickets");
			fs.mkdirSync(ticketsDir, { recursive: true });
			fs.writeFileSync(
				path.join(ticketsDir, "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Show active tk title\n",
				"utf-8",
			);
			process.env.TICKETS_DIR = "./custom-tickets";
			assert.deepEqual(resolveTkTicketMetadata("Run `tk show psr-raw4` first.", { cwd: taskCwd }), {
				id: "psr-raw4",
				title: "Show active tk title",
			});
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers an exact ID filename over broader partial matches", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tk-ticket-exact-"));
		const originalTicketsDir = process.env.TICKETS_DIR;
		try {
			delete process.env.TICKETS_DIR;
			const taskCwd = path.join(root, "child", "nested");
			const ticketsDir = path.join(root, ".tickets");
			fs.mkdirSync(ticketsDir, { recursive: true });
			fs.mkdirSync(taskCwd, { recursive: true });
			fs.writeFileSync(path.join(ticketsDir, "psr-raw.md"), "---\nid: psr-raw\n---\n# Exact match title\n", "utf-8");
			fs.writeFileSync(
				path.join(ticketsDir, "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Partial match title\n",
				"utf-8",
			);
			assert.deepEqual(resolveTkTicketMetadata("Run `tk show psr-raw` first.", { cwd: taskCwd }), {
				id: "psr-raw",
				title: "Exact match title",
			});
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("supports unique partial ID matches and returns the canonical ticket ID", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tk-ticket-partial-"));
		const originalTicketsDir = process.env.TICKETS_DIR;
		try {
			delete process.env.TICKETS_DIR;
			const taskCwd = path.join(root, "child", "nested");
			const ticketsDir = path.join(root, ".tickets");
			fs.mkdirSync(ticketsDir, { recursive: true });
			fs.mkdirSync(taskCwd, { recursive: true });
			fs.writeFileSync(
				path.join(ticketsDir, "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Canonical partial title\n",
				"utf-8",
			);
			assert.deepEqual(resolveTkTicketMetadata("Run `tk show raw4` first.", { cwd: taskCwd }), {
				id: "psr-raw4",
				title: "Canonical partial title",
			});
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails open when a partial ticket ID is missing or ambiguous", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tk-ticket-ambiguous-"));
		const originalTicketsDir = process.env.TICKETS_DIR;
		try {
			delete process.env.TICKETS_DIR;
			const taskCwd = path.join(root, "child", "nested");
			const ticketsDir = path.join(root, ".tickets");
			fs.mkdirSync(ticketsDir, { recursive: true });
			fs.mkdirSync(taskCwd, { recursive: true });
			fs.writeFileSync(path.join(ticketsDir, "psr-raw4.md"), "---\nid: psr-raw4\n---\n# First title\n", "utf-8");
			fs.writeFileSync(path.join(ticketsDir, "psr-raw9.md"), "---\nid: psr-raw9\n---\n# Second title\n", "utf-8");
			assert.equal(resolveTkTicketMetadata("Run `tk show raw` first.", { cwd: taskCwd }), undefined);
			assert.equal(resolveTkTicketMetadata("Run `tk show missing` first.", { cwd: taskCwd }), undefined);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails open when local ticket discovery throws before reading metadata", () => {
		assert.equal(
			resolveTkTicketMetadata("Run `tk show psr-raw4` first.", {
				findTicketFile: () => {
					throw new Error("boom");
				},
			}),
			undefined,
		);
	});
});
