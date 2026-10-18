import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { attestSessionMirrorSession, attestSessionMirrorSessionCore } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/profile-attestation.ts",
);

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-session-attestation-"));
  const home = join(root, "home");
  const agent = join(root, "agent");
  const accountHome = join(root, "account-home");
  const sessions = join(agent, "sessions");
  mkdirSync(home, { recursive: true });
  mkdirSync(accountHome, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, accountHome, agent, sessions };
}

function baseFileSystem() {
  return {
    lstat: (path) => lstatSync(path),
    realpath: (path) => realpathSync.native(path),
  };
}

function dependencies(fixture, overrides = {}) {
  return {
    env: {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...overrides.env,
    },
    getAgentDir: overrides.getAgentDir ?? (() => fixture.agent),
    getAccountHome: overrides.getAccountHome ?? (() => fixture.accountHome),
    fileSystem: overrides.fileSystem ?? baseFileSystem(),
  };
}

function attest(fixture, sessionFile, overrides = {}) {
  return attestSessionMirrorSessionCore({ sessionFile }, dependencies(fixture, overrides));
}

function assertFailure(result, reason) {
  assert.deepEqual(result, { ok: false, reason });
  assert.equal(JSON.stringify(result).includes("tlh-session-attestation"), false);
}

test("attests an existing regular session file without exposing metadata", (t) => {
  const fixture = makeFixture(t);
  const sessionFile = join(fixture.sessions, "session.jsonl");
  writeFileSync(sessionFile, "fixture content\n", "utf8");

  const result = attest(fixture, sessionFile);

  assert.deepEqual(result, { ok: true, phase: "session-file" });
  assert.deepEqual(Object.keys(result), ["ok", "phase"]);
});

test("attests a safe parent before the session file exists and re-attests creation", (t) => {
  const fixture = makeFixture(t);
  const sessionFile = join(fixture.sessions, "future.jsonl");

  assert.deepEqual(attest(fixture, sessionFile), { ok: true, phase: "directory-only" });

  writeFileSync(sessionFile, "fixture content\n", "utf8");
  assert.deepEqual(attest(fixture, sessionFile), { ok: true, phase: "session-file" });
});

test("rejects missing profile selection, home, and ephemeral sessions", (t) => {
  const fixture = makeFixture(t);
  const sessionFile = join(fixture.sessions, "session.jsonl");

  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile },
      dependencies(fixture, { env: { PI_CODING_AGENT_DIR: undefined } }),
    ),
    "missing-profile-selection",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile },
      dependencies(fixture, { env: { HOME: undefined }, getAccountHome: () => undefined }),
    ),
    "missing-home",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: undefined },
      dependencies(fixture, {
        env: { PI_CODING_AGENT_DIR: undefined, HOME: undefined, USERPROFILE: undefined },
        getAccountHome: () => undefined,
      }),
    ),
    "ephemeral-session",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile },
      dependencies(fixture, { getAccountHome: () => undefined }),
    ),
    "unsafe-profile-metadata",
  );
});

test("rejects the default profile and profiles resolving inside normal Pi config", (t) => {
  const fixture = makeFixture(t);
  const normalPi = join(fixture.home, ".pi");
  const normalAgent = join(normalPi, "agent");
  const nestedNormalAgent = join(normalPi, "nested-agent");
  mkdirSync(normalAgent, { recursive: true });
  mkdirSync(nestedNormalAgent, { recursive: true });

  const normalSession = join(normalAgent, "session.jsonl");
  const nestedSession = join(nestedNormalAgent, "session.jsonl");
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: normalSession },
      dependencies(fixture, {
        env: { PI_CODING_AGENT_DIR: normalAgent },
        getAgentDir: () => normalAgent,
      }),
    ),
    "default-or-normal-profile",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: nestedSession },
      dependencies(fixture, {
        env: { PI_CODING_AGENT_DIR: nestedNormalAgent },
        getAgentDir: () => nestedNormalAgent,
      }),
    ),
    "default-or-normal-profile",
  );
});

