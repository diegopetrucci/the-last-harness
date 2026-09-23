import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildDoctorReport,
  resolveProjectAgentDoctorTrust,
  type ProjectAgentDoctorTrust,
} from "../../src/extension/doctor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { SOURCE_PRIORITY, type SkillSource } from "../../src/agents/skills.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import type { HeartbeatSessionSummary } from "../../src/extension/heartbeat-wiring.ts";

function makeState(cwd: string): SubagentState {
  return {
    baseCwd: cwd,
    currentSessionId: "session-current",
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
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

function renderTrustReport(cwd: string, projectAgentTrust: ProjectAgentDoctorTrust): string {
  return buildDoctorReport({
    cwd,
    config: {},
    state: makeState(cwd),
    projectAgentTrust,
    paths: {
      tempRootDir: path.join(cwd, "temp-root"),
      asyncDir: path.join(cwd, "async"),
      resultsDir: path.join(cwd, "results"),
    },
    deps: {
      isAsyncAvailable: () => false,
      discoverAgentsAll: () => ({
        builtin: [],
        package: [],
        user: [],
        project: [],
        userDir: cwd,
        projectDir: null,
        userSettingsPath: path.join(cwd, "settings.json"),
        projectSettingsPath: null,
      }),
      discoverAvailableSkills: () => [],
    },
  });
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
      assert.match(report, /Execution\n- shared run ceiling: 14400000ms/);
      assert.match(report, /- role ceilings: fresh wall-clock deadline per child spawn/);
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

  it("reports persisted project-agent trust without reading definitions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-project-trust-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-project-trust-outside-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const cases: Array<{
        name: string;
        store: { getEntry: (cwd: string) => { path: string; decision: boolean } | null };
        expected: string;
      }> = [
        {
          name: "saved positive",
          store: { getEntry: (cwd) => ({ path: cwd, decision: true }) },
          expected: "trusted",
        },
        {
          name: "saved negative",
          store: { getEntry: (cwd) => ({ path: cwd, decision: false }) },
          expected: "denied",
        },
        {
          name: "unconfigured",
          store: { getEntry: () => null },
          expected: "not configured",
        },
        {
          name: "path mismatch",
          store: { getEntry: () => ({ path: outside, decision: true }) },
          expected: "path mismatch",
        },
        {
          name: "trust error",
          store: {
            getEntry: () => {
              throw new Error("trust store unavailable");
            },
          },
          expected: "trust-store error",
        },
      ];

      for (const testCase of cases) {
        const trust = await resolveProjectAgentDoctorTrust(root, { trustStore: testCase.store });
        const report = renderTrustReport(root, trust);
        assert.match(
          report,
          new RegExp(`- project-agent trust: ${testCase.expected}`),
          testCase.name,
        );
        assert.doesNotMatch(report, /Project root:/);
      }

      const missingBridgeTrust = await resolveProjectAgentDoctorTrust(root);
      assert.deepEqual(missingBridgeTrust, { kind: "unavailable" });
      assert.match(
        renderTrustReport(root, missingBridgeTrust),
        /- project-agent trust: unavailable/,
      );

      const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-project-trust-bridge-"));
      fs.writeFileSync(path.join(bridgeDir, "trust.json"), "{}", "utf8");
      const throwingBridgeTrust = await resolveProjectAgentDoctorTrust(root, {
        agentDir: bridgeDir,
        createProjectTrustStore: () => {
          throw new Error("bridge failed");
        },
      });
      fs.rmSync(bridgeDir, { recursive: true, force: true });
      assert.deepEqual(throwingBridgeTrust, {
        kind: "project-agent",
        trusted: false,
        source: "trust-store-error",
      });

      const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-project-trust-no-git-"));
      const nonGitTrust = await resolveProjectAgentDoctorTrust(nonGit, {
        trustStore: { getEntry: () => ({ path: nonGit, decision: true }) },
      });
      assert.deepEqual(nonGitTrust, { kind: "unavailable" });
      assert.match(renderTrustReport(nonGit, nonGitTrust), /- project-agent trust: unavailable/);
      fs.rmSync(nonGit, { recursive: true, force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports unreadable status files without modifying them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-invalid-status-"));
    try {
      const paths = {
        tempRootDir: path.join(root, "temp-root"),
        asyncDir: path.join(root, "async"),
        resultsDir: path.join(root, "results"),
      };
      for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
      const runDir = path.join(paths.asyncDir, "run-invalid");
      fs.mkdirSync(runDir, { recursive: true });
      const statusPath = path.join(runDir, "status.json");
      fs.writeFileSync(statusPath, "{invalid", "utf-8");
      const before = fs.readFileSync(statusPath);

      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        paths,
        deps: {
          isAsyncAvailable: () => true,
          discoverAgentsAll: () => ({
            builtin: [],
            package: [],
            user: [],
            project: [],
            userDir: path.join(root, "home", ".agents"),
            projectDir: path.join(root, ".pi", "agents"),
            userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
            projectSettingsPath: path.join(root, ".pi", "settings.json"),
          }),
          discoverAvailableSkills: () => [],
        },
      });

      assert.ok(report.includes(`unreadable status at ${statusPath}`));
      assert.deepEqual(fs.readFileSync(statusPath), before);
      assert.equal(fs.existsSync(path.join(root, "quarantined-async-subagent-runs")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds unreadable status paths in the doctor report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-many-invalid-statuses-"));
    try {
      const paths = {
        tempRootDir: path.join(root, "temp-root"),
        asyncDir: path.join(root, "async"),
        resultsDir: path.join(root, "results"),
      };
      for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 60; index++) {
        const runDir = path.join(paths.asyncDir, `run-${String(index).padStart(2, "0")}`);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, "status.json"), "{invalid", "utf-8");
      }

      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
        paths,
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
      assert.equal((report.match(/unreadable status at /g) ?? []).length, 20);
      assert.match(report, /- and 40 more unreadable statuses/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces obsolete completionGuard diagnostics from agent discovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-obsolete-key-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeState(root),
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
            agentDiagnostics: [
              {
                source: "user",
                filePath: path.join(root, "legacy.md"),
                error:
                  "Obsolete frontmatter key 'completionGuard' is ignored; remove it from this agent definition.",
                kind: "notice",
              },
            ],
          }),
          discoverAvailableSkills: () => [],
        },
      });

      assert.match(report, /agent migration notices/);
      assert.match(report, /obsolete frontmatter key 'completionGuard'/i);
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

