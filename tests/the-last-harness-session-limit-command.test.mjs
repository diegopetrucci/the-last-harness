import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { makeTempDir } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  buildSessionLimitReportHtml,
  createSessionLimitReportCommandHandler,
  SESSION_LIMIT_REPORT_COMMAND_NAME,
} = await jiti.import("../extensions/the-last-harness/session-limit-report.ts");

// Verify that /tokens is still intact after changes to tokens.ts
const { registerTokensCommand } = await jiti.import("../extensions/the-last-harness/tokens.ts");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides = {}) {
  return {
    provider: "anthropic",
    fetchedAt: Date.now(),
    windows: {
      session: {
        key: "session",
        label: "Session",
        used: 80,
        limit: 100,
        remaining: 20,
        percent: 80,
        resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2h from now
        durationMs: 5 * 60 * 60 * 1000,
      },
    },
    ...overrides,
  };
}

function createPiHarness() {
  const commands = new Map();
  return {
    commands,
    getAllTools() {
      return [];
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

/**
 * Create a minimal sessions root with one primary session file.
 * Returns the sessionsRoot path.
 */
function createSessionsFixture(
  baseDir,
  { includeTranscript = false, includeCwd = false, includeSessionInfo = false } = {},
) {
  const sessionsRoot = join(baseDir, "sessions");
  const projDir = "--Users-foo-my-project--";
  const projPath = join(sessionsRoot, projDir);
  mkdirSync(projPath, { recursive: true });

  const WIN_START = "2026-05-01T10:00:00.000Z";
  const WIN_END = "2026-05-01T15:00:00.000Z";
  const IN_WIN = "2026-05-01T12:00:00.000Z";

  // Real usage shape observed in actual tlh session files
  const realUsage = {
    input: 8854,
    output: 80,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8934,
    cost: { input: 0.026562, output: 0.012008, total: 0.04667 },
  };

  const sessionHeader = includeCwd
    ? {
        type: "session",
        id: "session-abc123",
        name: "My test session",
        cwd: "/Users/foo/cwd-project",
      }
    : { type: "session", id: "session-abc123", name: "My test session" };

  const sessionEntries = [
    sessionHeader,
    ...(includeSessionInfo ? [{ type: "session_info", name: "Renamed Session" }] : []),
    { type: "model_change", provider: "anthropic", modelId: "claude-opus-4-5" },
    {
      type: "message",
      timestamp: IN_WIN,
      message: {
        role: "assistant",
        content: includeTranscript
          ? [{ type: "text", text: "SECRET TRANSCRIPT TEXT" }]
          : [{ type: "text", text: "" }],
        usage: realUsage,
      },
    },
    {
      // Out-of-window entry — should not appear in window totals
      type: "message",
      timestamp: "2026-04-30T09:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "pre-window" }],
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
      },
    },
  ];

  const sessionFile = join(projPath, `1746093600000_abc123.jsonl`);
  writeFileSync(sessionFile, sessionEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // writeFileSync already set the mtime to now, which is within the window

  return { sessionsRoot, sessionFile, WIN_START, WIN_END, IN_WIN };
}

function createCommandContext({ sessionDir, sessionsRoot }) {
  const notifications = [];
  const sessionFile = join(sessionDir, "session.jsonl");
  return {
    notifications,
    ctx: {
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => ({ id: "session-xyz", timestamp: "2026-05-01T11:00:00Z" }),
        getLeafId: () => "leaf1",
        getSessionName: () => "Current session",
        getSessionFile: () => sessionFile,
        // getSessionDir returns the per-project dir; parent should be sessionsRoot
        getSessionDir: () => join(sessionsRoot, "--Users-foo-my-project--"),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} rejects non-empty arguments`, async (t) => {
  const pi = createPiHarness();
  let opened = false;
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async () => {
      opened = true;
    },
    now: () => new Date("2026-05-01T12:00:00Z"),
    getSnapshot: () => makeSnapshot(),
  });
  const sessionDir = makeTempDir("tlh-slr-args-", t);
  const { ctx, notifications } = createCommandContext({
    sessionDir,
    sessionsRoot: join(sessionDir, "sessions"),
  });

  await handler("some-arg", ctx);

  assert.equal(opened, false, "must not open report when args given");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Usage:/);
  assert.equal(notifications[0].type, "error");
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} happy path: report generated with window metadata and ranked sessions`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-happy-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir);

  // The per-project session dir that would normally exist
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  const nowDate = new Date("2026-05-01T13:00:00.000Z");
  const nowMs = nowDate.getTime();

  // Snapshot: window resets 2h from now, 80% used
  const resetsAt = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
  const snapshot = makeSnapshot({
    windows: {
      session: {
        key: "session",
        label: "Session",
        percent: 80,
        resetsAt,
        durationMs: 5 * 60 * 60 * 1000,
      },
    },
  });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => nowDate,
    getSnapshot: () => snapshot,
  });

  const notifications = [];
  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);

  assert.ok(openedPath, "report was opened");

  const html = readFileSync(openedPath, "utf8");

  // Window metadata section
  assert.match(html, /<h2>Window<\/h2>/);
  assert.match(html, /anthropic/);
  assert.match(html, /80%/); // percent used
  assert.match(html, /2h 0m/); // resets-in
  assert.match(html, /provider snapshot/); // resolution source

  // Sessions section
  assert.match(html, /<h2>Sessions<\/h2>/);
  // decodeProjectDirName strips '--' delimiters, splits on '-', takes last segment:
  // '--Users-foo-my-project--' → last segment = 'project'
  assert.match(html, /project/); // project label from dir name
  assert.match(html, /My test session/); // session name from fixture
  // Token breakdown columns in sessions table
  assert.match(html, /Input/);
  assert.match(html, /Output/);
  assert.match(html, /Cache read/);
  assert.match(html, /Cache write/);
  assert.match(html, /Cost \(USD\)/);

  // Non-zero token totals from real usage shape (8854 input + 80 output = 8934 total)
  assert.match(html, /8,934/); // formatted totalTokens
  assert.match(html, /8,854/); // formatted inputTokens
  // cost 0.04667 rounds to 4 decimal places → $0.0467
  assert.match(html, /\$0\.0467/); // formatted cost

  // Per-provider totals
  assert.match(html, /<h2>Per-provider totals<\/h2>/);

  // Caveats
  assert.match(html, /<h2>Caveats<\/h2>/);
  assert.match(html, /Relative attribution only/);
  assert.match(html, /External consumers/);
  assert.match(html, /no raw transcript text/i);

  // Should NOT contain fallback caveat (we have a snapshot)
  assert.doesNotMatch(html, /Fallback window/);

  // Notification
  assert.ok(
    notifications.at(-1)?.message.includes("Opened local TLH session-limit report"),
    "success notification",
  );
  assert.equal(notifications.at(-1)?.type, "info");

  // File permissions
  const reportStat = statSync(openedPath);
  const dirStat = statSync(dirname(openedPath));
  if (process.platform !== "win32") {
    assert.equal(reportStat.mode & 0o777, 0o600, "report file is 0600");
    assert.equal(dirStat.mode & 0o777, 0o700, "report directory is 0700");
  }
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} fallback window: caveat present when no snapshot`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-fallback-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir);
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => undefined, // no snapshot → fallback window
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);

  assert.ok(openedPath, "report was generated");
  const html = readFileSync(openedPath, "utf8");

  // Fallback caveat must appear
  assert.match(html, /Fallback window/);
  // Resolution source must reflect fallback
  assert.match(html, /fallback \(5h trailing\)/);
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} privacy: report does not embed transcript text from session files`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-privacy-", t);
  // Create sessions with transcript text in content
  const { sessionsRoot } = createSessionsFixture(baseDir, { includeTranscript: true });
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => makeSnapshot(),
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);

  assert.ok(openedPath, "report was generated");
  const html = readFileSync(openedPath, "utf8");

  // The content text "SECRET TRANSCRIPT TEXT" must not appear in the report
  assert.doesNotMatch(html, /SECRET TRANSCRIPT TEXT/, "report must not embed transcript text");
  // Privacy caveat must be present
  assert.match(html, /no raw transcript text/i);
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} missing sessions root: notifies error gracefully`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-missing-", t);
  const nonExistentSessionsRoot = join(baseDir, "nonexistent", "sessions");
  const currentProjectSessionDir = join(nonExistentSessionsRoot, "--proj--");
  const sessionDir = join(baseDir, "current");
  mkdirSync(sessionDir, { recursive: true });

  const notifications = [];
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async () => {},
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => makeSnapshot(),
  });

  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);

  // Should have notified an error about missing sessions root
  assert.ok(
    notifications.some((n) => n.type === "error"),
    "notifies error when sessions root is missing",
  );
});

// ---------------------------------------------------------------------------
// Unreadable file: report still generated with caveat
// ---------------------------------------------------------------------------

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} unreadable session file: report generated with caveat`, async (t) => {
  if (process.platform === "win32") {
    t.skip("chmod not supported on Windows");
    return;
  }
  const { chmodSync } = await import("node:fs");

  const baseDir = makeTempDir("tlh-slr-unreadable-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir);
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");

  // Add a second .jsonl file that is not readable
  const unreadableFile = join(currentProjectSessionDir, "1746097200000_unreadable.jsonl");
  writeFileSync(unreadableFile, JSON.stringify({ type: "session", id: "bad" }) + "\n");
  chmodSync(unreadableFile, 0o000);

  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => makeSnapshot(),
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  try {
    await handler("", ctx);
    assert.ok(openedPath, "report was generated despite unreadable file");

    const html = readFileSync(openedPath, "utf8");
    // Caveat must mention the unreadable file
    assert.match(html, /Could not read session file/, "caveat for unreadable file must appear");
    assert.match(html, /1746097200000_unreadable\.jsonl/, "unreadable file basename in caveat");
    // The readable file's session should still appear
    assert.match(html, /My test session/);
  } finally {
    // Restore permissions so temp dir cleanup works
    chmodSync(unreadableFile, 0o644);
  }
});

