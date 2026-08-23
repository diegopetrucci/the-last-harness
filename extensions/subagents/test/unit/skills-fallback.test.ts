import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildSkillInjection,
  clearSkillCache,
  discoverAvailableSkills,
  resolveSkills,
  resolveSkillsWithFallback,
} from "../../src/agents/skills.ts";

let tempDir = "";

function writeSkillFile(skillDir: string, body: string, description = "Test description"): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\ndescription: ${description}\n---\n\n${body}\n`,
    "utf-8",
  );
}

function makeProjectSkill(
  cwd: string,
  name: string,
  body: string,
  description = "Test description",
): void {
  const skillDir = path.join(cwd, ".pi", "skills", name);
  writeSkillFile(skillDir, body, description);
}

function makeProjectPackageSkill(
  cwd: string,
  packageName: string,
  name: string,
  body: string,
): void {
  const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
  makePackageSkill(packageRoot, name, body, packageName);
}

function makePackageSkill(
  packageRoot: string,
  name: string,
  body: string,
  packageName = `${name}-pkg`,
): void {
  const skillDir = path.join(packageRoot, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

async function importSkillsFresh() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const modulePath = path.resolve(projectRoot, "src/agents/skills.ts");
  const bust = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${pathToFileURL(modulePath).href}?bust=${bust}`
  )) as typeof import("../../src/agents/skills.ts");
}

