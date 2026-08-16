import test from "node:test";
import {
  assert,
  createTicketArchive,
  existsSync,
  fixtureTicketSourceUrl,
  join,
  readFileSync,
  readdirSync,
  runTickets,
  statSync,
  tempFixture,
  unsafeTicketSourceArgs,
  writeFetchAndSwapParentBeforeMkdirPreload,
  writeFetchAndSwapTargetParentBeforeOpenPreload,
  writeFetchAndSwapTargetParentBeforeSecondRealpathPreload,
  writeFileSync,
} from "./test-helpers.mjs";

test(
  "install-managed direct commit refuses parent swap before open without touching external sentinels",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const externalSettings = join(fixture.external, "settings.json");
    const externalTk = join(fixture.external, "tk");
    const preload = writeFetchAndSwapTargetParentBeforeOpenPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");
    writeFileSync(externalSettings, "original settings sentinel");
    writeFileSync(externalTk, "original tk sentinel");

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
          TLH_TEST_SWAP_OPEN_PATH: target,
          TLH_TEST_EXTERNAL: fixture.external,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
    assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
  },
);

test(
  "install-managed removes empty file created by parent swap to external directory",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const externalSettings = join(fixture.external, "settings.json");
    const externalTk = join(fixture.external, "tk");
    const preload = writeFetchAndSwapTargetParentBeforeOpenPreload(fixture);
    const target = join(fixture.agent, "bin", "tk");
    writeFileSync(externalSettings, "original settings sentinel");

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
          TLH_TEST_SWAP_OPEN_PATH: target,
          TLH_TEST_EXTERNAL: fixture.external,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
    assert.equal(existsSync(externalTk), false);
    assert.deepEqual(readdirSync(fixture.external), ["settings.json"]);
  },
);

test(
  "install-managed does not clean up a managed bin directory when parent revalidation fails",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const externalSettings = join(fixture.external, "settings.json");
    const externalTk = join(fixture.external, "tk");
    const externalBin = join(fixture.external, "bin");
    const preload = writeFetchAndSwapParentBeforeMkdirPreload(fixture);
    const targetParent = join(fixture.agent, "bin");
    const target = join(targetParent, "tk");
    writeFileSync(externalSettings, "original settings sentinel");
    writeFileSync(externalTk, "original tk sentinel");

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
          TLH_TEST_SWAP_MKDIR_PATH: targetParent,
          TLH_TEST_EXTERNAL: fixture.external,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the intended directory|symlinked/i);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
    assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
    assert.equal(statSync(externalBin).isDirectory(), true);
    assert.deepEqual(readdirSync(externalBin), []);
    assert.deepEqual(readdirSync(fixture.external).sort(), ["bin", "settings.json", "tk"]);
  },
);

test(
  "install-managed refuses parent swap before intended parent realpath capture",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture();
    const { archivePath, checksum } = createTicketArchive(fixture);
    const fetchSentinel = join(fixture.dir, "fetch-called");
    const externalSettings = join(fixture.external, "settings.json");
    const externalTk = join(fixture.external, "tk");
    const preload = writeFetchAndSwapTargetParentBeforeSecondRealpathPreload(fixture);
    const targetParent = join(fixture.agent, "bin");
    const target = join(targetParent, "tk");
    writeFileSync(externalSettings, "original settings sentinel");
    writeFileSync(externalTk, "original tk sentinel");

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
          TLH_TEST_SWAP_REALPATH_PATH: targetParent,
          TLH_TEST_EXTERNAL: fixture.external,
        },
        nodeArgs: ["--import", preload],
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /intended target parent|isolated tlh profile|symlinked/i);
    assert.equal(readFileSync(fetchSentinel, "utf8"), fixtureTicketSourceUrl);
    assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
    assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
    assert.deepEqual(readdirSync(fixture.external).sort(), ["settings.json", "tk"]);
  },
);