// ---------------------------------------------------------------------------
// session_info-derived name and cwd-derived project label
// ---------------------------------------------------------------------------

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} session_info name appears in report`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-sinfo-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir, { includeSessionInfo: true });
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => makeSnapshot(),
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);
  assert.ok(openedPath, "report was generated");
  const html = readFileSync(openedPath, "utf8");
  // session_info name should appear (not just the header name)
  assert.match(html, /Renamed Session/, "session_info name should appear in report");
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} cwd-derived project label appears in report`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-cwd-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir, { includeCwd: true });
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => new Date("2026-05-01T13:00:00.000Z"),
    getSnapshot: () => makeSnapshot(),
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);
  assert.ok(openedPath, "report was generated");
  const html = readFileSync(openedPath, "utf8");
  // The cwd basename ("cwd-project") should appear, not the lossy dir-decode ("project")
  assert.match(html, /cwd-project/, "cwd-derived project label should appear");
});

test(`/${SESSION_LIMIT_REPORT_COMMAND_NAME} slimming: transcript content does not survive to HTML`, async (t) => {
  const baseDir = makeTempDir("tlh-slr-slim-", t);
  const { sessionsRoot } = createSessionsFixture(baseDir, { includeTranscript: true });
  const currentProjectSessionDir = join(sessionsRoot, "--Users-foo-my-project--");
  const sessionDir = join(baseDir, "current-session");
  mkdirSync(sessionDir, { recursive: true });

  const nowDate = new Date("2026-05-01T13:00:00.000Z");
  // Use a deterministic resetsAt so the 2026 fixture timestamps fall inside the window
  const resetsAt = new Date(nowDate.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const snapshot = makeSnapshot({
    windows: {
      session: {
        key: "session",
        label: "Session",
        percent: 80,
        resetsAt,
        durationMs: 5 * 60 * 60 * 1000,
      },
    },
  });

  let openedPath;
  const pi = createPiHarness();
  const handler = createSessionLimitReportCommandHandler(pi, {
    openReport: async (p) => {
      openedPath = p;
    },
    now: () => nowDate,
    getSnapshot: () => snapshot,
  });

  const ctx = {
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => join(sessionDir, "session.jsonl"),
      getSessionDir: () => currentProjectSessionDir,
    },
  };

  await handler("", ctx);
  assert.ok(openedPath, "report was generated");
  const html = readFileSync(openedPath, "utf8");
  // slimEntries must have stripped content payloads before aggregation
  assert.doesNotMatch(html, /SECRET TRANSCRIPT TEXT/, "slimmed content must not appear in HTML");
  // Usage data (token counts) must still be present
  assert.match(html, /8,934/, "usage totals must survive slimming");
});