describe("skills filesystem fallback", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-fallback-"));
    clearSkillCache();
  });

  afterEach(() => {
    clearSkillCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers project skills from filesystem paths", () => {
    makeProjectSkill(tempDir, "fallback-skill", "Use fallback mode.");

    const skills = discoverAvailableSkills(tempDir);
    const discovered = skills.find((skill) => skill.name === "fallback-skill");
    assert.ok(discovered, "expected fallback-skill to be discovered");
    assert.equal(discovered?.source, "project");
    assert.equal(discovered?.description, "Test description");
  });

  it("discovers project skills nested below grouping directories", () => {
    writeSkillFile(
      path.join(tempDir, ".pi", "skills", "shell", "issue-262-nested-skill"),
      "Use nested project skill.",
      "Nested issue 262 skill",
    );

    const skills = discoverAvailableSkills(tempDir);
    const discovered = skills.find((skill) => skill.name === "issue-262-nested-skill");
    assert.ok(discovered, "expected grouped nested skill to be discovered");
    assert.equal(discovered?.source, "project");
    assert.equal(discovered?.description, "Nested issue 262 skill");

    const { resolved, missing } = resolveSkills(["issue-262-nested-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.match(resolved[0]?.content ?? "", /Use nested project skill\./);
  });

  it("stops recursive project skill discovery at the first SKILL.md anchor", () => {
    const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
    writeSkillFile(path.join(groupedRoot, "issue-262-anchor"), "Use anchor skill.");
    writeSkillFile(
      path.join(groupedRoot, "issue-262-anchor", "nested", "issue-262-leaked-skill"),
      "Should not leak.",
    );
    writeSkillFile(path.join(groupedRoot, "issue-262-sibling"), "Use sibling skill.");

    const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
    assert.equal(names.includes("issue-262-anchor"), true);
    assert.equal(names.includes("issue-262-sibling"), true);
    assert.equal(names.includes("issue-262-leaked-skill"), false);
  });

  it("skips hidden directories and node_modules while recursing for project skills", () => {
    const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
    writeSkillFile(
      path.join(groupedRoot, ".hidden", "issue-262-hidden-skill"),
      "Should stay hidden.",
    );
    writeSkillFile(
      path.join(groupedRoot, "node_modules", "issue-262-node-skill"),
      "Should stay ignored.",
    );
    writeSkillFile(
      path.join(groupedRoot, "visible", "issue-262-visible-skill"),
      "Use visible nested skill.",
    );

    const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
    assert.equal(names.includes("issue-262-visible-skill"), true);
    assert.equal(names.includes("issue-262-hidden-skill"), false);
    assert.equal(names.includes("issue-262-node-skill"), false);
  });

  it("keeps direct markdown skills from explicit settings roots after parent recursion", () => {
    const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
    fs.mkdirSync(groupedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(groupedRoot, "issue-262-direct.md"),
      "Use direct markdown skill.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ skills: ["./skills/group"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(["issue-262-direct"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-settings");
    assert.match(resolved[0]?.content ?? "", /Use direct markdown skill\./);
  });

  it("keeps nested skills from higher-priority explicit settings roots after parent recursion", () => {
    writeSkillFile(
      path.join(tempDir, "skills", "group", "issue-262-settings-nested"),
      "Use settings nested skill.",
    );
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
      "utf-8",
    );
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ skills: ["../skills/group"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(["issue-262-settings-nested"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-settings");
    assert.match(resolved[0]?.content ?? "", /Use settings nested skill\./);
  });

  it("keeps nested skills from higher-priority explicit settings roots when the root path is duplicated", () => {
    writeSkillFile(
      path.join(tempDir, "skills", "group", "issue-262-settings-same-root"),
      "Use settings same root skill.",
    );
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
      "utf-8",
    );
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ skills: ["../skills"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(["issue-262-settings-same-root"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-settings");
    assert.match(resolved[0]?.content ?? "", /Use settings same root skill\./);
  });

  it("resolves and reads skill content via filesystem fallback", () => {
    makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

    const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.name, "resolve-skill");
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
  });

  it("builds lazy skill references instead of inlining full skill bodies", () => {
    makeProjectSkill(tempDir, "lazy-skill", "This body should stay out of the system prompt.");

    const { resolved, missing } = resolveSkills(["lazy-skill"], tempDir);
    assert.deepEqual(missing, []);

    const injection = buildSkillInjection(resolved);
    assert.match(injection, /The following configured skills are available to this subagent/);
    assert.match(injection, /Use the read tool to load a skill's file/);
    assert.match(injection, /<available_skills>/);
    assert.match(injection, /<name>lazy-skill<\/name>/);
    assert.match(injection, /<description>Test description<\/description>/);
    assert.match(injection, /<location>.*lazy-skill.*SKILL\.md<\/location>/);
    assert.doesNotMatch(injection, /This body should stay out/);
    assert.doesNotMatch(injection, /<skill name=/);
  });

  it("escapes XML-sensitive skill metadata in lazy references", () => {
    makeProjectSkill(tempDir, "amp&skill", "Body", "Use A & B <carefully>");

    const { resolved } = resolveSkills(["amp&skill"], tempDir);
    const injection = buildSkillInjection(resolved);
    assert.match(injection, /<name>amp&amp;skill<\/name>/);
    assert.match(injection, /<description>Use A &amp; B &lt;carefully&gt;<\/description>/);
    assert.match(injection, /amp&amp;skill[\\/]SKILL\.md/);
  });

  it("does not expose pi-subagents as a child-injectable skill", () => {
    makeProjectSkill(tempDir, "pi-subagents", "Parent orchestration only.");
    makeProjectSkill(tempDir, "safe-bash", "Use safe bash.");

    const available = discoverAvailableSkills(tempDir).map((skill) => skill.name);
    assert.equal(available.includes("pi-subagents"), false);
    assert.equal(available.includes("safe-bash"), true);

    const { resolved, missing } = resolveSkills(["pi-subagents", "safe-bash"], tempDir);
    assert.deepEqual(missing, ["pi-subagents"]);
    assert.deepEqual(
      resolved.map((skill) => skill.name),
      ["safe-bash"],
    );
  });

  it("classifies package-provided skills as project-package", () => {
    makeProjectPackageSkill(tempDir, "test-skill-package", "pkg-skill", "Use package skill.");

    const skills = discoverAvailableSkills(tempDir);
    const discovered = skills.find((skill) => skill.name === "pkg-skill");
    assert.ok(discovered, "expected pkg-skill to be discovered");
    assert.equal(discovered?.source, "project-package");
  });

  it("prefers project skills over project-package skills with the same name", () => {
    makeProjectPackageSkill(tempDir, "test-skill-package", "shared-skill", "Package version");
    makeProjectSkill(tempDir, "shared-skill", "Project version");

    const { resolved, missing } = resolveSkills(["shared-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Project version/);
  });

  it("discovers skills from project settings packages", () => {
    const packageRoot = path.join(tempDir, ".pi", "packages", "local-skill-pkg");
    makePackageSkill(packageRoot, "settings-package-skill", "Settings package skill.");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["./packages/local-skill-pkg"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(["settings-package-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("discovers skills from project settings npm package sources", () => {
    const packageRoot = path.join(tempDir, ".pi", "npm", "node_modules", "@scope", "skill-package");
    makePackageSkill(
      packageRoot,
      "project-settings-scoped-npm-package-skill",
      "Project settings scoped npm package skill.",
      "@scope/skill-package",
    );
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:@scope/skill-package@1.2.3"] }, null, 2),
      "utf-8",
    );

    const { resolved, missing } = resolveSkills(
      ["project-settings-scoped-npm-package-skill"],
      tempDir,
    );
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("discovers skills from the current cwd package", () => {
    makePackageSkill(tempDir, "cwd-package-skill", "Cwd package skill.");

    const { resolved, missing } = resolveSkills(["cwd-package-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("falls back to the runtime cwd when the execution cwd lacks the skill", () => {
    const nestedDir = path.join(tempDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    makePackageSkill(tempDir, "runtime-fallback-skill", "Runtime fallback skill.");

    const { resolved, missing } = resolveSkillsWithFallback(
      ["runtime-fallback-skill"],
      nestedDir,
      tempDir,
    );
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project-package");
  });

  it("discovers skills from user settings packages", async () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const userPackageRoot = path.join(userAgentDir, "user-pkg");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      makePackageSkill(
        userPackageRoot,
        "user-settings-package-skill",
        "User settings package skill.",
      );
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "settings.json"),
        JSON.stringify({ packages: [{ source: "./user-pkg" }] }, null, 2),
        "utf-8",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const discovered = fresh.discoverAvailableSkills(tempDir);
      const skill = discovered.find((entry) => entry.name === "user-settings-package-skill");
      assert.ok(skill);
      assert.equal(skill?.source, "user-package");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("discovers skills from user settings git package sources", async () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const packageRoot = path.join(userAgentDir, "git", "github.com", "user", "repo");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      makePackageSkill(
        packageRoot,
        "user-settings-git-package-skill",
        "User settings git package skill.",
      );
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "settings.json"),
        JSON.stringify({ packages: ["git:github.com/user/repo.git@main"] }, null, 2),
        "utf-8",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const discovered = fresh.discoverAvailableSkills(tempDir);
      const skill = discovered.find((entry) => entry.name === "user-settings-git-package-skill");
      assert.ok(skill);
      assert.equal(skill?.source, "user-package");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("discovers skills from user settings scoped npm package sources", async () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const packageRoot = path.join(userAgentDir, "npm", "node_modules", "@scope", "skill-package");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      makePackageSkill(
        packageRoot,
        "user-settings-scoped-npm-package-skill",
        "User settings scoped npm package skill.",
        "@scope/skill-package",
      );
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "settings.json"),
        JSON.stringify({ packages: [{ source: "npm:@scope/skill-package@latest" }] }, null, 2),
        "utf-8",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const discovered = fresh.discoverAvailableSkills(tempDir);
      const skill = discovered.find(
        (entry) => entry.name === "user-settings-scoped-npm-package-skill",
      );
      assert.ok(skill);
      assert.equal(skill?.source, "user-package");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("surfaces malformed project settings files instead of silently ignoring them", () => {
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

    assert.throws(
      () => resolveSkills(["missing-skill"], tempDir),
      /Failed to read skills settings file .+\.pi[\\/]settings\.json/,
    );
  });

  it("surfaces malformed explicit settings package manifests instead of silently ignoring them", () => {
    const packageRoot = path.join(tempDir, ".pi", "packages", "broken-package");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), "{bad-json", "utf-8");
    fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["./packages/broken-package"] }, null, 2),
      "utf-8",
    );

    assert.throws(
      () => discoverAvailableSkills(tempDir),
      /Failed to read package manifest .+broken-package[\\/]package\.json/,
    );
  });

  // -------------------------------------------------------------------------
  // .claude/skills discovery (tlhm-bisn)
  // -------------------------------------------------------------------------

  it("discovers a skill from <cwd>/.claude/skills", () => {
    writeSkillFile(
      path.join(tempDir, ".claude", "skills", "claude-only-skill"),
      "Use the claude-only skill.",
      "Claude-only skill description",
    );

    const skills = discoverAvailableSkills(tempDir);
    const discovered = skills.find((s) => s.name === "claude-only-skill");
    assert.ok(discovered, "expected claude-only-skill to be discovered");
    assert.equal(discovered?.source, "project-claude");
    assert.equal(discovered?.description, "Claude-only skill description");

    const { resolved, missing } = resolveSkills(["claude-only-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.match(resolved[0]?.content ?? "", /Use the claude-only skill\./);
  });

  it("prefers .pi/skills over .claude/skills when the same skill name exists in both", () => {
    // Lower-priority .claude copy
    writeSkillFile(
      path.join(tempDir, ".claude", "skills", "collision-skill"),
      "Claude copy — should lose.",
    );
    // Higher-priority .pi/skills copy
    makeProjectSkill(tempDir, "collision-skill", "Pi copy — should win.");

    const { resolved, missing } = resolveSkills(["collision-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Pi copy/);
  });

  it("prefers .agents/skills over .claude/skills when the same skill name exists in both", () => {
    // Lower-priority .claude copy
    writeSkillFile(
      path.join(tempDir, ".claude", "skills", "agents-collision-skill"),
      "Claude copy — should lose.",
    );
    // .agents/skills copy (source: project, priority 700)
    writeSkillFile(
      path.join(tempDir, ".agents", "skills", "agents-collision-skill"),
      "Agents copy — should win.",
    );

    const { resolved, missing } = resolveSkills(["agents-collision-skill"], tempDir);
    assert.deepEqual(missing, []);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.source, "project");
    assert.match(resolved[0]?.content ?? "", /Agents copy/);
  });

  it(".claude/skills root is exempt from the dot-directory skip rule", () => {
    // shouldSkipDirectory skips nested dot-directories during recursion, but
    // explicit search roots in skillPaths are processed directly and are exempt.
    // This test pins that a skill directly under <cwd>/.claude/skills resolves
    // even though '.claude' starts with a dot.
    writeSkillFile(
      path.join(tempDir, ".claude", "skills", "dot-root-skill"),
      "Reachable via explicit root.",
      "Dot-root skill",
    );

    const { resolved, missing } = resolveSkills(["dot-root-skill"], tempDir);
    assert.deepEqual(
      missing,
      [],
      ".claude/skills root must be reachable as an explicit search root",
    );
    assert.equal(resolved.length, 1);
    assert.match(resolved[0]?.content ?? "", /Reachable via explicit root\./);
  });

  it("suppresses .claude/skills when tlh.claudeSkills.disabled is true in user settings", async () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

      // Place a skill in the project .claude/skills directory.
      writeSkillFile(
        path.join(tempDir, ".claude", "skills", "disabled-claude-skill"),
        "Should not appear.",
      );

      // Place a skill in the user .claude/skills directory.
      writeSkillFile(
        path.join(fakeHome, ".claude", "skills", "disabled-user-claude-skill"),
        "Should not appear either.",
      );

      // Set tlh.claudeSkills.disabled in the user agent settings.
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "settings.json"),
        JSON.stringify({ tlh: { claudeSkills: { disabled: true } } }, null, 2),
        "utf-8",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const discovered = fresh.discoverAvailableSkills(tempDir);
      const names = discovered.map((s) => s.name);
      assert.equal(
        names.includes("disabled-claude-skill"),
        false,
        "project .claude/skills must be suppressed when claudeSkills.disabled is true",
      );
      assert.equal(
        names.includes("disabled-user-claude-skill"),
        false,
        "user .claude/skills must be suppressed when claudeSkills.disabled is true",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("<agentDir>/skills beats <cwd>/.claude/skills for the same skill name (cross-scope)", async () => {
    // Pins the fix for the precedence inversion: project-claude (180) must rank
    // below user (300) so a user's own <agentDir>/skills always wins over a
    // same-named skill in a project's .claude/skills directory.
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      process.env.PI_CODING_AGENT_DIR = userAgentDir;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

      // user skill in <agentDir>/skills (source: user, priority 300)
      writeSkillFile(
        path.join(userAgentDir, "skills", "cross-scope-skill"),
        "User agentDir copy — should win.",
        "User agentDir skill",
      );
      // project-claude skill in <cwd>/.claude/skills (source: project-claude, priority 180)
      writeSkillFile(
        path.join(tempDir, ".claude", "skills", "cross-scope-skill"),
        "Project .claude copy — should lose.",
        "Project claude skill",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const { resolved, missing } = fresh.resolveSkills(["cross-scope-skill"], tempDir);
      assert.deepEqual(missing, []);
      assert.equal(resolved.length, 1);
      assert.equal(
        resolved[0]?.source,
        "user",
        "agentDir/skills (user) must beat .claude/skills (project-claude)",
      );
      assert.match(resolved[0]?.content ?? "", /User agentDir copy/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("user-package skill beats user-claude skill for the same skill name (cross-scope)", async () => {
    // Pins that user-package (200) ranks above user-claude (170): a skill installed
    // via a user-side package must beat a same-named skill from ~/.claude/skills.
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const userPackageRoot = path.join(userAgentDir, "user-pkg");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

      // user-package skill (source: user-package, priority 200)
      makePackageSkill(userPackageRoot, "pkg-vs-claude-skill", "Package copy — should win.");
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "settings.json"),
        JSON.stringify({ packages: [{ source: "./user-pkg" }] }, null, 2),
        "utf-8",
      );

      // user-claude skill in ~/.claude/skills (source: user-claude, priority 170)
      writeSkillFile(
        path.join(fakeHome, ".claude", "skills", "pkg-vs-claude-skill"),
        "User .claude copy — should lose.",
      );

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const { resolved, missing } = fresh.resolveSkills(["pkg-vs-claude-skill"], tempDir);
      assert.deepEqual(missing, []);
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]?.source, "user-package", "user-package must beat user-claude");
      assert.match(resolved[0]?.content ?? "", /Package copy/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });

  it("discovers a skill from <home>/.claude/skills", async () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const userAgentDir = path.join(fakeHome, ".pi", "agent");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

      writeSkillFile(
        path.join(fakeHome, ".claude", "skills", "user-claude-skill"),
        "Use the user-level claude skill.",
        "User claude skill",
      );
      fs.mkdirSync(userAgentDir, { recursive: true });

      const fresh = await importSkillsFresh();
      fresh.clearSkillCache();
      const discovered = fresh.discoverAvailableSkills(tempDir);
      const skill = discovered.find((s) => s.name === "user-claude-skill");
      assert.ok(skill, "expected user-claude-skill to be discovered from <home>/.claude/skills");
      assert.equal(skill?.source, "user-claude");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      if (previousExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previousExtraAgentDirs;
    }
  });
});
