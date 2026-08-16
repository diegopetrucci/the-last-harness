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
  runTickets,
  tempFixture,
  unsafeTicketSourceArgs,
  writeFetchPreload,
  writeFileSync,
  writeValidTkLikeCommand,
} from "./test-helpers.mjs";

test("configure-install re-enables legacy disabled ticket settings", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const customTk = join(fixture.external, "tk");
  writeValidTkLikeCommand(customTk);
  writeFileSync(
    settings,
    `${JSON.stringify({ tlh: { tickets: { enabled: false, installPath: customTk } } })}\n`,
  );

  const configured = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "configure-install"],
    {
      env: { HOME: fixture.home, PATH: "" },
    },
  );

  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /enabled/);
  const written = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(written.tlh.tickets.enabled, true);
  assert.equal(written.tlh.tickets.installPath, customTk);

  const status = runTickets(["--settings", settings, "--agent-dir", fixture.agent, "status"], {
    env: { HOME: fixture.home },
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /setting: enabled/);
});

test("configure-install fails when no valid tk is available and managed install fails", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const preload = join(fixture.dir, "fail-fetch.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async () => { throw new Error("managed tk unavailable"); };\n`,
  );

  const result = runTickets(
    ["--settings", settings, "--agent-dir", fixture.agent, "configure-install"],
    {
      env: { HOME: fixture.home, PATH: "" },
      nodeArgs: ["--import", preload],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tk ticket integration is required/);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(join(fixture.home, ".pi")), false);
});

test(
  "configure-install with fresh managed install records installedSha256 in settings",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const settings = join(fixture.agent, "settings.json");
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = writeFetchPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");

    const result = runTickets(
      [
        "--settings",
        settings,
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum }),
        "configure-install",
      ],
      {
        env: {
          HOME: fixture.home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TLH_TEST_ARCHIVE: archivePath,
          TLH_TEST_FETCH_SENTINEL: fetchSentinel,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.tlh.tickets.enabled, true);
    assert.equal(written.tlh.tickets.installPath, target);
    assert.equal(written.tlh.tickets.installedSha256, checksum.toLowerCase());
  },
);

test(
  "configure-install reinstalls managed tk when installedSha256 does not match the canonical pin",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const settings = join(fixture.agent, "settings.json");
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = writeFetchPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");
    mkdirSync(dirname(target), { recursive: true });
    writeValidTkLikeCommand(target);
    const staleSha = "0".repeat(64);
    writeFileSync(
      settings,
      `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: target, installedSha256: staleSha } } })}\n`,
    );

    const result = runTickets(
      [
        "--settings",
        settings,
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum }),
        "configure-install",
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
    assert.equal(
      readFileSync(fetchSentinel, "utf8"),
      fixtureTicketSourceUrl,
      "expected reinstall to fetch the pinned archive",
    );
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.tlh.tickets.enabled, true);
    assert.equal(written.tlh.tickets.installPath, target);
    assert.equal(written.tlh.tickets.installedSha256, checksum.toLowerCase());
    assert.notEqual(written.tlh.tickets.installedSha256, staleSha);
  },
);

test(
  "configure-install clears stale managed installedSha256 when reinstall fails and old managed tk is reused",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const settings = join(fixture.agent, "settings.json");
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = join(fixture.dir, "fail-fetch.mjs");
    const target = join(fixture.agent, "bin", "tk");
    mkdirSync(dirname(target), { recursive: true });
    writeValidTkLikeCommand(target);
    const staleSha = "0".repeat(64);
    const nextSha = "b".repeat(64);
    writeFileSync(
      settings,
      `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: target, installedSha256: staleSha } } })}\n`,
    );
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";
globalThis.fetch = async (url) => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, String(url));
	throw new Error("managed tk unavailable");
};
`,
    );

    const result = runTickets(
      [
        "--settings",
        settings,
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum: nextSha }),
        "configure-install",
      ],
      {
        env: { HOME: fixture.home },
        nodeArgs: ["--import", preload],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(fetchSentinel, "utf8"),
      fixtureTicketSourceUrl,
      "expected reinstall to be attempted before reusing the old managed tk",
    );
    assert.match(result.stderr, /tk pin changed but reinstall failed/);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.tlh.tickets.enabled, true);
    assert.equal(written.tlh.tickets.installPath, target);
    assert.equal(Object.hasOwn(written.tlh.tickets, "installedSha256"), false);
  },
);

test(
  "configure-install reinstalls managed tk for legacy installs missing installedSha256",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const settings = join(fixture.agent, "settings.json");
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const preload = writeFetchPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");
    mkdirSync(dirname(target), { recursive: true });
    writeValidTkLikeCommand(target);
    writeFileSync(
      settings,
      `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: target } } })}\n`,
    );

    const result = runTickets(
      [
        "--settings",
        settings,
        "--agent-dir",
        fixture.agent,
        "--target",
        target,
        ...unsafeTicketSourceArgs({ checksum }),
        "configure-install",
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
    assert.equal(
      readFileSync(fetchSentinel, "utf8"),
      fixtureTicketSourceUrl,
      "expected legacy install to be reinstalled once",
    );
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.tlh.tickets.enabled, true);
    assert.equal(written.tlh.tickets.installPath, target);
    assert.equal(written.tlh.tickets.installedSha256, checksum.toLowerCase());
  },
);

test("configure-install with a custom installPath does not write installedSha256 and clears any stale value", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const customTk = join(fixture.external, "tk");
  writeValidTkLikeCommand(customTk);
  const staleSha = "a".repeat(64);
  writeFileSync(
    settings,
    `${JSON.stringify({ tlh: { tickets: { installPath: customTk, installedSha256: staleSha } } })}\n`,
  );

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
    ["--settings", settings, "--agent-dir", fixture.agent, "configure-install"],
    {
      env: { HOME: fixture.home },
      nodeArgs: ["--import", preload],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fetchSentinel), false, "custom installPath must not trigger a reinstall");
  const written = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(written.tlh.tickets.enabled, true);
  assert.equal(written.tlh.tickets.installPath, customTk);
  assert.equal(Object.hasOwn(written.tlh.tickets, "installedSha256"), false);
});

test("configure-install does not reinstall managed tk when installedSha256 already matches the canonical pin", () => {
  const fixture = tempFixture();
  const settings = join(fixture.agent, "settings.json");
  const { checksum } = createTicketArchive(fixture);
  const target = join(fixture.agent, "bin", "tk");
  mkdirSync(dirname(target), { recursive: true });
  writeValidTkLikeCommand(target);
  writeFileSync(
    settings,
    `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: target, installedSha256: checksum } } })}\n`,
  );

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
      "--settings",
      settings,
      "--agent-dir",
      fixture.agent,
      "--target",
      target,
      ...unsafeTicketSourceArgs({ checksum }),
      "configure-install",
    ],
    {
      env: { HOME: fixture.home },
      nodeArgs: ["--import", preload],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fetchSentinel), false, "fresh pin must not trigger a reinstall");
  const written = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(written.tlh.tickets.installedSha256, checksum.toLowerCase());
});