// ---------------------------------------------------------------------------
// buildSessionLimitReportHtml unit tests
// ---------------------------------------------------------------------------

test("buildSessionLimitReportHtml renders required sections", () => {
  const window = { startMs: 1_000, endMs: 6_000, source: "snapshot" };
  const result = {
    rows: [],
    perProviderTotals: [],
    grandTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
      assistantMessages: 0,
    },
    caveats: [],
  };
  const snapshot = makeSnapshot();
  const html = buildSessionLimitReportHtml(window, result, snapshot, Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  assert.match(html, /<h2>Window<\/h2>/);
  assert.match(html, /<h2>Sessions<\/h2>/);
  assert.match(html, /<h2>Per-provider totals<\/h2>/);
  assert.match(html, /<h2>Caveats<\/h2>/);
  assert.match(html, /Relative attribution only/);
  assert.match(html, /External consumers/);
  assert.match(html, /no raw transcript text/i);
  assert.doesNotMatch(html, /Fallback window/);
});

test("buildSessionLimitReportHtml includes fallback caveat when source is 'fallback'", () => {
  const window = { startMs: 1_000, endMs: 6_000, source: "fallback" };
  const result = {
    rows: [],
    perProviderTotals: [],
    grandTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
      assistantMessages: 0,
    },
    caveats: [],
  };
  const html = buildSessionLimitReportHtml(window, result, undefined, Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  assert.match(html, /Fallback window/);
  assert.match(html, /fallback \(5h trailing\)/);
});

