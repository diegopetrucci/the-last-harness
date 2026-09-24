import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  injectTicketBody,
  normalizeTicketId,
  readTicketBody,
} from "../../src/runs/shared/ticket-context.ts";

function withTemporaryTk(
  output: string,
  callback: (cwd: string) => void,
  options: { exitCode?: number } = {},
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-ticket-context-"));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "workspace", "child");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "tk"),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${options.exitCode ?? 0});\n`,
    "utf8",
  );
  fs.chmodSync(path.join(bin, "tk"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    callback(cwd);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("explicit ticket context", () => {
  it("normalizes safe IDs and rejects unsafe values", () => {
    assert.deepEqual(normalizeTicketId("  tlhm-o1qg  "), { ticketId: "tlhm-o1qg" });
    assert.deepEqual(normalizeTicketId(undefined), {});
    assert.equal(normalizeTicketId(42).error, "ticket must be a string.");
    assert.equal(normalizeTicketId(" ").error, "ticket must not be empty.");
    const acceptedLength = "a".repeat(128);
    assert.deepEqual(normalizeTicketId(acceptedLength), { ticketId: acceptedLength });
    const rejectedLength = "a".repeat(129);
    assert.equal(normalizeTicketId(rejectedLength).error, "ticket must be at most 128 characters.");
    assert.equal(
      normalizeTicketId("bad/id").error,
      "ticket must be a safe ticket ID containing only letters, numbers, and hyphens.",
    );
    assert.equal(normalizeTicketId("bad\n id").error, "ticket contains control characters.");
  });

  it("loads the exact ticket body through argv in the requested cwd", () => {
    const body = "---\nid: tlhm-o1qg\n---\n# Exact body\n\nKeep this verbatim.\n";
    withTemporaryTk(body, (cwd) => {
      const result = readTicketBody(" tlhm-o1qg ", cwd);
      assert.deepEqual(result, { ticketId: "tlhm-o1qg", body });
    });
  });

  it("fails before launch when the ticket command reports a missing ticket", () => {
    withTemporaryTk(
      "ticket not found\n",
      (cwd) => {
        const result = readTicketBody("tlhm-missing", cwd);
        assert.equal(result.ticketId, "tlhm-missing");
        assert.match(result.error ?? "", /tlhm-missing/);
        assert.match(result.error ?? "", /exit code 1/);
        assert.doesNotMatch(result.error ?? "", /ticket not found/);
      },
      { exitCode: 1 },
    );
  });

  it("reports missing and non-directory task cwds before tk lookup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-ticket-cwd-"));
    const missingCwd = path.join(root, "missing");
    const fileCwd = path.join(root, "file");
    fs.writeFileSync(fileCwd, "not a directory", "utf8");
    try {
      const missing = readTicketBody("tlhm-missing", missingCwd);
      assert.match(missing.error ?? "", /task cwd does not exist/);
      assert.doesNotMatch(missing.error ?? "", /tk command is unavailable/);

      const file = readTicketBody("tlhm-file", fileCwd);
      assert.match(file.error ?? "", /task cwd is not a directory/);
      assert.doesNotMatch(file.error ?? "", /tk command is unavailable/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unavailable tk command without copying stderr", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-ticket-no-tk-"));
    const cwd = path.join(root, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const result = readTicketBody("tlhm-missing", cwd);
      assert.match(result.error ?? "", /tk command is unavailable/);
      assert.doesNotMatch(result.error ?? "", /stderr/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects the body verbatim under the ticket heading", () => {
    const body = "# Exact body\n\nA trailing line.\n";
    assert.equal(
      injectTicketBody("Review the change.", "tlhm-o1qg", body),
      `Review the change.\n\n## Ticket tlhm-o1qg\n${body}`,
    );
  });
});
