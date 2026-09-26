import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { SOURCE_PRIORITY, type SkillSource } from "../../src/agents/skills.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
  return {
    baseCwd: cwd,
    currentSessionId: "session-current",
    asyncJobs: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "Prompt",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source,
    filePath: `/tmp/${name}.md`,
  };
}

describe("buildDoctorReport", () => {
  it("formats a bounded successful environment summary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-success-"));
    try {
      const paths = {
        tempRootDir: path.join(root, "temp-root"),
        asyncDir: path.join(root, "async"),
        resultsDir: path.join(root, "results"),
      };
      for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(paths.asyncDir, "run-active"), { recursive: true });
      fs.writeFileSync(
        path.join(paths.asyncDir, "run-active", "status.json"),
        JSON.stringify(
          {
            runId: "run-active",
            mode: "single",
            state: "running",
            pid: process.pid,
            startedAt: 1000,
            lastUpdate: 1500,
          },
          null,
          2,
        ),
        "utf-8",
      );

      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        currentSessionFile: path.join(root, "sessions", "parent.jsonl"),
        currentSessionId: "session-abc123",
        expandTilde: (value) => value.replace(/^~\//, `${root}/home/`),
        paths,
        deps: {
          isAsyncAvailable: () => true,
          discoverAgentsAll: (_cwd: string) => ({
            builtin: [makeAgent("builtin-a", "builtin")],
            package: [],
            user: [makeAgent("user-a", "user")],
            project: [makeAgent("project-a", "project"), makeAgent("project-b", "project")],
            userDir: path.join(root, "home", ".agents"),
            projectDir: path.join(root, ".pi", "agents"),
            userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
            projectSettingsPath: path.join(root, ".pi", "settings.json"),
          }),
          discoverAvailableSkills: () => [
            { name: "project-skill", source: "project" },
            { name: "package-skill", source: "user-package" },
            { name: "claude-project-skill", source: "project-claude" },
            { name: "claude-user-skill", source: "user-claude" },
          ],
        },
      });

      assert.match(report, /^Subagents doctor report/);
      assert.ok(report.includes(`- cwd: ${root}`));
      assert.match(report, /- async support: available/);
      assert.match(report, /- configured session dir: not configured/);
      assert.match(report, /- current session file: .*parent\.jsonl/);
      assert.match(report, /- temp root: ok /);
      assert.match(
        report,
        /- runtime dir counts: async 1 \(top-level 1, nested 0, active\/live 1, stale 0\); nested event routes 0 \(unreferenced 0\)/,
      );
      assert.match(report, /- agents: total 4 \(builtin 1, package 0, user 1, project 2\)/);
      assert.doesNotMatch(report, /- chains:/);
      assert.match(
        report,
        /- skills: total 4 \(project 1, user-package 1, project-claude 1, user-claude 1\)/,
      );
      assert.doesNotMatch(report, /Companion packages/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps reporting when a directory or discovery check fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
    try {
      const asyncPath = path.join(root, "async-file");
      fs.writeFileSync(asyncPath, "not a directory");
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        paths: {
          tempRootDir: root,
          asyncDir: asyncPath,
          resultsDir: path.join(root, "missing-results"),
        },
        deps: {
          isAsyncAvailable: () => false,
          discoverAgentsAll: () => {
            throw new Error("discovery exploded");
          },
          discoverAvailableSkills: () => [],
        },
      });

      assert.match(report, /- async support: unavailable/);
      assert.match(report, /- async runs: failed .*Error: not a directory:/);
      assert.match(report, /- results: missing /);
      assert.match(report, /- runtime dir counts: failed — Error: not a directory:/);
      assert.match(report, /- agents: failed — Error: discovery exploded/);
      assert.match(report, /- skills: total 0 \(none\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows legacy heartbeat notice when config has a heartbeat key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-heartbeat-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: { heartbeat: { interval: 30 } },
        state: makeState(root),
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: {
          isAsyncAvailable: () => true,
          discoverAgentsAll: () => ({
            builtin: [],
            package: [],
            user: [],
            project: [],
            userDir: root,
            projectDir: null,
            userSettingsPath: path.join(root, "settings.json"),
            projectSettingsPath: null,
          }),
          discoverAvailableSkills: () => [],
        },
      });

      assert.match(report, /Notices/);
      assert.match(report, /heartbeat key/);
      assert.match(report, /no longer used and can be removed/);
      assert.match(report, /cacheWarming/);
      assert.match(report, /docs\/subagents\.md/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits legacy heartbeat notice when config has no heartbeat key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-no-heartbeat-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: {
          isAsyncAvailable: () => true,
          discoverAgentsAll: () => ({
            builtin: [],
            package: [],
            user: [],
            project: [],
            userDir: root,
            projectDir: null,
            userSettingsPath: path.join(root, "settings.json"),
            projectSettingsPath: null,
          }),
          discoverAvailableSkills: () => [],
        },
      });

      assert.doesNotMatch(report, /Notices/);
      assert.doesNotMatch(report, /heartbeat key/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("formatSkillSourceCounts ordered list covers every SkillSource value", () => {
    // Derive allSources from SOURCE_PRIORITY — the single source of truth.
    // Adding a new SkillSource to SOURCE_PRIORITY automatically includes it here
    // so the doctor's per-source breakdown cannot silently drop it.
    const allSources = Object.keys(SOURCE_PRIORITY) as SkillSource[];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-all-sources-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: {
          isAsyncAvailable: () => true,
          discoverAgentsAll: () => ({
            builtin: [],
            package: [],
            user: [],
            project: [],
            userDir: root,
            projectDir: null,
            userSettingsPath: path.join(root, "settings.json"),
            projectSettingsPath: null,
          }),
          discoverAvailableSkills: () =>
            allSources.map((source) => ({ name: `${source}-skill`, source })),
        },
      });

      // Every source must produce a non-zero count in the breakdown line.
      for (const source of allSources) {
        assert.match(
          report,
          new RegExp(`${source} 1`),
          `expected source '${source}' to appear in the skills line of the doctor report`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
