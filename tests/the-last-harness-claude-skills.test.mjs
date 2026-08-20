/**
 * Tests for extensions/the-last-harness/claude-skills.ts
 *
 * Covers:
 *  - absent dirs produce no paths
 *  - untrusted project omits project roots
 *  - ancestor walk bounded by git root
 *  - dedupe of user/project overlap
 *  - disabled flag short-circuits
 *  - same-name collision: agentDir skill wins over .claude skill via loadSkills first-wins contract
 *  - defensive trust check: ctx without isProjectTrusted does not throw
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadSkills } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerClaudeSkillsDiscovery } = await jiti.import(
  "../extensions/the-last-harness/claude-skills.ts",
);

// ─── helpers ─────────────────────────────────────────────────────────────────

function createPiHarness() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
  };
}

function createResourcesDiscoverEvent(cwd) {
  return { type: "resources_discover", cwd, reason: "startup" };
}

function createCtx({ isProjectTrusted = true } = {}) {
  return {
    isProjectTrusted: () => isProjectTrusted,
  };
}

/**
 * Drive the resources_discover handler registered by registerClaudeSkillsDiscovery.
 * Returns the handler's result (or undefined when handler returns undefined).
 */
async function runDiscovery(pi, cwd, ctxOptions = {}) {
  const handlers = pi.handlers.get("resources_discover") ?? [];
  assert.equal(handlers.length, 1, "expected exactly one resources_discover handler");
  const event = createResourcesDiscoverEvent(cwd);
  const ctx = createCtx(ctxOptions);
  return handlers[0](event, ctx);
}

// ─── absent dirs produce no paths ────────────────────────────────────────────

test("returns undefined when .claude/skills is a regular file, not a directory", async (t) => {
  // appendIfNew must reject a regular file at the candidate path so the runtime
  // does not emit a "skill path is not a markdown file" diagnostic. This pins
  // that statSync().isDirectory() is used rather than existsSync().
  const fixture = createIsolatedProfileFixture("tlh-cs-file-not-dir-", { cwd: true, test: t });
  const userClaudeParent = join(fixture.home, ".claude");
  mkdirSync(userClaudeParent, { recursive: true });
  // Place a regular file where the skills directory would be.
  writeFileSync(join(userClaudeParent, "skills"), "not a directory");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: false });
    assert.equal(
      result,
      undefined,
      "a regular file at ~/.claude/skills must not be surfaced as a skill path",
    );
  });
});

test("returns undefined when no .claude/skills directories exist", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-absent-", { cwd: true, test: t });
  // home has no .claude/skills; workspace has no .claude/skills

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd);
    assert.equal(result, undefined);
  });
});

// ─── user root returned when it exists ───────────────────────────────────────

test("returns user root when ~/.claude/skills exists", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-userroot-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: false });
    assert.ok(result, "result should not be undefined");
    assert.deepEqual(result.skillPaths, [userSkills]);
  });
});

// ─── untrusted project omits project roots ────────────────────────────────────

test("omits project roots when isProjectTrusted() returns false", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-untrusted-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  const projectSkills = join(fixture.cwd, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: false });
    assert.ok(result, "result should not be undefined");
    assert.ok(result.skillPaths.includes(userSkills), "user root should be included");
    assert.ok(
      !result.skillPaths.includes(projectSkills),
      "project root should be excluded when untrusted",
    );
  });
});

// ─── project roots included when trusted ─────────────────────────────────────

test("includes project root when isProjectTrusted() returns true", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-trusted-", { cwd: true, test: t });
  const projectSkills = join(fixture.cwd, ".claude", "skills");
  mkdirSync(projectSkills, { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: true });
    assert.ok(result, "result should not be undefined");
    assert.ok(
      result.skillPaths.includes(projectSkills),
      "project root should be included when trusted",
    );
  });
});

// ─── ancestor walk bounded by git root ───────────────────────────────────────

