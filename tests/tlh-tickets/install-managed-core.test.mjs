import test from "node:test";
import {
  assert,
  createTicketArchive,
  dirname,
  existsSync,
  fixtureTicketSourceUrl,
  join,
  mkdirSync,
  readFileSync,
  readdirSync,
  runTickets,
  spawnSync,
  statSync,
  symlinkDirectory,
  tempFixture,
  unsafeTicketSourceArgs,
  writeFetchPreload,
  writeFileSync,
  writePoisonCommand,
  writeSwapAgentRootBeforeLstatPreload,
} from "./test-helpers.mjs";

test(
  "install-managed installs only tk from a verified ticket source archive passed with explicit test-only flags",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const { archivePath, checksum, ticketContent } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = writeFetchPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");

    const result = runTickets(
      [
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum }),
        "install-managed",
      ],
      {
        env: {
          HOME: fixture.home,
          TLH_TEST_ARCHIVE: archivePath,
          TLH_TEST_FETCH_SENTINEL: fetchSentinel,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(readFileSync(target, "utf8"), ticketContent);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(join(fixture.agent, "bin")), ["tk"]);
    assert.deepEqual(
      readdirSync(dirname(target)).filter((entry) => entry.startsWith(".tlh-tickets-")),
      [],
    );

    const validation = spawnSync(target, ["help"], { encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /Usage: tk/);
  },
);