// ---------------------------------------------------------------------------
// Heartbeat section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — heartbeat section", () => {
  const minimalDeps = {
    isAsyncAvailable: () => false,
    discoverAgentsAll: () => ({
      builtin: [],
      package: [],
      user: [],
      project: [],
      userDir: "",
      projectDir: "",
      userSettingsPath: "",
      projectSettingsPath: "",
    }),
    discoverAvailableSkills: () => [],
  };

  function makeMinimalState(): SubagentState {
    return {
      baseCwd: "/tmp",
      currentSessionId: "session-hb",
      asyncJobs: new Map(),
      cleanupTimers: new Map(),
      lastUiContext: null,
      poller: null,
      watcher: null,
      watcherRestartTimer: null,
      resultFileCoalescer: { schedule: () => false, clear: () => {} },
    };
  }

  it("includes 'Heartbeat' section header in report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /Heartbeat/, "report must contain a Heartbeat section");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows 'disabled' when no heartbeat summary provided", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-dis-"));
    try {
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /heartbeat: not available|heartbeat: disabled/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows 'disabled' when heartbeat.enabled is false", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-dis2-"));
    try {
      const summary: HeartbeatSessionSummary = {
        enabled: false,
        totalBeats: 0,
        totalCacheReadTokens: 0,
        totalBeatCostUsd: 0,
        gapsSaved: 0,
        gapsWasted: 0,
        gapsLost: 0,
        gapsUnneeded: 0,
        breakerDisabled: false,
      };
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        heartbeat: summary,
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /heartbeat: disabled/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows enabled heartbeat totals when enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-en-"));
    try {
      const summary: HeartbeatSessionSummary = {
        enabled: true,
        totalBeats: 5,
        totalCacheReadTokens: 25000,
        totalBeatCostUsd: 0.00075,
        gapsSaved: 2,
        gapsWasted: 1,
        gapsLost: 0,
        gapsUnneeded: 0,
        breakerDisabled: false,
      };
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        heartbeat: summary,
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /heartbeat: enabled/);
      assert.match(report, /beats this session: 5/);
      assert.match(report, /cache-read tokens: 25000/);
      assert.match(report, /gaps:.*saved.*wasted/);
      assert.match(report, /circuit breaker: closed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows read-time active-gap totals without inventing a gap verdict", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-active-"));
    try {
      const summary: HeartbeatSessionSummary = {
        enabled: true,
        totalBeats: 1,
        totalCacheReadTokens: 5000,
        totalBeatCostUsd: 0.001575,
        gapsSaved: 0,
        gapsWasted: 0,
        gapsLost: 0,
        gapsUnneeded: 0,
        breakerDisabled: false,
      };
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        heartbeat: summary,
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /beats this session: 1/);
      assert.match(report, /cache-read tokens: 5000/);
      assert.match(report, /total beat cost/);
      assert.match(report, /- gaps: none yet/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows circuit breaker open when disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-brk-"));
    try {
      const summary: HeartbeatSessionSummary = {
        enabled: true,
        totalBeats: 3,
        totalCacheReadTokens: 0,
        totalBeatCostUsd: 0,
        gapsSaved: 0,
        gapsWasted: 1,
        gapsLost: 0,
        gapsUnneeded: 0,
        breakerDisabled: true,
      };
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        heartbeat: summary,
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /circuit breaker: open \(disabled after failures\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows unneeded gap count in gaps line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-hb-unneeded-"));
    try {
      const summary: HeartbeatSessionSummary = {
        enabled: true,
        totalBeats: 3,
        totalCacheReadTokens: 15000,
        totalBeatCostUsd: 0.00009,
        gapsSaved: 1,
        gapsWasted: 0,
        gapsLost: 0,
        gapsUnneeded: 12,
        breakerDisabled: false,
      };
      const report = buildDoctorReport({
        cwd: root,
        config: {},
        state: makeMinimalState(),
        heartbeat: summary,
        paths: {
          tempRootDir: root,
          asyncDir: path.join(root, "async"),
          resultsDir: path.join(root, "results"),
        },
        deps: minimalDeps,
      });
      assert.match(report, /gaps:.*1 saved.*12 unneeded/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
