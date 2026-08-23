import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    assert.equal(
      parseTkTicketTitle("---\nid: psr-raw4\n---\n# Show active tk title\n"),
      "Show active tk title",
    );
    assert.equal(
      sanitizeTkTicketTitle("\u001b[31mActive\u001b[0m\n\u0007\u009b ticket title"),
      "Active ticket title",
    );
    assert.equal(sanitizeTkTicketTitle("x".repeat(100)), "x".repeat(100));
  });

  it("requires explicit tickets only for the marked TLH developer dispatch", () => {
    assert.equal(BUNDLED_DEVELOPER_AGENT_NAME, "developer");
    assert.match(
      resolveDispatchTkTicketMetadata({ name: "developer", tkTicketRequired: true }, undefined)
        .error ?? "",
      /requires.*explicit ticket/i,
    );
    assert.equal(
      resolveDispatchTkTicketMetadata({ name: "developer" }, undefined).error,
      undefined,
    );
    assert.equal(
      resolveDispatchTkTicketMetadata({ name: "developer", tkTicketRequired: false }, undefined)
        .error,
      undefined,
    );
    assert.match(
      resolveDispatchTkTicketMetadata({ name: "reviewer", tkTicketRequired: true }, "psr-raw4")
        .error ?? "",
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
      resolveExplicitTkTicketMetadata("missing", { cwd: "/repo", findTicketFile: () => undefined })
        .error ?? "",
      /not found/,
    );
    assert.match(
      resolveExplicitTkTicketMetadata("bad/id", { cwd: "/repo" }).error ?? "",
      /only letters/,
    );
    assert.match(resolveExplicitTkTicketMetadata("", { cwd: "/repo" }).error ?? "", /non-empty/);
  });

  it("resolves metadata from a relative TICKETS_DIR rooted at the task cwd", () => {
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
      assert.deepEqual(resolveExplicitTkTicketMetadata("psr-raw4", { cwd: taskCwd }), {
        metadata: { id: "psr-raw4", title: "Show active tk title" },
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
      fs.writeFileSync(
        path.join(ticketsDir, "psr-raw.md"),
        "---\nid: psr-raw\n---\n# Exact match title\n",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(ticketsDir, "psr-raw4.md"),
        "---\nid: psr-raw4\n---\n# Partial match title\n",
        "utf-8",
      );
      assert.deepEqual(resolveExplicitTkTicketMetadata("psr-raw", { cwd: taskCwd }), {
        metadata: { id: "psr-raw", title: "Exact match title" },
      });
    } finally {
      if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
      else process.env.TICKETS_DIR = originalTicketsDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports a unique partial ID match and returns the canonical ticket ID", () => {
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
      assert.deepEqual(resolveExplicitTkTicketMetadata("raw4", { cwd: taskCwd }), {
        metadata: { id: "psr-raw4", title: "Canonical partial title" },
      });
    } finally {
      if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
      else process.env.TICKETS_DIR = originalTicketsDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing and ambiguous partial ticket IDs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tk-ticket-ambiguous-"));
    const originalTicketsDir = process.env.TICKETS_DIR;
    try {
      delete process.env.TICKETS_DIR;
      const taskCwd = path.join(root, "child", "nested");
      const ticketsDir = path.join(root, ".tickets");
      fs.mkdirSync(ticketsDir, { recursive: true });
      fs.mkdirSync(taskCwd, { recursive: true });
      fs.writeFileSync(
        path.join(ticketsDir, "psr-raw4.md"),
        "---\nid: psr-raw4\n---\n# First title\n",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(ticketsDir, "psr-raw9.md"),
        "---\nid: psr-raw9\n---\n# Second title\n",
        "utf-8",
      );
      assert.match(
        resolveExplicitTkTicketMetadata("raw", { cwd: taskCwd }).error ?? "",
        /not found/,
      );
      assert.match(
        resolveExplicitTkTicketMetadata("missing", { cwd: taskCwd }).error ?? "",
        /not found/,
      );
    } finally {
      if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
      else process.env.TICKETS_DIR = originalTicketsDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
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
