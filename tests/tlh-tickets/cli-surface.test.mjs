import test from "node:test";
import {
  assert,
  chmodSync,
  dirname,
  existsSync,
  join,
  mkdirSync,
  readdirSync,
  runTickets,
  tempFixture,
  ticketEnableArgs,
  writeFileSync,
  writeValidTkLikeCommand,
} from "./test-helpers.mjs";

test("enable validates the requested tk command before writing settings", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const invalidTk = join(fixture.external, "tk");
  writeFileSync(
    invalidTk,
    `#!/usr/bin/env bash
exit 42
`,
  );
  chmodSync(invalidTk, 0o755);

  const result = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "--install-path", invalidTk, "enable"],
    { env: { HOME: fixture.home } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not validate/i);
  assert.equal(existsSync(settings), false);
  assert.deepEqual(readdirSync(fixture.agent), []);
});

test("enable rejects a requested command whose basename is not tk before validation", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const ticket = join(fixture.external, "ticket");
  const sentinel = join(fixture.dir, "ticket-called");
  writeValidTkLikeCommand(ticket, { sentinel });

  const result = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "--install-path", ticket, "enable"],
    { env: { HOME: fixture.home, PATH: "" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /basename.*"tk"/i);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(sentinel), false);
});

test("status does not report an enabled non-tk configured command as active", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const ticket = join(fixture.external, "ticket");
  const sentinel = join(fixture.dir, "ticket-called");
  writeValidTkLikeCommand(ticket, { sentinel });
  writeFileSync(
    settings,
    `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: ticket } } })}\n`,
  );

  const result = runTickets(["--settings", settings, "--agent-dir", fixture.agent, "status"], {
    env: { HOME: fixture.home, PATH: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /active: no/);
  assert.match(result.stdout, /command: not found/);
  assert.equal(existsSync(sentinel), false);
});

test("status treats unset settings with a valid tk command as active by default", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const managedTk = join(fixture.agent, "bin", "tk");
  mkdirSync(dirname(managedTk), { recursive: true });
  writeValidTkLikeCommand(managedTk);

  const result = runTickets(["--settings", settings, "--agent-dir", fixture.agent, "status"], {
    env: { HOME: fixture.home, PATH: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setting: unset/);
  assert.match(result.stdout, /active: yes/);
  assert.ok(result.stdout.includes(`  command: ${managedTk}`));
  assert.doesNotMatch(result.stdout, /tlh tickets enable/);
  assert.equal(existsSync(settings), false);
});

test("status treats explicit legacy disabled settings as enabled", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const managedTk = join(fixture.agent, "bin", "tk");
  mkdirSync(dirname(managedTk), { recursive: true });
  writeValidTkLikeCommand(managedTk);
  writeFileSync(settings, `${JSON.stringify({ tlh: { tickets: { enabled: false } } })}\n`);

  const result = runTickets(["--settings", settings, "--agent-dir", fixture.agent, "status"], {
    env: { HOME: fixture.home, PATH: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setting: enabled/);
  assert.match(result.stdout, /active: yes/);
  assert.ok(result.stdout.includes(`  command: ${managedTk}`));
  assert.doesNotMatch(result.stdout, /disabled|tlh tickets enable/i);
});

test("help advertises only supported user-facing ticket commands and options", () => {
  const fixture = tempFixture();

  const help = runTickets(["--help"], { env: { HOME: fixture.home } });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /status\s+Show integration status/);
  assert.match(help.stdout, /enable\s+Enable tk integration/);
  assert.match(help.stdout, /--settings <path>/);
  assert.match(help.stdout, /--agent-dir <dir>/);
  assert.match(help.stdout, /--install-path <p>/);
  for (const hiddenSurface of [
    /disable\s+Disable tk integration/,
    /state\s+Print enabled/,
    /validate \[path\]/,
    /install-managed/,
    /configure-install/,
    /configure-install-style/,
    /--target/,
    /--mode/,
    /--wrapper-name/,
    /--detail/,
    /--dry-run/,
    /--quiet/,
    /--unsafe-test-ticket-source-url/,
    /--unsafe-test-ticket-source-sha256/,
    /--unsafe-test-ticket-archive-entry/,
  ]) {
    assert.doesNotMatch(help.stdout, hiddenSurface);
  }
});

test("legacy ticket commands and options are unavailable", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const ticket = join(fixture.external, "ticket");
  const sentinel = join(fixture.dir, "ticket-called");
  writeValidTkLikeCommand(ticket, { sentinel });

  for (const command of ["state", "validate", "configure-install-style"]) {
    const result = runTickets(
      ["--settings", settings, "--agent-dir", fixture.agent, command, ticket],
      {
        env: { HOME: fixture.home, PATH: "" },
      },
    );
    assert.notEqual(result.status, 0, `expected ${command} to fail`);
    assert.match(result.stderr, new RegExp(`Unknown command: ${command}`));
  }

  const modeResult = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "--mode", "auto", "configure-install"],
    { env: { HOME: fixture.home, PATH: "" } },
  );
  assert.notEqual(modeResult.status, 0);
  assert.match(modeResult.stderr, /Unknown option: --mode/);

  const disableResult = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "disable"],
    {
      env: { HOME: fixture.home },
    },
  );
  assert.notEqual(disableResult.status, 0);
  assert.match(disableResult.stderr, /disable is no longer supported/);

  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(sentinel), false);
});

test("enable refuses to write settings under the normal Pi agent profile", () => {
  const fixture = tempFixture();
  const normalPiAgent = join(fixture.home, ".pi", "agent");
  mkdirSync(normalPiAgent, { recursive: true });
  const settings = join(normalPiAgent, "settings.json");

  const result = runTickets(ticketEnableArgs(fixture, settings), { env: { HOME: fixture.home } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normal Pi config/i);
  assert.equal(existsSync(settings), false);
  assert.deepEqual(readdirSync(normalPiAgent), []);
});