test("protects every environment and account home normal Pi root", (t) => {
  const fixture = makeFixture(t);
  const fakeHome = join(fixture.root, "fake-home");
  const userProfileHome = join(fixture.root, "user-profile-home");
  const accountNormalAgent = join(fixture.accountHome, ".pi", "agent");
  const userProfileNormalAgent = join(userProfileHome, ".pi", "agent");
  const envNormalAgent = join(fakeHome, ".pi", "agent");
  mkdirSync(accountNormalAgent, { recursive: true });
  mkdirSync(userProfileNormalAgent, { recursive: true });
  mkdirSync(envNormalAgent, { recursive: true });

  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: join(accountNormalAgent, "session.jsonl") },
      dependencies(fixture, {
        env: {
          HOME: fakeHome,
          USERPROFILE: userProfileHome,
          PI_CODING_AGENT_DIR: accountNormalAgent,
        },
        getAgentDir: () => accountNormalAgent,
        getAccountHome: () => fixture.accountHome,
      }),
    ),
    "default-or-normal-profile",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: join(userProfileNormalAgent, "session.jsonl") },
      dependencies(fixture, {
        env: {
          HOME: fakeHome,
          USERPROFILE: userProfileHome,
          PI_CODING_AGENT_DIR: userProfileNormalAgent,
        },
        getAgentDir: () => userProfileNormalAgent,
        getAccountHome: () => fixture.accountHome,
      }),
    ),
    "default-or-normal-profile",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: join(envNormalAgent, "session.jsonl") },
      dependencies(fixture, {
        env: {
          HOME: fakeHome,
          USERPROFILE: undefined,
          PI_CODING_AGENT_DIR: envNormalAgent,
        },
        getAgentDir: () => envNormalAgent,
        getAccountHome: () => fixture.accountHome,
      }),
    ),
    "default-or-normal-profile",
  );
});

test("uses canonical protected-root containment for case-variant normal Pi profile", (t) => {
  const fixture = makeFixture(t);
  const normalPi = join(fixture.home, ".Pi");
  const normalAgent = join(normalPi, "agent");
  mkdirSync(normalAgent, { recursive: true });
  const lowerNormalPi = join(fixture.home, ".pi");
  const base = baseFileSystem();
  const caseInsensitiveFileSystem = {
    lstat: base.lstat,
    realpath: (path) => {
      const lookupPath =
        path === lowerNormalPi || path.startsWith(`${lowerNormalPi}${sep}`)
          ? `${normalPi}${path.slice(lowerNormalPi.length)}`
          : path;
      return base.realpath(lookupPath).replace(normalPi, lowerNormalPi);
    },
  };

  assertFailure(
    attest(fixture, join(normalAgent, "session.jsonl"), {
      fileSystem: caseInsensitiveFileSystem,
      env: { PI_CODING_AGENT_DIR: normalAgent },
      getAgentDir: () => normalAgent,
    }),
    "default-or-normal-profile",
  );
});

test("probes real case-insensitive filesystems with native realpath", (t) => {
  const fixture = makeFixture(t);
  const probe = join(fixture.root, "CaseProbe");
  mkdirSync(probe);
  let caseInsensitive = false;
  try {
    lstatSync(join(fixture.root, "caseprobe"));
    caseInsensitive = true;
  } catch {
    caseInsensitive = false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  if (!caseInsensitive) {
    t.skip("filesystem is case-sensitive");
    return;
  }

  const normalPi = join(fixture.home, ".Pi");
  const normalAgent = join(normalPi, "agent");
  mkdirSync(normalAgent, { recursive: true });
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = fixture.home;
  delete process.env.USERPROFILE;
  process.env.PI_CODING_AGENT_DIR = normalAgent;

  assertFailure(
    attestSessionMirrorSession({ sessionFile: join(normalAgent, "session.jsonl") }),
    "default-or-normal-profile",
  );
});

test("requires the runtime-selected profile to have the same real path", (t) => {
  const fixture = makeFixture(t);
  const otherAgent = join(fixture.root, "other-agent");
  mkdirSync(otherAgent, { recursive: true });

  assertFailure(
    attest(fixture, join(fixture.sessions, "session.jsonl"), {
      getAgentDir: () => otherAgent,
    }),
    "profile-mismatch",
  );
});

test("rejects symlinked profile and session components", (t) => {
  const fixture = makeFixture(t);
  const linkedProfile = join(fixture.root, "linked-agent");
  symlinkSync(fixture.agent, linkedProfile, "dir");
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: join(linkedProfile, "session.jsonl") },
      dependencies(fixture, {
        env: { PI_CODING_AGENT_DIR: linkedProfile },
        getAgentDir: () => linkedProfile,
      }),
    ),
    "unsafe-profile-metadata",
  );

  const linkedDirectory = join(fixture.agent, "linked-sessions");
  symlinkSync(fixture.sessions, linkedDirectory, "dir");
  assertFailure(attest(fixture, join(linkedDirectory, "future.jsonl")), "unsafe-session-metadata");

  const targetFile = join(fixture.sessions, "target.jsonl");
  const linkedFile = join(fixture.sessions, "linked.jsonl");
  writeFileSync(targetFile, "fixture content\n", "utf8");
  symlinkSync(targetFile, linkedFile, "file");
  assertFailure(attest(fixture, linkedFile), "unsafe-session-metadata");
});