test("ancestor walk stops at the git root and does not include directories above it", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-gitroot-", { test: t });

  // Layout:
  //   fixture.dir/
  //     repo/           <- git root (.git present)
  //       project/      <- cwd (the working directory inside the repo)
  //         .claude/skills   <- should be included
  //       .claude/skills     <- should be included (at git root level)
  //     .claude/skills       <- above git root — should NOT be included

  const repo = join(fixture.dir, "repo");
  const projectCwd = join(repo, "project");
  const aboveRepoSkills = join(fixture.dir, ".claude", "skills");
  const repoSkills = join(repo, ".claude", "skills");
  const projectSkills = join(projectCwd, ".claude", "skills");

  mkdirSync(join(repo, ".git"), { recursive: true }); // mark git root
  mkdirSync(aboveRepoSkills, { recursive: true });
  mkdirSync(repoSkills, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, projectCwd, { isProjectTrusted: true });
    assert.ok(result, "result should not be undefined");
    assert.ok(
      result.skillPaths.includes(projectSkills),
      "project-level .claude/skills should be included",
    );
    assert.ok(
      result.skillPaths.includes(repoSkills),
      "git-root-level .claude/skills should be included",
    );
    assert.ok(
      !result.skillPaths.includes(aboveRepoSkills),
      ".claude/skills above the git root should NOT be included",
    );
  });
});

// ─── dedupe of user/project overlap ──────────────────────────────────────────

test("deduplicates when user root and a project dir resolve to the same path", async (t) => {
  // Simulate the user root being the same real directory as the cwd's .claude/skills
  // by symlinking the project .claude/skills → the user .claude/skills.
  const { symlinkSync } = await import("node:fs");

  const fixture = createIsolatedProfileFixture("tlh-cs-dedupe-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });

  // Create parent dir for the symlink.
  const projectClaudeDir = join(fixture.cwd, ".claude");
  mkdirSync(projectClaudeDir, { recursive: true });
  // Symlink project's .claude/skills → user root (same real path)
  symlinkSync(userSkills, join(projectClaudeDir, "skills"));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: true });
    assert.ok(result, "result should not be undefined");
    // Should contain the user root exactly once (project symlink is deduplicated).
    assert.equal(
      result.skillPaths.filter((p) => p === userSkills).length,
      1,
      "user root should appear exactly once",
    );
    assert.equal(
      result.skillPaths.length,
      1,
      "should contain exactly one path after deduplication",
    );
  });
});

// ─── defensive trust check ──────────────────────────────────────────────────────

test("does not throw and omits project roots when ctx has no isProjectTrusted method", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-notrust-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  const projectSkills = join(fixture.cwd, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);

    // ctx deliberately has no isProjectTrusted method — simulates an older runtime.
    const handler = (pi.handlers.get("resources_discover") ?? [])[0];
    assert.ok(handler, "handler must be registered");
    const event = createResourcesDiscoverEvent(fixture.cwd);
    const ctx = {}; // no isProjectTrusted

    let result;
    assert.doesNotThrow(() => {
      result = handler(event, ctx);
    });
    result = await result;

    assert.ok(result, "should still return user root");
    assert.ok(result.skillPaths.includes(userSkills), "user root should be present");
    assert.ok(
      !result.skillPaths.includes(projectSkills),
      "project root should be omitted when trust method is absent",
    );
  });
});

// ─── disabled flag short-circuits ────────────────────────────────────────────

test("returns undefined when tlh.claudeSkills.disabled is true", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-disabled-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });

  // Write settings with the disabled flag.
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ tlh: { claudeSkills: { disabled: true } } }, null, 2)}\n`,
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd);
    assert.equal(result, undefined, "handler should be suppressed when disabled");
  });
});

test("is active when tlh.claudeSkills.disabled is false", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-enabled-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });

  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ tlh: { claudeSkills: { disabled: false } } }, null, 2)}\n`,
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: false });
    assert.ok(result, "result should not be undefined when disabled=false");
    assert.ok(result.skillPaths.includes(userSkills));
  });
});

// ─── same-name collision: non-.claude skill wins via upstream first-wins order ─