test("install-managed dry-run ignores inherited ticket source environment overrides", () => {
  const fixture = tempFixture();
  const target = join(fixture.agent, "bin", "tk");

  const result = runTickets(
    ["--agent-dir", fixture.agent, "--target", target, "--dry-run", "install-managed"],
    {
      env: {
        HOME: fixture.home,
        TLH_TICKET_SOURCE_URL: "https://attacker.example/ticket.tar.gz",
        TLH_TICKET_SOURCE_SHA256: "not-a-sha256",
        TLH_TICKET_ARCHIVE_ENTRY: "../attacker/ticket",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), target);
  assert.match(
    result.stderr,
    /https:\/\/github\.com\/wedow\/ticket\/archive\/refs\/tags\/v0\.3\.2\.tar\.gz/,
  );
  assert.match(result.stderr, /5d4c82ed1c5cb4a2aeb63b47c3c8931738c3287e555f43bf831d3d323687db0f/);
  assert.doesNotMatch(result.stderr, /attacker\.example|not-a-sha256|\.\.\/attacker/);
  assert.equal(existsSync(target), false);
});

test(
  "install-managed uses fallback helper PATH when sanitized PATH would otherwise be empty",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const ticketContent = `#!/usr/bin/env sh
command_name="$(basename "$0")"
case "\${1:-}" in
  help|--help|-h)
    echo "\${command_name} - minimal ticket system with dependency tracking"
    echo "Usage: \${command_name} <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`;
    const { archivePath, checksum } = createTicketArchive(fixture, { ticketContent });
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const tarSentinel = join(fixture.dir, "tar-intercepted");
    const shSentinel = join(fixture.dir, "sh-intercepted");
    const preload = writeFetchPreload(fixture);
    const agentBin = join(fixture.agent, "bin");
    const target = join(agentBin, "tk");
    writePoisonCommand(agentBin, "tar", tarSentinel);
    writePoisonCommand(agentBin, "sh", shSentinel);

    const result = runTickets(
      [
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum }),
        "install-managed",
      ],
      {
        cwd: agentBin,
        env: {
          HOME: fixture.home,
          PATH: agentBin,
          TLH_TEST_ARCHIVE: archivePath,
          TLH_TEST_FETCH_SENTINEL: fetchSentinel,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(existsSync(tarSentinel), false);
    assert.equal(existsSync(shSentinel), false);
    assert.equal(readFileSync(target, "utf8"), ticketContent);
  },
);

test("install-managed rejects dash-leading archive entry components before fetch", () => {
  const fixture = tempFixture();
  const fetchSentinel = join(fixture.dir, "fetch-called");
  const preload = join(fixture.dir, "fail-fetch.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`,
  );

  const result = runTickets(
    [
      "--agent-dir",
      fixture.agent,
      "--unsafe-test-ticket-archive-entry",
      "ticket-0.3.2/-ticket",
      "install-managed",
    ],
    {
      env: { HOME: fixture.home },
      nodeArgs: ["--import", preload],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ticket archive entry is unsafe: ticket-0\.3\.2\/-ticket/);
  assert.equal(existsSync(fetchSentinel), false);
});

test("install-managed rejects non-https ticket source URLs before fetch", () => {
  for (const url of ["http://example.test/ticket.tar.gz", "file:///tmp/ticket.tar.gz"]) {
    const fixture = tempFixture();
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = join(fixture.dir, "fail-fetch.mjs");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`,
    );

    const result = runTickets(
      ["--agent-dir", fixture.agent, "--unsafe-test-ticket-source-url", url, "install-managed"],
      {
        env: { HOME: fixture.home },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0, `expected non-zero exit for ${url}`);
    const expectedPrefix = url.slice(0, url.indexOf("://") + 3);
    assert.match(
      result.stderr,
      /Ticket source URL must use https:\/\//,
      `expected https:// guidance in stderr for ${url}: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes(`(got: ${expectedPrefix})`),
      `expected stderr to mention prefix ${expectedPrefix} for ${url}: ${result.stderr}`,
    );
    assert.equal(existsSync(fetchSentinel), false, `fetch should not be called for ${url}`);
  }
});

test("install-managed rejects non-tk managed target before fetch or overwrite", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const originalSettings = `{"tlh":{"tickets":{"enabled":false}}}\n`;
  writeFileSync(settings, originalSettings);

  const fetchSentinel = join(fixture.dir, "fetch-called");
  const preload = join(fixture.dir, "fail-fetch.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`,
  );

  const result = runTickets(
    ["--agent-dir", fixture.agent, "--target", settings, "install-managed"],
    {
      env: { HOME: fixture.home },
      nodeArgs: ["--import", preload],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target basename.*exactly "tk"/i);
  assert.equal(readFileSync(settings, "utf8"), originalSettings);
  assert.equal(existsSync(fetchSentinel), false);
});

test(
  "install-managed rejects agent bin symlink before network or writes",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = join(fixture.dir, "fail-fetch.mjs");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`,
    );

    const result = runTickets(
      [
        "--agent-dir",
        fixture.agent,
        "--target",
        join(fixture.agent, "bin", "tk"),
        "install-managed",
      ],
      {
        env: { HOME: fixture.home },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked target parent component/i);
    assert.equal(existsSync(fetchSentinel), false);
    assert.deepEqual(readdirSync(fixture.external), []);
  },
);

test(
  "install-managed rejects agent root swapped to an external symlink before plan capture",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const externalBin = join(fixture.external, "bin");
    const externalTk = join(externalBin, "tk");
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = writeSwapAgentRootBeforeLstatPreload(fixture);
    mkdirSync(externalBin, { recursive: true });
    writeFileSync(externalTk, "external tk sentinel");

    const result = runTickets(
      [
        "--agent-dir",
        fixture.agent,
        "--target",
        join(fixture.agent, "bin", "tk"),
        "install-managed",
      ],
      {
        env: {
          HOME: fixture.home,
          TLH_TEST_SWAP_AGENT_ROOT: fixture.agent,
          TLH_TEST_EXTERNAL: fixture.external,
          TLH_TEST_FETCH_SENTINEL: fetchSentinel,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked managed agent root|changed while planning/i);
    assert.equal(existsSync(fetchSentinel), false);
    assert.equal(readFileSync(externalTk, "utf8"), "external tk sentinel");
  },
);

test("install-managed rejects normal Pi agent dir before network or writes", () => {
  const fixture = tempFixture();
  const normalPiAgent = join(fixture.home, ".pi", "agent");
  mkdirSync(normalPiAgent, { recursive: true });

  const fetchSentinel = join(fixture.dir, "fetch-called");
  const preload = join(fixture.dir, "fail-fetch.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`,
  );

  const result = runTickets(["--agent-dir", normalPiAgent, "install-managed"], {
    env: { HOME: fixture.home },
    nodeArgs: ["--import", preload],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normal Pi config/i);
  assert.equal(existsSync(fetchSentinel), false);
  assert.deepEqual(readdirSync(normalPiAgent), []);
});

test("install-managed dry-run rejects a managed target equal to a missing agent root", () => {
  const fixture = tempFixture();
  const missingAgent = join(fixture.dir, "missing-agent");

  const result = runTickets(
    ["--agent-dir", missingAgent, "--target", missingAgent, "--dry-run", "install-managed"],
    {
      env: { HOME: fixture.home },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile directory/i);
  assert.doesNotMatch(result.stderr, /Would install tk/i);
  assert.equal(existsSync(missingAgent), false);
});
