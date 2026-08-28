import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  PACKAGED_MINOR_AGENT_ROLES,
  PACKAGED_PRIMARY_AGENT_ROLES,
  PROJECT_AGENT_GUIDANCE_MAX_BYTES,
  PROJECT_AGENT_GUIDANCE_ROLES,
  inventoryProjectAgentGuidance,
  isCanonicalPackagedMinorAgent,
  projectAgentGuidanceFilename,
  resolveProjectAgentGuidance,
  resolveProjectAgentGuidanceFromInventory,
  __testing,
  type ProjectAgentGuidanceDiagnostic,
} from "../../../shared/project-agent-guidance.ts";

type Fixture = {
  root: string;
  repo: string;
  cwd: string;
  agentDir: string;
};

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(options: { git?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-guidance-"));
  fixtures.push(root);
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "packages", "app");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  if (options.git !== false) {
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
  }
  return { root, repo, cwd, agentDir };
}

function writeGuidance(directory: string, role: string, content: string): string {
  const guidanceDirectory = path.join(directory, ".tlh", "agents", "builtin");
  fs.mkdirSync(guidanceDirectory, { recursive: true });
  const filename = projectAgentGuidanceFilename(role);
  assert.ok(filename, `expected packaged role filename for ${role}`);
  const filePath = path.join(guidanceDirectory, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeMinimalGitLayout(gitDirectory: string, head = "ref: refs/heads/main\n"): string {
  fs.mkdirSync(path.join(gitDirectory, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDirectory, "refs"), { recursive: true });
  fs.writeFileSync(path.join(gitDirectory, "HEAD"), head, "utf8");
  fs.writeFileSync(
    path.join(gitDirectory, "config"),
    "[core]\n\trepositoryformatversion = 0\n",
    "utf8",
  );
  return gitDirectory;
}

function writeMinimalGitDirectory(directory: string, head?: string): string {
  return writeMinimalGitLayout(path.join(directory, ".git"), head);
}

function persistTrust(agentDir: string, cwd: string, decision: boolean): void {
  new ProjectTrustStore(agentDir).set(cwd, decision);
}

const EXPECTED_ROLE_FILENAMES = [
  ["architect", "ARCHITECT_PROMPT_APPEND.md"],
  ["rush", "RUSH_PROMPT_APPEND.md"],
  ["product", "PRODUCT_PROMPT_APPEND.md"],
  ["bug-hunter", "BUG-HUNTER_PROMPT_APPEND.md"],
  ["developer", "DEVELOPER_PROMPT_APPEND.md"],
  ["code-reviewer", "CODE-REVIEWER_PROMPT_APPEND.md"],
  ["repo-scout", "REPO-SCOUT_PROMPT_APPEND.md"],
  ["diff-summarizer", "DIFF-SUMMARIZER_PROMPT_APPEND.md"],
  ["librarian", "LIBRARIAN_PROMPT_APPEND.md"],
  ["web-scout", "WEB-SCOUT_PROMPT_APPEND.md"],
  ["oracle", "ORACLE_PROMPT_APPEND.md"],
  ["contrarian", "CONTRARIAN_PROMPT_APPEND.md"],
] as const;

describe("project-agent-guidance", () => {
  it("returns non-throwing diagnostics for invalid cwd and agent-directory inputs", () => {
    assert.doesNotThrow(() => {
      const result = inventoryProjectAgentGuidance(undefined, "");
      assert.deepEqual(result.files, []);
      assert.deepEqual(
        result.diagnostics.map(({ code }) => code),
        ["invalid-cwd", "invalid-agent-dir"],
      );
      assert.equal(result.trust, "unavailable");
    });

    const invalidCwd = inventoryProjectAgentGuidance("", "/tmp/agent");
    assert.equal(invalidCwd.files.length, 0);
    assert.equal(invalidCwd.diagnostics[0]?.code, "invalid-cwd");

    const invalidAgentDir = inventoryProjectAgentGuidance("/tmp", undefined);
    assert.equal(invalidAgentDir.files.length, 0);
    assert.equal(invalidAgentDir.diagnostics[0]?.code, "invalid-agent-dir");
  });

  it("recognizes only exact installer-managed packaged minor-agent paths", () => {
    const fixture = makeFixture({ git: false });
    const canonicalPath = path.join(fixture.agentDir, "tlh", "agents", "subagents", "developer.md");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "developer", "utf8");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    try {
      assert.equal(
        isCanonicalPackagedMinorAgent({ name: "developer", filePath: canonicalPath }),
        true,
      );
      for (const filePath of [
        path.join(fixture.root, "user", "developer.md"),
        path.join(fixture.root, "project", "developer.md"),
        path.join(fixture.root, "package", "developer.md"),
        path.join(fixture.root, "extra", "developer.md"),
        path.join(fixture.agentDir, "tlh", "agents", "subagents", "developer.md.bak"),
      ]) {
        assert.equal(isCanonicalPackagedMinorAgent({ name: "developer", filePath }), false);
      }
      assert.equal(
        isCanonicalPackagedMinorAgent({
          name: "embedded.developer",
          filePath: canonicalPath,
        }),
        false,
      );
      assert.equal(isCanonicalPackagedMinorAgent({ name: "developer", filePath: "" }), false);
      assert.equal(isCanonicalPackagedMinorAgent(undefined), false);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("maps only packaged roles to exact uppercase filenames", () => {
    assert.deepEqual(
      [...PACKAGED_PRIMARY_AGENT_ROLES, ...PACKAGED_MINOR_AGENT_ROLES],
      [...PROJECT_AGENT_GUIDANCE_ROLES],
    );
    assert.deepEqual(
      EXPECTED_ROLE_FILENAMES.map(([role]) => role),
      [...PROJECT_AGENT_GUIDANCE_ROLES],
    );
    for (const [role, expectedFilename] of EXPECTED_ROLE_FILENAMES) {
      assert.equal(projectAgentGuidanceFilename(role), expectedFilename);
      assert.equal(expectedFilename.includes("/"), false);
    }
    assert.equal(projectAgentGuidanceFilename("embedded.oracle"), undefined);
    assert.equal(projectAgentGuidanceFilename("custom-agent"), undefined);
    assert.equal(projectAgentGuidanceFilename("ARCHITECT"), undefined);
    assert.equal(projectAgentGuidanceFilename(undefined), undefined);
  });

  it("ignores a prompt append placed directly under .tlh", () => {
    const fixture = makeFixture({ git: false });
    const guidanceRoot = path.join(fixture.cwd, ".tlh");
    fs.mkdirSync(guidanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(guidanceRoot, "ARCHITECT_PROMPT_APPEND.md"),
      "legacy location",
      "utf8",
    );
    persistTrust(fixture.agentDir, fixture.cwd, true);

    const inventory = inventoryProjectAgentGuidance(fixture.cwd, fixture.agentDir);
    assert.equal(inventory.trust, "not-evaluated");
    assert.deepEqual(inventory.files, []);
    assert.deepEqual(inventory.diagnostics, []);
    const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, undefined);
    assert.equal(result.sourcePath, undefined);
  });

  it("ignores unknown and embedded filenames, including lowercase role files", () => {
    const fixture = makeFixture();
    const guidanceDirectory = path.join(fixture.cwd, ".tlh", "agents", "builtin");
    fs.mkdirSync(guidanceDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixture.cwd, ".tlh", "ARCHITECT.md"), "legacy", "utf8");
    fs.writeFileSync(
      path.join(guidanceDirectory, "EMBEDDED.ORACLE_PROMPT_APPEND.md"),
      "ignore",
      "utf8",
    );
    fs.writeFileSync(path.join(guidanceDirectory, "architect_prompt_append.md"), "ignore", "utf8");
    fs.mkdirSync(path.join(guidanceDirectory, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(guidanceDirectory, "nested", "ARCHITECT_PROMPT_APPEND.md"),
      "ignore",
      "utf8",
    );
    persistTrust(fixture.agentDir, fixture.cwd, true);

    const inventory = inventoryProjectAgentGuidance(fixture.cwd, fixture.agentDir);
    assert.equal(inventory.trust, "not-evaluated");
    assert.deepEqual(inventory.files, []);
    assert.deepEqual(inventory.diagnostics, []);
    assert.equal(
      resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "embedded.oracle").guidance,
      undefined,
    );
  });

  it("uses the nearest matching role file through the enclosing Git worktree", () => {
    const fixture = makeFixture();
    const parentPath = writeGuidance(fixture.repo, "architect", "parent guidance");
    const nearestPath = writeGuidance(
      path.join(fixture.repo, "packages"),
      "architect",
      "nearest guidance",
    );
    persistTrust(fixture.agentDir, fixture.repo, true);

    const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, "nearest guidance");
    assert.equal(result.sourcePath, nearestPath);
    assert.notEqual(result.sourcePath, parentPath);
    assert.equal(result.inventory.worktreeRoot, fixture.repo);
    assert.deepEqual(result.inventory.diagnostics, []);
  });

  it("falls back to cwd-only inspection outside a Git worktree", () => {
    const fixture = makeFixture({ git: false });
    const outsidePath = writeGuidance(fixture.repo, "architect", "parent guidance");
    const cwdPath = writeGuidance(fixture.cwd, "architect", "cwd guidance");
    persistTrust(fixture.agentDir, fixture.cwd, true);

    const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, "cwd guidance");
    assert.equal(result.sourcePath, cwdPath);
    assert.notEqual(result.sourcePath, outsidePath);
    assert.equal(result.inventory.worktreeRoot, undefined);

    fs.rmSync(cwdPath);
    const noFallback = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(noFallback.guidance, undefined);
    assert.deepEqual(noFallback.inventory.files, []);
  });

  it("rejects malformed ordinary and linked-worktree .git markers", () => {
    const malformedFile = makeFixture({ git: false });
    writeGuidance(malformedFile.repo, "architect", "must remain outside the worktree");
    fs.writeFileSync(path.join(malformedFile.repo, ".git"), "not a gitdir marker\n", "utf8");
    persistTrust(malformedFile.agentDir, malformedFile.cwd, true);

    const malformedFileResult = resolveProjectAgentGuidance(
      malformedFile.cwd,
      malformedFile.agentDir,
      "architect",
    );
    assert.equal(malformedFileResult.guidance, undefined);
    assert.equal(malformedFileResult.inventory.worktreeRoot, undefined);
    assert.equal(malformedFileResult.inventory.trust, "not-evaluated");
    assert.deepEqual(malformedFileResult.inventory.files, []);

    const malformedDirectory = makeFixture({ git: false });
    writeGuidance(malformedDirectory.repo, "architect", "must remain outside the worktree");
    fs.mkdirSync(path.join(malformedDirectory.repo, ".git"));
    persistTrust(malformedDirectory.agentDir, malformedDirectory.cwd, true);

    const malformedDirectoryResult = resolveProjectAgentGuidance(
      malformedDirectory.cwd,
      malformedDirectory.agentDir,
      "architect",
    );
    assert.equal(malformedDirectoryResult.guidance, undefined);
    assert.equal(malformedDirectoryResult.inventory.worktreeRoot, undefined);
    assert.equal(malformedDirectoryResult.inventory.trust, "not-evaluated");
    assert.deepEqual(malformedDirectoryResult.inventory.files, []);
  });

  it("does not walk past a malformed nested .git marker to an outer worktree", () => {
    const fixture = makeFixture();
    const outerGuidancePath = writeGuidance(fixture.repo, "architect", "outer guidance");
    fs.writeFileSync(path.join(fixture.repo, "packages", ".git"), "not a gitdir marker\n", "utf8");
    persistTrust(fixture.agentDir, fixture.repo, true);

    const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, undefined);
    assert.equal(result.sourcePath, undefined);
    assert.equal(result.inventory.worktreeRoot, undefined);
    assert.equal(result.inventory.trust, "not-evaluated");
    assert.deepEqual(result.inventory.files, []);
    assert.notEqual(result.sourcePath, outerGuidancePath);
  });

  it("accepts syntactically valid symbolic and detached Git HEAD forms", () => {
    for (const head of ["ref: refs/heads/main\n", "0".repeat(40), "a".repeat(64)]) {
      const fixture = makeFixture({ git: false });
      writeMinimalGitDirectory(fixture.repo, head);
      writeGuidance(fixture.repo, "architect", "valid HEAD guidance");
      persistTrust(fixture.agentDir, fixture.repo, true);

      const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, "valid HEAD guidance");
      assert.equal(result.inventory.worktreeRoot, fixture.repo);
    }
  });

  it("rejects malformed HEAD lookalikes in ordinary, separate, and linked layouts", () => {
    const assertRejected = (
      fixture: Fixture,
      trustPath = fixture.repo,
      cwd = fixture.cwd,
    ): void => {
      persistTrust(fixture.agentDir, trustPath, true);
      const result = resolveProjectAgentGuidance(cwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, undefined);
      assert.equal(result.inventory.worktreeRoot, undefined);
      assert.equal(result.inventory.trust, "not-evaluated");
      assert.deepEqual(result.inventory.files, []);
    };

    const ordinary = makeFixture({ git: false });
    writeMinimalGitDirectory(ordinary.repo, "junk HEAD\n");
    writeGuidance(ordinary.repo, "architect", "ordinary lookalike");
    assertRejected(ordinary);

    const separate = makeFixture({ git: false });
    const separateGitDirectory = path.join(separate.root, "separate-git");
    writeMinimalGitLayout(separateGitDirectory, "ref: refs/\n");
    fs.writeFileSync(path.join(separate.repo, ".git"), `gitdir: ${separateGitDirectory}\n`, "utf8");
    writeGuidance(separate.repo, "architect", "separate lookalike");
    assertRejected(separate);

    const linked = makeFixture({ git: false });
    const commonGitDirectory = writeMinimalGitDirectory(linked.repo);
    const linkedRoot = path.join(linked.root, "linked-worktree");
    const linkedCwd = path.join(linkedRoot, "packages", "app");
    const adminDirectory = path.join(commonGitDirectory, "worktrees", "linked");
    fs.mkdirSync(linkedCwd, { recursive: true });
    fs.mkdirSync(adminDirectory, { recursive: true });
    fs.writeFileSync(path.join(adminDirectory, "HEAD"), "junk HEAD\n", "utf8");
    fs.writeFileSync(path.join(adminDirectory, "gitdir"), `${path.join(linkedRoot, ".git")}\n`);
    fs.writeFileSync(path.join(adminDirectory, "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(linkedRoot, ".git"), `gitdir: ${adminDirectory}\n`, "utf8");
    writeGuidance(linkedRoot, "architect", "linked lookalike");
    assertRejected(linked, linkedRoot, linkedCwd);
  });

  it("recognizes a valid linked-worktree .git marker without invoking Git", () => {
    const fixture = makeFixture({ git: false });
    const commonGitDirectory = writeMinimalGitDirectory(fixture.repo);
    const linkedRoot = path.join(fixture.root, "linked-worktree");
    const linkedCwd = path.join(linkedRoot, "packages", "app");
    const adminDirectory = path.join(commonGitDirectory, "worktrees", "linked");
    fs.mkdirSync(linkedCwd, { recursive: true });
    fs.mkdirSync(adminDirectory, { recursive: true });
    fs.writeFileSync(path.join(adminDirectory, "HEAD"), "ref: refs/heads/linked\n", "utf8");
    fs.writeFileSync(
      path.join(adminDirectory, "gitdir"),
      `${path.join(linkedRoot, ".git")}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(adminDirectory, "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(linkedRoot, ".git"), `gitdir: ${adminDirectory}\n`, "utf8");
    const guidancePath = writeGuidance(linkedRoot, "architect", "linked guidance");
    persistTrust(fixture.agentDir, linkedRoot, true);

    const result = resolveProjectAgentGuidance(linkedCwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, "linked guidance");
    assert.equal(result.sourcePath, guidancePath);
    assert.equal(result.inventory.worktreeRoot, linkedRoot);
  });

  it(
    "prefers the physical target worktree over a lexical host worktree for a symlinked cwd",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture({ git: false });
      const targetRepo = path.join(fixture.repo, "target");
      const targetCwd = path.join(targetRepo, "packages", "app");
      fs.mkdirSync(targetCwd, { recursive: true });
      writeMinimalGitDirectory(fixture.repo);
      writeMinimalGitDirectory(targetRepo);
      const hostGuidancePath = writeGuidance(fixture.repo, "architect", "lexical host guidance");
      const targetGuidancePath = writeGuidance(targetRepo, "architect", "physical target guidance");
      const symlinkedCwd = path.join(fixture.repo, "target-link");
      fs.symlinkSync(targetCwd, symlinkedCwd, "dir");
      persistTrust(fixture.agentDir, targetRepo, true);

      const result = resolveProjectAgentGuidance(symlinkedCwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, "physical target guidance");
      assert.equal(result.sourcePath, fs.realpathSync(targetGuidancePath));
      assert.notEqual(result.sourcePath, hostGuidancePath);
      assert.equal(result.inventory.cwd, path.resolve(symlinkedCwd));
      assert.equal(result.inventory.worktreeRoot, fs.realpathSync(targetRepo));
    },
  );

  it(
    "selects the nearest physical ancestor guidance for a same-worktree symlinked cwd",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture({ git: false });
      const targetDirectory = path.join(fixture.repo, "a", "b");
      const targetCwd = path.join(targetDirectory, "child");
      fs.mkdirSync(targetCwd, { recursive: true });
      writeMinimalGitDirectory(fixture.repo);
      const rootGuidancePath = writeGuidance(fixture.repo, "architect", "worktree root guidance");
      const nearerGuidancePath = writeGuidance(
        path.join(fixture.repo, "a"),
        "architect",
        "nearer physical guidance",
      );
      const symlinkedCwd = path.join(fixture.repo, "link", "child");
      fs.symlinkSync(targetDirectory, path.dirname(symlinkedCwd), "dir");
      persistTrust(fixture.agentDir, fixture.repo, true);

      const result = resolveProjectAgentGuidance(symlinkedCwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, "nearer physical guidance");
      assert.equal(result.sourcePath, fs.realpathSync(nearerGuidancePath));
      assert.notEqual(result.sourcePath, rootGuidancePath);
      assert.equal(result.inventory.cwd, path.resolve(symlinkedCwd));
      assert.equal(result.inventory.worktreeRoot, fs.realpathSync(fixture.repo));
    },
  );

  it(
    "keeps canonical trust containment for a symlinked cwd and nested target trust",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture({ git: false });
      const targetRepo = path.join(fixture.repo, "target");
      const trustedSubtree = path.join(targetRepo, "packages");
      const targetCwd = path.join(trustedSubtree, "app");
      fs.mkdirSync(targetCwd, { recursive: true });
      writeMinimalGitDirectory(fixture.repo);
      writeMinimalGitDirectory(targetRepo);
      const aboveTrustPath = writeGuidance(targetRepo, "architect", "above trusted subtree");
      const symlinkedCwd = path.join(fixture.repo, "target-link");
      fs.symlinkSync(targetCwd, symlinkedCwd, "dir");
      persistTrust(fixture.agentDir, trustedSubtree, true);

      const result = resolveProjectAgentGuidance(symlinkedCwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, undefined);
      assert.equal(result.sourcePath, undefined);
      assert.equal(result.inventory.cwd, path.resolve(symlinkedCwd));
      assert.equal(result.inventory.worktreeRoot, fs.realpathSync(targetRepo));
      assert.equal(result.inventory.trust, "trusted");
      assert.equal(result.inventory.trustEntryPath, fs.realpathSync(trustedSubtree));
      const canonicalAboveTrustPath = fs.realpathSync(aboveTrustPath);
      assert.deepEqual(result.inventory.files, [
        { role: "architect", path: canonicalAboveTrustPath },
      ]);
      const skipped = result.inventory.diagnostics.find(
        ({ code, path: diagnosticPath }) =>
          code === "source-outside-trusted-subtree" && diagnosticPath === canonicalAboveTrustPath,
      );
      assert.ok(skipped);
    },
  );

  it(
    "discovers a genuine enclosing worktree through a symlinked cwd",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture();
      const guidancePath = writeGuidance(fixture.repo, "architect", "symlinked cwd guidance");
      const symlinkedCwd = path.join(fixture.root, "cwd-link");
      fs.symlinkSync(fixture.cwd, symlinkedCwd, "dir");
      persistTrust(fixture.agentDir, fixture.repo, true);

      const result = resolveProjectAgentGuidance(symlinkedCwd, fixture.agentDir, "architect");
      assert.equal(result.guidance, "symlinked cwd guidance");
      assert.equal(result.inventory.cwd, path.resolve(symlinkedCwd));
      assert.equal(result.inventory.worktreeRoot, fs.realpathSync(fixture.repo));
      assert.equal(result.sourcePath, fs.realpathSync(guidancePath));
    },
  );

  it("inherits trusted worktree-root guidance for a deep cwd", () => {
    const fixture = makeFixture();
    const rootPath = writeGuidance(fixture.repo, "architect", "root guidance");
    persistTrust(fixture.agentDir, fixture.repo, true);

    const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
    assert.equal(result.guidance, "root guidance");
    assert.equal(result.sourcePath, rootPath);
    assert.equal(result.inventory.trust, "trusted");
    assert.equal(result.inventory.trustEntryPath, fs.realpathSync(fixture.repo));
  });

  it("does not let nested trust authorize an ancestor guidance source", () => {
    const fixture = makeFixture();
    const ancestorPath = writeGuidance(fixture.repo, "architect", "ancestor guidance");
    const nestedPath = writeGuidance(fixture.cwd, "oracle", "nested guidance");
    persistTrust(fixture.agentDir, fixture.repo, false);
    persistTrust(fixture.agentDir, fixture.cwd, true);

    const inventory = inventoryProjectAgentGuidance(fixture.cwd, fixture.agentDir);
    assert.equal(inventory.trust, "trusted");
    assert.equal(inventory.trustEntryPath, fs.realpathSync(fixture.cwd));
    assert.deepEqual(inventory.files, [
      { role: "architect", path: ancestorPath },
      { role: "oracle", path: nestedPath, content: "nested guidance" },
    ]);
    const skipped = inventory.diagnostics.find(
      ({ code, path: diagnosticPath }) =>
        code === "source-outside-trusted-subtree" && diagnosticPath === ancestorPath,
    );
    assert.ok(skipped);
    assert.match(skipped.message, /`\/trust`/);
    assert.match(skipped.message, /`\/reload` or restart/);
    assert.equal(
      resolveProjectAgentGuidanceFromInventory(inventory, "architect").guidance,
      undefined,
    );
  });

  it("requires persisted trust and distinguishes trusted, denied, and undecided", () => {
    const trusted = makeFixture();
    writeGuidance(trusted.cwd, "developer", "trusted guidance");
    persistTrust(trusted.agentDir, trusted.cwd, true);
    const trustedResult = resolveProjectAgentGuidance(trusted.cwd, trusted.agentDir, "developer");
    assert.equal(trustedResult.inventory.trust, "trusted");
    assert.equal(trustedResult.inventory.trustDecision, true);
    assert.equal(trustedResult.guidance, "trusted guidance");

    const denied = makeFixture();
    const deniedPath = writeGuidance(denied.cwd, "developer", "do not read");
    persistTrust(denied.agentDir, denied.cwd, false);
    const deniedResult = resolveProjectAgentGuidance(denied.cwd, denied.agentDir, "developer");
    assert.equal(deniedResult.inventory.trust, "denied");
    assert.equal(deniedResult.inventory.trustDecision, false);
    assert.equal(deniedResult.guidance, undefined);
    assert.deepEqual(deniedResult.inventory.files, [{ role: "developer", path: deniedPath }]);
    assert.equal(deniedResult.inventory.diagnostics.length, 1);
    assert.match(
      deniedResult.inventory.diagnostics[0]?.message ?? "",
      /persisted project trust is denied/,
    );
    assert.match(deniedResult.inventory.diagnostics[0]?.message ?? "", /`\/trust`/);
    assert.match(deniedResult.inventory.diagnostics[0]?.message ?? "", /`\/reload` or restart/);

    const undecided = makeFixture();
    const undecidedPath = writeGuidance(undecided.cwd, "developer", "await trust");
    const undecidedResult = resolveProjectAgentGuidance(
      undecided.cwd,
      undecided.agentDir,
      "developer",
    );
    assert.equal(undecidedResult.inventory.trust, "undecided");
    assert.equal(undecidedResult.inventory.trustDecision, null);
    assert.equal(undecidedResult.guidance, undefined);
    assert.deepEqual(undecidedResult.inventory.files, [{ role: "developer", path: undecidedPath }]);
    assert.equal(undecidedResult.inventory.diagnostics.length, 1);
    assert.match(
      undecidedResult.inventory.diagnostics[0]?.message ?? "",
      /no persisted project trust/,
    );
  });

  it("ignores missing and whitespace-only guidance files", () => {
    const missing = makeFixture();
    persistTrust(missing.agentDir, missing.cwd, true);
    const missingResult = resolveProjectAgentGuidance(missing.cwd, missing.agentDir, "oracle");
    assert.equal(missingResult.guidance, undefined);
    assert.equal(missingResult.inventory.trust, "not-evaluated");
    assert.deepEqual(missingResult.inventory.files, []);
    assert.deepEqual(missingResult.inventory.diagnostics, []);

    const whitespace = makeFixture();
    const fartherPath = writeGuidance(whitespace.repo, "oracle", "farther guidance");
    const nearestPath = writeGuidance(whitespace.cwd, "oracle", " \n\t\r\n ");
    persistTrust(whitespace.agentDir, whitespace.repo, true);
    const whitespaceResult = resolveProjectAgentGuidance(
      whitespace.cwd,
      whitespace.agentDir,
      "oracle",
    );
    assert.equal(whitespaceResult.guidance, undefined);
    assert.equal(whitespaceResult.inventory.trust, "trusted");
    assert.deepEqual(whitespaceResult.inventory.files, []);
    assert.deepEqual(whitespaceResult.inventory.diagnostics, []);
    assert.notEqual(whitespaceResult.sourcePath, nearestPath);
    assert.notEqual(whitespaceResult.sourcePath, fartherPath);
  });

  it("rejects symlinked .tlh directories and files", { skip: process.platform === "win32" }, () => {
    const directoryLink = makeFixture();
    const realDirectory = path.join(directoryLink.root, "real-tlh");
    fs.mkdirSync(realDirectory, { recursive: true });
    writeGuidance(realDirectory, "architect", "outside directory");
    fs.symlinkSync(realDirectory, path.join(directoryLink.cwd, ".tlh"), "dir");
    persistTrust(directoryLink.agentDir, directoryLink.cwd, true);
    const directoryResult = resolveProjectAgentGuidance(
      directoryLink.cwd,
      directoryLink.agentDir,
      "architect",
    );
    assert.equal(directoryResult.guidance, undefined);
    assert.equal(directoryResult.inventory.files.length, 0);
    assert.equal(directoryResult.inventory.diagnostics.length, 1);
    assert.equal(directoryResult.inventory.diagnostics[0]?.code, "symlink-directory");
    assert.equal(
      directoryResult.inventory.diagnostics[0]?.path,
      path.join(directoryLink.cwd, ".tlh"),
    );
    assert.match(directoryResult.inventory.diagnostics[0]?.message ?? "", /\.tlh.*symlink/);

    const fileLink = makeFixture();
    const target = path.join(fileLink.root, "ARCHITECT_PROMPT_APPEND.md");
    fs.writeFileSync(target, "outside file", "utf8");
    const guidanceDirectory = path.join(fileLink.cwd, ".tlh", "agents", "builtin");
    fs.mkdirSync(guidanceDirectory, { recursive: true });
    fs.symlinkSync(target, path.join(guidanceDirectory, "ARCHITECT_PROMPT_APPEND.md"));
    persistTrust(fileLink.agentDir, fileLink.cwd, true);
    const fileResult = resolveProjectAgentGuidance(fileLink.cwd, fileLink.agentDir, "architect");
    assert.equal(fileResult.guidance, undefined);
    assert.equal(fileResult.inventory.diagnostics.length, 1);
    assert.equal(fileResult.inventory.diagnostics[0]?.code, "symlink-file");
    assert.match(fileResult.inventory.diagnostics[0]?.message ?? "", /symlink/);
  });

  it(
    "rejects symlinked agents and builtin intermediate directories",
    { skip: process.platform === "win32" },
    () => {
      for (const intermediate of ["agents", "builtin"] as const) {
        const fixture = makeFixture();
        writeGuidance(fixture.cwd, "architect", "must not load");
        const externalRoot = path.join(fixture.root, `external-${intermediate}`);
        const externalPath = writeGuidance(externalRoot, "architect", "external guidance");
        const intermediatePath =
          intermediate === "agents"
            ? path.dirname(path.dirname(externalPath))
            : path.dirname(externalPath);
        const replacedPath =
          intermediate === "agents"
            ? path.join(fixture.cwd, ".tlh", "agents")
            : path.join(fixture.cwd, ".tlh", "agents", "builtin");
        fs.rmSync(replacedPath, { recursive: true, force: true });
        fs.symlinkSync(intermediatePath, replacedPath, "dir");
        persistTrust(fixture.agentDir, fixture.cwd, true);

        const result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
        assert.equal(result.guidance, undefined);
        assert.equal(result.sourcePath, undefined);
        assert.deepEqual(result.inventory.files, []);
        assert.equal(result.inventory.diagnostics.length, 1);
        assert.equal(result.inventory.diagnostics[0]?.code, "symlink-directory");
        assert.equal(result.inventory.diagnostics[0]?.path, replacedPath);
      }
    },
  );

  it(
    "fails closed when each intermediate directory changes identity before open",
    {
      skip: typeof fs.constants.O_NOFOLLOW !== "number" || fs.constants.O_NOFOLLOW === 0,
    },
    () => {
      for (const component of [".tlh", "agents", "builtin"] as const) {
        const fixture = makeFixture({ git: false });
        const guidancePath = writeGuidance(fixture.cwd, "architect", "original guidance");
        const externalRoot = path.join(
          fixture.root,
          `external-${component === ".tlh" ? "tlh" : component}`,
        );
        writeGuidance(externalRoot, "architect", "external guidance");
        const componentPath =
          component === ".tlh"
            ? path.join(fixture.cwd, ".tlh")
            : component === "agents"
              ? path.join(fixture.cwd, ".tlh", "agents")
              : path.join(fixture.cwd, ".tlh", "agents", "builtin");
        const externalComponentPath =
          component === ".tlh"
            ? path.join(externalRoot, ".tlh")
            : component === "agents"
              ? path.join(externalRoot, ".tlh", "agents")
              : path.join(externalRoot, ".tlh", "agents", "builtin");
        const displacedPath = path.join(
          fixture.root,
          `original-${component === ".tlh" ? "tlh" : component}`,
        );
        persistTrust(fixture.agentDir, fixture.cwd, true);

        const mutableFs = fsDefault as typeof fsDefault & {
          openSync: typeof fsDefault.openSync;
        };
        const originalOpenSync = mutableFs.openSync;
        let swapped = false;
        mutableFs.openSync = (filePath, flags, mode) => {
          if (!swapped && String(filePath) === guidancePath) {
            fs.renameSync(componentPath, displacedPath);
            fs.renameSync(externalComponentPath, componentPath);
            swapped = true;
          }
          return mode === undefined
            ? originalOpenSync(filePath, flags)
            : originalOpenSync(filePath, flags, mode);
        };
        syncBuiltinESMExports();

        let result: ReturnType<typeof resolveProjectAgentGuidance>;
        try {
          result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
        } finally {
          mutableFs.openSync = originalOpenSync;
          syncBuiltinESMExports();
          if (swapped) {
            fs.renameSync(componentPath, externalComponentPath);
            fs.renameSync(displacedPath, componentPath);
          }
        }

        assert.equal(result.guidance, undefined);
        assert.equal(result.sourcePath, undefined);
        assert.equal(result.inventory.files.length, 0);
        assert.equal(result.inventory.diagnostics.length, 1);
        assert.equal(result.inventory.diagnostics[0]?.code, "file-read-failed");
        assert.equal(result.inventory.diagnostics[0]?.path, guidancePath);
        assert.match(
          result.inventory.diagnostics[0]?.message ?? "",
          /directory changed while the file was being opened/,
        );
      }
    },
  );

  it("fails closed when O_NOFOLLOW is unavailable", () => {
    for (const noFollowFlag of [0, undefined]) {
      const fixture = makeFixture({ git: false });
      const guidancePath = writeGuidance(fixture.cwd, "architect", "must not read");
      const diagnostics: ProjectAgentGuidanceDiagnostic[] = [];
      const result = __testing.readGuidanceFileCore(
        { role: "architect", path: guidancePath },
        fixture.cwd,
        diagnostics,
        noFollowFlag,
      );
      assert.equal(result, undefined);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, "file-read-failed");
      assert.match(diagnostics[0]?.message ?? "", /O_NOFOLLOW.*unavailable/);
    }
  });

  it(
    "fails closed when the opened directory identity cannot be proven",
    {
      skip: typeof fs.constants.O_NOFOLLOW !== "number" || fs.constants.O_NOFOLLOW === 0,
    },
    () => {
      const fixture = makeFixture({ git: false });
      const guidancePath = writeGuidance(fixture.cwd, "architect", "must not read");
      const diagnostics: ProjectAgentGuidanceDiagnostic[] = [];
      const result = __testing.readGuidanceFileCore(
        { role: "architect", path: guidancePath },
        fixture.cwd,
        diagnostics,
        fs.constants.O_NOFOLLOW,
      );
      assert.equal(result, undefined);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, "file-read-failed");
      assert.match(diagnostics[0]?.message ?? "", /directory identity.*proven/i);
    },
  );

  it(
    "treats inode zero as unavailable identity",
    {
      skip: typeof fs.constants.O_NOFOLLOW !== "number" || fs.constants.O_NOFOLLOW === 0,
    },
    () => {
      const fixture = makeFixture({ git: false });
      const guidancePath = writeGuidance(fixture.cwd, "architect", "must not read");
      const guidanceDirectory = path.dirname(guidancePath);
      persistTrust(fixture.agentDir, fixture.cwd, true);

      const mutableFs = fsDefault as typeof fsDefault & {
        lstatSync: typeof fsDefault.lstatSync;
      };
      const originalLstatSync = mutableFs.lstatSync;
      let directoryInspections = 0;
      mutableFs.lstatSync = ((filePath: fsDefault.PathLike) => {
        const stat = originalLstatSync(filePath);
        if (String(filePath) === guidanceDirectory && directoryInspections++ > 0) {
          stat.ino = 0;
        }
        return stat;
      }) as typeof originalLstatSync;
      syncBuiltinESMExports();

      let result: ReturnType<typeof resolveProjectAgentGuidance>;
      try {
        result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
      } finally {
        mutableFs.lstatSync = originalLstatSync;
        syncBuiltinESMExports();
      }

      assert.equal(result.guidance, undefined);
      assert.equal(result.sourcePath, undefined);
      assert.equal(result.inventory.files.length, 0);
      assert.equal(result.inventory.diagnostics.length, 1);
      assert.equal(result.inventory.diagnostics[0]?.code, "file-read-failed");
      assert.match(result.inventory.diagnostics[0]?.message ?? "", /directory identity.*proven/i);
    },
  );

  it(
    "fails closed when the builtin guidance directory changes to a symlink before open",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture({ git: false });
      const guidancePath = writeGuidance(fixture.cwd, "architect", "original guidance");
      const guidanceDirectory = path.dirname(guidancePath);
      const externalDirectory = path.join(fixture.root, "external-tlh");
      writeGuidance(externalDirectory, "architect", "external guidance");
      const displacedDirectory = path.join(fixture.root, "original-tlh");
      persistTrust(fixture.agentDir, fixture.cwd, true);

      const mutableFs = fsDefault as typeof fsDefault & {
        openSync: typeof fsDefault.openSync;
      };
      const originalOpenSync = mutableFs.openSync;
      let swapped = false;
      mutableFs.openSync = (filePath, flags, mode) => {
        if (!swapped && String(filePath) === guidancePath) {
          fs.renameSync(guidanceDirectory, displacedDirectory);
          fs.symlinkSync(
            path.join(externalDirectory, ".tlh", "agents", "builtin"),
            guidanceDirectory,
            "dir",
          );
          swapped = true;
        }
        return mode === undefined
          ? originalOpenSync(filePath, flags)
          : originalOpenSync(filePath, flags, mode);
      };
      syncBuiltinESMExports();

      let result: ReturnType<typeof resolveProjectAgentGuidance>;
      try {
        result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
      } finally {
        mutableFs.openSync = originalOpenSync;
        syncBuiltinESMExports();
        if (swapped) {
          fs.unlinkSync(guidanceDirectory);
          fs.renameSync(displacedDirectory, guidanceDirectory);
        }
      }

      assert.equal(result.guidance, undefined);
      assert.equal(result.sourcePath, undefined);
      assert.equal(result.inventory.files.length, 0);
      assert.equal(result.inventory.diagnostics.length, 1);
      assert.equal(result.inventory.diagnostics[0]?.code, "symlink-directory");
      assert.match(result.inventory.diagnostics[0]?.message ?? "", /became a symlink/);
    },
  );

  it(
    "fails closed when the .tlh or agents directory changes to a symlink before open",
    { skip: process.platform === "win32" },
    () => {
      for (const component of [".tlh", "agents"] as const) {
        const fixture = makeFixture({ git: false });
        const guidancePath = writeGuidance(fixture.cwd, "architect", "original guidance");
        const componentPath =
          component === ".tlh"
            ? path.join(fixture.cwd, ".tlh")
            : path.join(fixture.cwd, ".tlh", "agents");
        const externalRoot = path.join(fixture.root, `external-${component.slice(1)}`);
        writeGuidance(externalRoot, "architect", "external guidance");
        const externalComponentPath =
          component === ".tlh"
            ? path.join(externalRoot, ".tlh")
            : path.join(externalRoot, ".tlh", "agents");
        const displacedPath = path.join(fixture.root, `original-${component.slice(1)}`);
        persistTrust(fixture.agentDir, fixture.cwd, true);

        const mutableFs = fsDefault as typeof fsDefault & {
          openSync: typeof fsDefault.openSync;
        };
        const originalOpenSync = mutableFs.openSync;
        let swapped = false;
        mutableFs.openSync = (filePath, flags, mode) => {
          if (!swapped && String(filePath) === guidancePath) {
            fs.renameSync(componentPath, displacedPath);
            fs.symlinkSync(externalComponentPath, componentPath, "dir");
            swapped = true;
          }
          return mode === undefined
            ? originalOpenSync(filePath, flags)
            : originalOpenSync(filePath, flags, mode);
        };
        syncBuiltinESMExports();

        let result: ReturnType<typeof resolveProjectAgentGuidance>;
        try {
          result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
        } finally {
          mutableFs.openSync = originalOpenSync;
          syncBuiltinESMExports();
          if (swapped) {
            fs.unlinkSync(componentPath);
            fs.renameSync(displacedPath, componentPath);
          }
        }

        assert.equal(result.guidance, undefined);
        assert.equal(result.sourcePath, undefined);
        assert.equal(result.inventory.files.length, 0);
        assert.equal(result.inventory.diagnostics.length, 1);
        assert.equal(result.inventory.diagnostics[0]?.code, "symlink-directory");
        assert.equal(result.inventory.diagnostics[0]?.path, componentPath);
      }
    },
  );

  it(
    "fails closed when the opened guidance file is replaced before identity checks",
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture({ git: false });
      const guidancePath = writeGuidance(fixture.cwd, "architect", "original guidance");
      const displacedPath = path.join(fixture.root, "original-ARCHITECT_PROMPT_APPEND.md");
      persistTrust(fixture.agentDir, fixture.cwd, true);

      const mutableFs = fsDefault as typeof fsDefault & {
        openSync: typeof fsDefault.openSync;
      };
      const originalOpenSync = mutableFs.openSync;
      let swapped = false;
      mutableFs.openSync = (filePath, flags, mode) => {
        const descriptor =
          mode === undefined
            ? originalOpenSync(filePath, flags)
            : originalOpenSync(filePath, flags, mode);
        if (!swapped && String(filePath) === guidancePath) {
          fs.renameSync(guidancePath, displacedPath);
          fs.writeFileSync(guidancePath, "replacement guidance", "utf8");
          swapped = true;
        }
        return descriptor;
      };
      syncBuiltinESMExports();

      let result: ReturnType<typeof resolveProjectAgentGuidance>;
      try {
        result = resolveProjectAgentGuidance(fixture.cwd, fixture.agentDir, "architect");
      } finally {
        mutableFs.openSync = originalOpenSync;
        syncBuiltinESMExports();
        if (swapped) {
          fs.unlinkSync(guidancePath);
          fs.renameSync(displacedPath, guidancePath);
        }
      }

      assert.equal(result.guidance, undefined);
      assert.equal(result.sourcePath, undefined);
      assert.equal(result.inventory.files.length, 0);
      assert.equal(result.inventory.diagnostics.length, 1);
      assert.equal(result.inventory.diagnostics[0]?.code, "file-read-failed");
      assert.match(result.inventory.diagnostics[0]?.message ?? "", /no longer matches/);
    },
  );

  it("rejects non-regular and oversized files with actionable diagnostics", () => {
    const nonRegular = makeFixture();
    const guidanceDirectory = path.join(nonRegular.cwd, ".tlh", "agents", "builtin");
    fs.mkdirSync(path.join(guidanceDirectory, "ARCHITECT_PROMPT_APPEND.md"), { recursive: true });
    persistTrust(nonRegular.agentDir, nonRegular.cwd, true);
    const nonRegularResult = resolveProjectAgentGuidance(
      nonRegular.cwd,
      nonRegular.agentDir,
      "architect",
    );
    assert.equal(nonRegularResult.guidance, undefined);
    assert.equal(nonRegularResult.inventory.diagnostics[0]?.code, "non-regular-file");
    assert.match(nonRegularResult.inventory.diagnostics[0]?.message ?? "", /regular file/);

    const oversized = makeFixture();
    writeGuidance(oversized.cwd, "architect", "x".repeat(PROJECT_AGENT_GUIDANCE_MAX_BYTES + 1));
    persistTrust(oversized.agentDir, oversized.cwd, true);
    const oversizedResult = resolveProjectAgentGuidance(
      oversized.cwd,
      oversized.agentDir,
      "architect",
    );
    assert.equal(oversizedResult.guidance, undefined);
    assert.equal(oversizedResult.inventory.diagnostics[0]?.code, "file-too-large");
    assert.match(oversizedResult.inventory.diagnostics[0]?.message ?? "", /64 KiB/);

    const invalidNearest = makeFixture();
    const invalidNearestDirectory = path.join(invalidNearest.cwd, ".tlh", "agents", "builtin");
    fs.mkdirSync(path.join(invalidNearestDirectory, "ARCHITECT_PROMPT_APPEND.md"), {
      recursive: true,
    });
    const fartherValidPath = writeGuidance(invalidNearest.repo, "architect", "farther guidance");
    persistTrust(invalidNearest.agentDir, invalidNearest.repo, true);
    const invalidNearestResult = resolveProjectAgentGuidance(
      invalidNearest.cwd,
      invalidNearest.agentDir,
      "architect",
    );
    assert.equal(invalidNearestResult.guidance, undefined);
    assert.equal(invalidNearestResult.sourcePath, undefined);
    assert.equal(invalidNearestResult.inventory.trust, "not-evaluated");
    assert.equal(invalidNearestResult.inventory.diagnostics[0]?.code, "non-regular-file");
    assert.equal(
      invalidNearestResult.inventory.diagnostics[0]?.path,
      path.join(invalidNearestDirectory, "ARCHITECT_PROMPT_APPEND.md"),
    );
    assert.notEqual(invalidNearestResult.sourcePath, fartherValidPath);
  });

  it("accepts exactly 64 KiB and reports malformed trust stores without throwing", () => {
    const boundary = makeFixture();
    const content = "x".repeat(PROJECT_AGENT_GUIDANCE_MAX_BYTES);
    writeGuidance(boundary.cwd, "architect", content);
    persistTrust(boundary.agentDir, boundary.cwd, true);
    const boundaryResult = resolveProjectAgentGuidance(
      boundary.cwd,
      boundary.agentDir,
      "architect",
    );
    assert.equal(boundaryResult.guidance, content);
    assert.equal(boundaryResult.guidance?.length, PROJECT_AGENT_GUIDANCE_MAX_BYTES);

    const malformed = makeFixture();
    writeGuidance(malformed.cwd, "architect", "must not load");
    fs.writeFileSync(path.join(malformed.agentDir, "trust.json"), "{not json", "utf8");
    assert.doesNotThrow(() => {
      const result = resolveProjectAgentGuidance(malformed.cwd, malformed.agentDir, "architect");
      assert.equal(result.guidance, undefined);
      assert.equal(result.inventory.trust, "unavailable");
      assert.equal(result.inventory.diagnostics.length, 1);
      assert.equal(result.inventory.diagnostics[0]?.code, "trust-inspection-failed");
      assert.match(result.inventory.diagnostics[0]?.message ?? "", /trust|guidance/i);
    });
  });

  it("resolves roles from one inventory without another filesystem read", () => {
    const fixture = makeFixture();
    const architectPath = writeGuidance(fixture.cwd, "architect", "architect guidance");
    writeGuidance(fixture.cwd, "oracle", "oracle guidance");
    persistTrust(fixture.agentDir, fixture.cwd, true);
    const inventory = inventoryProjectAgentGuidance(fixture.cwd, fixture.agentDir);
    fs.writeFileSync(architectPath, "changed after snapshot", "utf8");

    const result = resolveProjectAgentGuidanceFromInventory(inventory, "architect");
    assert.equal(result.guidance, "architect guidance");
    assert.equal(result.sourcePath, architectPath);
    assert.equal(
      resolveProjectAgentGuidanceFromInventory(inventory, "unknown").guidance,
      undefined,
    );
  });
});