test("rejects session files and directories outside the attested profile", (t) => {
  const fixture = makeFixture(t);
  const outsideDirectory = join(fixture.root, "outside");
  mkdirSync(outsideDirectory, { recursive: true });
  const outsideFile = join(outsideDirectory, "session.jsonl");
  writeFileSync(outsideFile, "fixture content\n", "utf8");

  assertFailure(attest(fixture, outsideFile), "session-escape");
  assertFailure(attest(fixture, join(outsideDirectory, "future.jsonl")), "session-escape");

  const normalPi = join(fixture.home, ".pi");
  mkdirSync(normalPi, { recursive: true });
  assertFailure(attest(fixture, join(normalPi, "session.jsonl")), "session-escape");
});

test("fails closed for inaccessible and hostile metadata", (t) => {
  const fixture = makeFixture(t);
  const sessionFile = join(fixture.sessions, "session.jsonl");
  const base = baseFileSystem();
  const inaccessible = Object.assign(new Error("private metadata"), { code: "EACCES" });
  assertFailure(
    attest(fixture, sessionFile, {
      fileSystem: {
        lstat: (path) => {
          if (path === fixture.agent) throw inaccessible;
          return base.lstat(path);
        },
        realpath: base.realpath,
      },
    }),
    "unsafe-profile-metadata",
  );

  assertFailure(
    attest(fixture, sessionFile, {
      fileSystem: {
        lstat: () => ({
          isDirectory() {
            throw new Error("hostile stat");
          },
          isFile() {
            throw new Error("hostile stat");
          },
          isSymbolicLink() {
            throw new Error("hostile stat");
          },
        }),
        realpath: base.realpath,
      },
    }),
    "unsafe-profile-metadata",
  );

  assertFailure(
    attest(fixture, sessionFile, {
      fileSystem: {
        lstat: base.lstat,
        realpath: (path) => {
          if (path === fixture.agent) return "not-absolute";
          return base.realpath(path);
        },
      },
    }),
    "unsafe-profile-metadata",
  );
});

test("rejects malformed input without throwing or revealing its path", (t) => {
  const fixture = makeFixture(t);
  const privatePath = join(fixture.root, "private-session.jsonl");

  assertFailure(
    attestSessionMirrorSessionCore(null, dependencies(fixture)),
    "unsafe-session-metadata",
  );
  assertFailure(
    attestSessionMirrorSessionCore({ sessionFile: null }, dependencies(fixture)),
    "unsafe-session-metadata",
  );
  assertFailure(
    attestSessionMirrorSessionCore(
      { sessionFile: privatePath },
      dependencies(fixture, {
        fileSystem: {
          lstat: () => {
            throw new Error(privatePath);
          },
          realpath: () => {
            throw new Error(privatePath);
          },
        },
      }),
    ),
    "unsafe-profile-metadata",
  );
});

test("production wrapper uses only the explicitly selected isolated profile", (t) => {
  const fixture = makeFixture(t);
  const sessionFile = join(fixture.sessions, "session.jsonl");
  writeFileSync(sessionFile, "fixture content\n", "utf8");
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = fixture.home;
  delete process.env.USERPROFILE;
  process.env.PI_CODING_AGENT_DIR = fixture.agent;

  assert.deepEqual(attestSessionMirrorSession({ sessionFile }), {
    ok: true,
    phase: "session-file",
  });
});