test("buildSessionLimitReportHtml renders sessions table with token breakdown and cost columns", () => {
  const window = { startMs: 0, endMs: Date.now() + 1_000_000, source: "snapshot" };
  const rows = [
    {
      filePath: "/sessions/--proj--/session.jsonl",
      fileKind: "primary",
      projectLabel: "proj",
      sessionId: "id-1",
      sessionName: "Cost session",
      providerTotals: [],
      windowTotals: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        totalTokens: 1800,
        costUsd: 0.0123,
        turns: 5,
        assistantMessages: 5,
      },
      coverage: { assistantMessages: 5, withUsage: 5, withoutUsage: 0 },
      malformedLineCount: 0,
    },
  ];
  const result = {
    rows,
    perProviderTotals: [
      {
        provider: "anthropic",
        modelId: "claude",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheWriteTokens: 100,
          totalTokens: 1800,
          costUsd: 0.0123,
          turns: 5,
          assistantMessages: 5,
        },
      },
    ],
    grandTotals: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      totalTokens: 1800,
      costUsd: 0.0123,
      turns: 5,
      assistantMessages: 5,
    },
    caveats: [],
  };
  const html = buildSessionLimitReportHtml(window, result, makeSnapshot(), Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  // Sessions table columns
  assert.match(html, /Input/);
  assert.match(html, /Output/);
  assert.match(html, /Cache read/);
  assert.match(html, /Cache write/);
  assert.match(html, /Cost \(USD\)/);
  // Token values from windowTotals
  assert.match(html, /1,000/); // inputTokens
  assert.match(html, /500/); // outputTokens
  assert.match(html, /200/); // cacheReadTokens
  assert.match(html, /100/); // cacheWriteTokens
  // Cost formatted as USD
  assert.match(html, /\$0\.0123/);
  // Per-provider totals table also has Cost column
  assert.match(html, /Cost \(USD\)/);
});

test("buildSessionLimitReportHtml omits model attribution from provider totals while preserving mixed-model provider totals", () => {
  const window = { startMs: 0, endMs: Date.now() + 1_000_000, source: "snapshot" };
  const result = {
    rows: [],
    perProviderTotals: [
      {
        provider: "anthropic",
        modelId: "claude-opus-4-1",
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          totalTokens: 1550,
          costUsd: 0.0456,
          turns: 7,
          assistantMessages: 7,
        },
      },
    ],
    grandTotals: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 1550,
      costUsd: 0.0456,
      turns: 7,
      assistantMessages: 7,
    },
    caveats: [],
  };
  const html = buildSessionLimitReportHtml(window, result, makeSnapshot(), Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  assert.match(html, /<h2>Per-provider totals<\/h2>/);
  assert.match(html, /<th>Provider<\/th>/);
  assert.doesNotMatch(html, /<th>Model<\/th>/);
  assert.match(html, />anthropic</);
  assert.match(html, /1,550/);
  assert.match(html, /\$0\.0456/);
  assert.doesNotMatch(html, /claude-opus-4-1/);
});

