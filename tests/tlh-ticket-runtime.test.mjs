import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { activateTlhTicketRuntime, activateTlhTicketSessionScope } = await jiti.import(
  "../extensions/the-last-harness/tickets.ts",
);

function resetTicketRuntimeTestState() {
  delete process.env.TICKETS_DIR;
}

test.beforeEach(resetTicketRuntimeTestState);
test.afterEach(resetTicketRuntimeTestState);

function tempFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tlh-ticket-runtime-test-"));
  const agent = join(dir, "agent");
  const external = join(dir, "external");
  mkdirSync(agent, { recursive: true });
  mkdirSync(external, { recursive: true });
  return { dir, agent, external };
}

function writeFakeTk(path, label) {
  writeFileSync(
    path,
    `#!/bin/sh
case "\${1:-}" in
  help|--help|-h)
    echo "tk - ${label} ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    echo "${label}:\${1:-}"
    exit 0
    ;;
esac
`,
  );
  chmodSync(path, 0o755);
}

function writeFakeGit(path, logPath, repoRoots) {
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\n' "$PWD" >> ${JSON.stringify(logPath)}
if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "--show-toplevel" ]; then
  case "$PWD" in
${repoRoots.map(({ repoRoot, nestedCwd }) => `    ${JSON.stringify(nestedCwd)}|${JSON.stringify(repoRoot)}) printf '%s\\n' ${JSON.stringify(repoRoot)}; exit 0 ;;`).join("\n")}
  esac
fi
exit 1
`,
  );
  chmodSync(path, 0o755);
}

function withPath(path, fn) {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path;
    return fn();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

function pathEntries() {
  return (process.env.PATH || "").split(delimiter).filter(Boolean);
}

function withTicketsDir(value, fn) {
  const previous = process.env.TICKETS_DIR;
  try {
    if (value === undefined) {
      delete process.env.TICKETS_DIR;
    } else {
      process.env.TICKETS_DIR = value;
    }
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TICKETS_DIR;
    } else {
      process.env.TICKETS_DIR = previous;
    }
  }
}

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}

test(
  "ticket session scope resolves nested git worktrees to repo .tickets and ignores ancestor stores",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const repoRoot = join(fixture.dir, "repo");
    const nestedCwd = join(repoRoot, "packages", "app");
    mkdirSync(join(fixture.dir, ".tickets"), { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(join(fixture.dir, ".tickets", "ignored.md"), "ignore\n");
    runGit(repoRoot, "init");

    withTicketsDir(undefined, () => {
      const expected = join(realpathSync(repoRoot), ".tickets");
      const scoped = activateTlhTicketSessionScope(nestedCwd);
      assert.equal(scoped, expected);
      assert.equal(process.env.TICKETS_DIR, expected);
    });
  },
);

test(
  "ticket session scope falls back to cwd outside git and preserves explicit TICKETS_DIR",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const outsideGit = join(fixture.dir, "scratch");
    mkdirSync(outsideGit, { recursive: true });

    withTicketsDir(undefined, () => {
      assert.equal(activateTlhTicketSessionScope(outsideGit), join(outsideGit, ".tickets"));
      assert.equal(process.env.TICKETS_DIR, join(outsideGit, ".tickets"));
    });

    withTicketsDir(join(fixture.dir, "custom-tickets"), () => {
      assert.equal(activateTlhTicketSessionScope(outsideGit), join(fixture.dir, "custom-tickets"));
      assert.equal(process.env.TICKETS_DIR, join(fixture.dir, "custom-tickets"));
    });
  },
);

test(
  "ticket session scope reuses the same cwd but updates for a different cwd",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const firstRepo = join(fixture.dir, "repo-one");
    const secondRepo = join(fixture.dir, "repo-two");
    const firstNestedCwd = join(firstRepo, "packages", "app");
    const secondNestedCwd = join(secondRepo, "packages", "app");
    const fakeBin = join(fixture.dir, "fake-bin");
    const gitLog = join(fixture.dir, "git.log");
    mkdirSync(firstNestedCwd, { recursive: true });
    mkdirSync(secondNestedCwd, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    runGit(firstRepo, "init");
    runGit(secondRepo, "init");
    writeFakeGit(join(fakeBin, "git"), gitLog, [
      { repoRoot: realpathSync(firstRepo), nestedCwd: realpathSync(firstNestedCwd) },
      { repoRoot: realpathSync(secondRepo), nestedCwd: realpathSync(secondNestedCwd) },
    ]);

    withTicketsDir(undefined, () => {
      const firstExpected = join(realpathSync(firstRepo), ".tickets");
      const secondExpected = join(realpathSync(secondRepo), ".tickets");
      withPath([fakeBin, process.env.PATH || ""].filter(Boolean).join(delimiter), () => {
        const firstRealNestedCwd = realpathSync(firstNestedCwd);
        const secondRealNestedCwd = realpathSync(secondNestedCwd);
        assert.equal(activateTlhTicketSessionScope(firstNestedCwd), firstExpected);
        assert.equal(activateTlhTicketSessionScope(firstNestedCwd), firstExpected);
        assert.deepEqual(readFileSync(gitLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
          firstRealNestedCwd,
        ]);

        assert.equal(activateTlhTicketSessionScope(secondNestedCwd), secondExpected);
        assert.deepEqual(readFileSync(gitLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
          firstRealNestedCwd,
          secondRealNestedCwd,
        ]);
      });
    });
  },
);

test(
  "ticket session scope updates prior auto-scoped dirs but preserves explicit TICKETS_DIR",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const firstRepo = join(fixture.dir, "repo-one");
    const secondRepo = join(fixture.dir, "repo-two");
    const firstNestedCwd = join(firstRepo, "packages", "app");
    const secondNestedCwd = join(secondRepo, "packages", "app");
    mkdirSync(firstNestedCwd, { recursive: true });
    mkdirSync(secondNestedCwd, { recursive: true });
    const explicitTicketsDir = join(fixture.dir, "custom-tickets");
    mkdirSync(explicitTicketsDir, { recursive: true });
    mkdirSync(join(fixture.dir, ".tickets"), { recursive: true });
    writeFileSync(join(fixture.dir, ".tickets", "ignored.md"), "ignore\n");
    writeFileSync(join(explicitTicketsDir, "keep.md"), "keep\n");
    writeFileSync(join(firstRepo, "README.md"), "first\n");
    writeFileSync(join(secondRepo, "README.md"), "second\n");
    runGit(firstRepo, "init");
    runGit(secondRepo, "init");

    withTicketsDir(undefined, () => {
      const firstExpected = join(realpathSync(firstRepo), ".tickets");
      const secondExpected = join(realpathSync(secondRepo), ".tickets");
      assert.equal(activateTlhTicketSessionScope(firstNestedCwd), firstExpected);
      assert.equal(process.env.TICKETS_DIR, firstExpected);

      assert.equal(activateTlhTicketSessionScope(secondNestedCwd), secondExpected);
      assert.equal(process.env.TICKETS_DIR, secondExpected);
    });

    withTicketsDir(explicitTicketsDir, () => {
      assert.equal(activateTlhTicketSessionScope(firstNestedCwd), explicitTicketsDir);
      assert.equal(process.env.TICKETS_DIR, explicitTicketsDir);
    });
  },
);

test(
  "ticket runtime prepends an external configured tk path outside PATH",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const externalTk = join(fixture.external, "tk");
    writeFakeTk(externalTk, "external-configured");

    withPath("", () => {
      const command = activateTlhTicketRuntime(
        { tlh: { tickets: { installPath: externalTk } } },
        fixture.agent,
      );

      assert.equal(command, externalTk);
      assert.deepEqual(pathEntries(), [fixture.external]);

      const result = spawnSync("tk", ["status"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /external-configured:status/);
    });
  },
);

test(
  "ticket runtime treats legacy disabled settings as enabled",
  { skip: process.platform === "win32" },
  () => {
    const fixture = tempFixture();
    const externalTk = join(fixture.external, "tk");
    writeFakeTk(externalTk, "legacy-disabled-configured");

    withPath("", () => {
      const command = activateTlhTicketRuntime(
        { tlh: { tickets: { enabled: false, installPath: externalTk } } },
        fixture.agent,
      );

      assert.equal(command, externalTk);
      assert.deepEqual(pathEntries(), [fixture.external]);

      const result = spawnSync("tk", ["status"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /legacy-disabled-configured:status/);
    });
  },
);

test(
  "ticket runtime prepends managed agent bin tk when no external path is configured",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const managedBin = join(fixture.agent, "bin");
    mkdirSync(managedBin, { recursive: true });
    writeFakeTk(join(managedBin, "tk"), "managed-agent-bin");

    withPath("", () => {
      const command = activateTlhTicketRuntime({}, fixture.agent);

      assert.equal(command, join(managedBin, "tk"));
      assert.deepEqual(pathEntries(), [managedBin]);

      const result = spawnSync("tk", ["ready"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /managed-agent-bin:ready/);
    });
  },
);

test(
  "spawned tk commands inherit the session ticket scope",
  { skip: process.platform === "win32" },
  () => {
    const fixture = tempFixture();
    const repoRoot = join(fixture.dir, "repo");
    const nestedCwd = join(repoRoot, "nested");
    const managedBin = join(fixture.agent, "bin");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(managedBin, { recursive: true });
    runGit(repoRoot, "init");
    writeFileSync(
      join(managedBin, "tk"),
      `#!/bin/sh
