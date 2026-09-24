import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  claimResultArtifact,
  type ResultArtifactFs,
} from "../../src/runs/background/result-artifact-consumer.ts";

function realFs(): ResultArtifactFs {
  return {
    existsSync: fs.existsSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
  };
}

function withErrorCode(message: string, code: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function spawnClaimWorker(
  artifactPath: string,
  barrierDir: string,
  id: string,
): Promise<{ status: number | null; stderr: string }> {
  const moduleUrl = pathToFileURL(
    path.resolve("extensions/subagents/src/runs/background/result-artifact-consumer.js"),
  ).href;
  const script = `
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { claimResultArtifact } from ${JSON.stringify(moduleUrl)};
    const artifact = process.env.TLH_CLAIM_ARTIFACT;
    const barrier = process.env.TLH_CLAIM_BARRIER;
    const id = process.env.TLH_CLAIM_ID;
    const claim = claimResultArtifact(artifact);
    fs.writeFileSync(path.join(barrier, id + ".ready"), claim ? "claimed" : "skipped");
    if (!claim) process.exit(0);
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(barrier).filter((entry) => entry.endsWith(".ready")).length < 2) {
      if (Date.now() >= deadline) process.exit(2);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fs.writeFileSync(path.join(barrier, id + ".out"), "claimed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    claim.release();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        TLH_CLAIM_ARTIFACT: artifactPath,
        TLH_CLAIM_BARRIER: barrierDir,
        TLH_CLAIM_ID: id,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr }));
  });
}

describe("result artifact claims", () => {
  it("uses O_EXCL across separate processes so only one owner enters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-claim-process-"));
    const barrierDir = path.join(root, "barrier");
    const artifactPath = path.join(root, "result.json");
    fs.mkdirSync(barrierDir);
    fs.writeFileSync(artifactPath, "{}", "utf8");
    try {
      const results = await Promise.all([
        spawnClaimWorker(artifactPath, barrierDir, "first"),
        spawnClaimWorker(artifactPath, barrierDir, "second"),
      ]);
      assert.deepEqual(
        results.map((result) => result.status),
        [0, 0],
        results.map((result) => result.stderr).join("\n"),
      );
      const outcomes = fs
        .readdirSync(barrierDir)
        .filter((entry) => entry.endsWith(".ready"))
        .map((entry) => fs.readFileSync(path.join(barrierDir, entry), "utf8"));
      assert.deepEqual(outcomes.sort(), ["claimed", "skipped"]);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), false);
      assert.equal(fs.existsSync(artifactPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a private sidecar with restrictive permissions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-claim-mode-"));
    const artifactPath = path.join(root, "result.json");
    fs.writeFileSync(artifactPath, "{}", "utf8");
    try {
      const claim = claimResultArtifact(artifactPath);
      assert.ok(claim);
      assert.equal(fs.statSync(`${artifactPath}.claim`).mode & 0o777, 0o600);
      assert.equal(claim.release(), true);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces non-EEXIST claim errors instead of treating them as already owned", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-claim-errors-"));
    const artifactPath = path.join(root, "result.json");
    fs.writeFileSync(artifactPath, "{}", "utf8");
    const injected = realFs();
    injected.openSync = () => {
      throw withErrorCode("permission denied", "EACCES");
    };
    try {
      assert.throws(
        () => claimResultArtifact(artifactPath, injected),
        /Could not claim result artifact .*permission denied/,
      );
      assert.equal(fs.existsSync(`${artifactPath}.claim`), false);
      assert.equal(fs.existsSync(artifactPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a release claim for retry when sidecar cleanup fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-claim-release-"));
    const artifactPath = path.join(root, "result.json");
    fs.writeFileSync(artifactPath, "{}", "utf8");
    const injected = realFs();
    let failCleanup = true;
    const unlink = injected.unlinkSync;
    injected.unlinkSync = (filePath) => {
      if (failCleanup && String(filePath) === `${artifactPath}.claim`) {
        failCleanup = false;
        throw withErrorCode("sidecar unavailable", "EACCES");
      }
      return unlink(filePath);
    };
    try {
      const claim = claimResultArtifact(artifactPath, injected);
      assert.ok(claim);
      assert.throws(() => claim.release(), /Could not remove claim sidecar/);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), true);
      assert.equal(claim.release(), true);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a committed sidecar until artifact cleanup succeeds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-claim-commit-"));
    const artifactPath = path.join(root, "result.json");
    fs.writeFileSync(artifactPath, "{}", "utf8");
    try {
      const claim = claimResultArtifact(artifactPath);
      assert.ok(claim);
      assert.equal(claim.commit(), false);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), true);
      fs.unlinkSync(artifactPath);
      assert.equal(claim.commit(), true);
      assert.equal(fs.existsSync(`${artifactPath}.claim`), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