test("buildSessionLimitReportHtml renders session rows ranked by total tokens", () => {
  const window = { startMs: 0, endMs: Date.now() + 1_000_000, source: "snapshot" };
  // rows are passed in descending order (as aggregateSessionUsage would produce them)
  const rows = [
    {
      filePath: "/sessions/--proj-b--/session2.jsonl",
      fileKind: "primary",
      projectLabel: "proj-b",
      sessionId: "id-large",
      sessionName: "Large session",
      providerTotals: [
        {
          provider: "anthropic",
          modelId: "claude",
          usage: {
            totalTokens: 5000,
            turns: 10,
            inputTokens: 4000,
            outputTokens: 1000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            assistantMessages: 10,
          },
        },
      ],
      windowTotals: {
        inputTokens: 4000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 5000,
        costUsd: 0,
        turns: 10,
        assistantMessages: 10,
      },
      coverage: { assistantMessages: 10, withUsage: 10, withoutUsage: 0 },
      malformedLineCount: 0,
    },
    {
      filePath: "/sessions/--proj-a--/session1.jsonl",
      fileKind: "primary",
      projectLabel: "proj-a",
      sessionId: "id-small",
      sessionName: "Small session",
      providerTotals: [
        {
          provider: "anthropic",
          modelId: "claude",
          usage: {
            totalTokens: 100,
            turns: 1,
            inputTokens: 80,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            assistantMessages: 1,
          },
        },
      ],
      windowTotals: {
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
        costUsd: 0,
        turns: 1,
        assistantMessages: 1,
      },
      coverage: { assistantMessages: 1, withUsage: 1, withoutUsage: 0 },
      malformedLineCount: 0,
    },
  ];
  const result = {
    rows,
    perProviderTotals: [],
    grandTotals: {
      inputTokens: 4080,
      outputTokens: 1020,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5100,
      costUsd: 0,
      turns: 11,
      assistantMessages: 11,
    },
    caveats: [],
  };
  const html = buildSessionLimitReportHtml(window, result, makeSnapshot(), Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  // Both sessions should appear
  assert.match(html, /Large session/);
  assert.match(html, /Small session/);
  // Large session has more tokens and should appear first in rankings
  // (aggregateSessionUsage already sorts; buildSessionLimitReportHtml passes rows as-is)
  const largeIdx = html.indexOf("Large session");
  const smallIdx = html.indexOf("Small session");
  assert.ok(largeIdx < smallIdx, "Large session appears before small session in table");
});

test("buildSessionLimitReportHtml escapes dynamic content to prevent XSS", () => {
  const window = { startMs: 0, endMs: Date.now() + 1_000_000, source: "snapshot" };
  const result = {
    rows: [
      {
        filePath: "/sessions/--proj--/session.jsonl",
        fileKind: "primary",
        projectLabel: "<script>alert(1)</script>",
        sessionId: "id-1",
        sessionName: "<img src=x onerror=alert(2)>",
        providerTotals: [],
        windowTotals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 0,
          assistantMessages: 0,
        },
        coverage: { assistantMessages: 0, withUsage: 0, withoutUsage: 0 },
        malformedLineCount: 0,
      },
    ],
    perProviderTotals: [
      {
        provider: "<b>evil</b>",
        modelId: undefined,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 0,
          assistantMessages: 0,
        },
      },
    ],
    grandTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
      assistantMessages: 0,
    },
    caveats: ["<b>user-controlled caveat</b>"],
  };
  const html = buildSessionLimitReportHtml(window, result, undefined, Date.now(), {
    generatedAt: "2026-05-01T00:00:00Z",
  });

  // XSS content must be escaped
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.match(html, /&lt;b&gt;user-controlled caveat&lt;\/b&gt;/);

  // Raw HTML must not appear
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
});

// ---------------------------------------------------------------------------
// /tokens still works after tokens.ts changes
// ---------------------------------------------------------------------------

test("/tokens still registers successfully after tokens.ts changes", () => {
  const pi = createPiHarness();
  registerTokensCommand(pi, {
    openReport: async () => {},
  });
  const command = pi.commands.get("tokens");
  assert.ok(command, "/tokens command registered");
  assert.ok(typeof command.handler === "function", "handler is a function");
});