case "\${1:-}" in
  help|--help|-h)
    echo "tk - inherited ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    printf '%s\n' "\${TICKETS_DIR:-unset}"
    exit 0
    ;;
esac
`,
    );
    chmodSync(join(managedBin, "tk"), 0o755);

    withTicketsDir(undefined, () => {
      const expected = join(realpathSync(repoRoot), ".tickets");
      activateTlhTicketSessionScope(nestedCwd);
      withPath("", () => {
        const command = activateTlhTicketRuntime({}, fixture.agent, nestedCwd);
        assert.equal(command, join(managedBin, "tk"));
        assert.equal(process.env.TICKETS_DIR, expected);

        const result = spawnSync("tk", ["status"], { cwd: nestedCwd, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.equal(result.stdout.trim(), expected);
      });
    });
  },
);

test(
  "ticket runtime ignores configured commands whose basename is not tk",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const externalTicket = join(fixture.external, "ticket");
    const sentinel = join(fixture.dir, "non-tk-called");
    writeFileSync(
      externalTicket,
      `#!/bin/sh
printf called > ${JSON.stringify(sentinel)}
echo "Usage: tk <command> [args]"
echo "ticket system"
exit 0
`,
    );
    chmodSync(externalTicket, 0o755);

    withPath("", () => {
      const command = activateTlhTicketRuntime(
        { tlh: { tickets: { installPath: externalTicket } } },
        fixture.agent,
      );

      assert.equal(command, undefined);
      assert.equal(process.env.PATH, "");
      assert.equal(existsSync(sentinel), false);
    });
  },
);