test("same-name skill in agentDir wins over same-name skill in .claude/skills via loadSkills first-wins", async (t) => {
  // Upstream loadSkills keeps the first registration per skill name.
  // Defaults (agentDir/skills) are loaded before skillPaths (from resources_discover),
  // so a skill in agentDir/skills beats a same-named .claude/skills skill.
  // This test pins that contract so any upstream change to merge order would be caught.
  //
  // COVERAGE NOTE (tlhm-ul8m item 3):
  // This test calls loadSkills({ includeDefaults: true, skillPaths }) directly,
  // mirroring the loadSkills side of the runtime merge. It does NOT exercise the
  // DefaultResourceLoader.extendResources() path, which is where the runtime
  // actually merges extension-discovered skillPaths via DefaultResourceLoader.mergePaths
  // (see dist/core/resource-loader.js). A regression that prepended extension paths
  // inside extendResources rather than appending them would not be caught here.
  // Driving DefaultResourceLoader in a unit test is impractical because its
  // constructor requires settingsManager and packageManager; this test is therefore
  // the practical approximation.
  const SKILL_NAME = "shared-skill";
  const fixture = createIsolatedProfileFixture("tlh-cs-collision-", { cwd: true, test: t });

  // Non-.claude skill: in the agent's bundled skills directory (loaded as a default).
  const agentSkillDir = join(fixture.agent, "skills", SKILL_NAME);
  mkdirSync(agentSkillDir, { recursive: true });
  writeFileSync(
    join(agentSkillDir, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: agent bundled skill\n---\nAgent content.\n`,
  );

  // .claude skill: in the user home, surfaced via the handler's skillPaths.
  const userSkills = join(fixture.home, ".claude", "skills");
  const claudeSkillDir = join(userSkills, SKILL_NAME);
  mkdirSync(claudeSkillDir, { recursive: true });
  writeFileSync(
    join(claudeSkillDir, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: .claude skill\n---\nClaude content.\n`,
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Obtain skillPaths from the handler (mirrors what the runtime does at startup).
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const discoveryResult = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: false });
    assert.ok(discoveryResult, "handler should return paths when user root exists");
    assert.ok(discoveryResult.skillPaths.includes(userSkills), "user root should be in skillPaths");

    // Call loadSkills exactly as the runtime would: defaults first, then extension paths.
    const { skills, diagnostics } = loadSkills({
      cwd: fixture.cwd,
      agentDir: fixture.agent,
      skillPaths: discoveryResult.skillPaths,
      includeDefaults: true,
    });

    const winner = skills.find((s) => s.name === SKILL_NAME);
    assert.ok(winner, `skill '${SKILL_NAME}' should be present`);
    assert.ok(
      winner.filePath.startsWith(agentSkillDir),
      `agentDir skill should win; got: ${winner.filePath}`,
    );

    // There should be a collision diagnostic indicating the .claude skill lost.
    const collision = diagnostics.find(
      (d) => d.type === "collision" && d.collision?.name === SKILL_NAME,
    );
    assert.ok(collision, "a collision diagnostic should be emitted for the losing .claude skill");
    assert.ok(
      collision.collision.loserPath.startsWith(claudeSkillDir),
      `loser should be the .claude skill; got: ${collision.collision.loserPath}`,
    );
    assert.ok(
      collision.collision.winnerPath.startsWith(agentSkillDir),
      `winner should be the agentDir skill; got: ${collision.collision.winnerPath}`,
    );
  });
});

test("user root appears before project roots in returned skillPaths", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cs-order-", { cwd: true, test: t });
  const userSkills = join(fixture.home, ".claude", "skills");
  const projectSkills = join(fixture.cwd, ".claude", "skills");
  mkdirSync(userSkills, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });

  // Make cwd look like a git repo root so the walk doesn't go higher.
  mkdirSync(join(fixture.cwd, ".git"), { recursive: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerClaudeSkillsDiscovery(pi);
    const result = await runDiscovery(pi, fixture.cwd, { isProjectTrusted: true });
    assert.ok(result, "result should not be undefined");
    const userIdx = result.skillPaths.indexOf(userSkills);
    const projectIdx = result.skillPaths.indexOf(projectSkills);
    assert.ok(userIdx !== -1, "user root should be present");
    assert.ok(projectIdx !== -1, "project root should be present");
    assert.ok(
      userIdx < projectIdx,
      "user root should appear before project root (upstream gives first-registered skill priority)",
    );
  });
});
