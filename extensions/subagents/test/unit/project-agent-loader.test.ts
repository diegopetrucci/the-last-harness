import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  loadProjectAgent,
  MAX_PROJECT_AGENT_FILE_BYTES,
  validateProjectAgentCwdContainment,
  type ProjectAgentFileSystem,
  type ProjectAgentSecureOpenFlags,
  type ProjectAgentTrustStore,
} from "../../src/agents/project-agent-loader.ts";
import { DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS } from "../../src/agents/execution-ceiling.ts";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
import { makeAsyncCtx } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  authorizePersistedProjectAgentRun,
  resolveProjectAgentExecution,
} from "../../src/runs/shared/project-agent-control.ts";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

function createProject(
  content = "---\nname: worker\npackage: embedded\ndescription: Worker\ntools: read\n---\nPrompt\n",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-loader-"));
  temporaryProjects.push(root);
  execFileSync("git", ["init", "-q", root]);
  const custom = path.join(root, ".tlh", "agents", "custom");
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, "WORKER.md"), content);
  return root;
}

function trustedStore(decision = true): ProjectAgentTrustStore {
  return { getEntry: (cwd) => ({ path: cwd, decision }) };
}

async function load(root: string, store = trustedStore(), fileSystem?: ProjectAgentFileSystem) {
  return loadProjectAgent({ cwd: root, slug: "worker", trustStore: store, fileSystem });
}

function hookedFileSystem(
  hook: (filePath: string, fd: number) => void,
  readFileHook?: (filePath: string) => void,
): ProjectAgentFileSystem {
  return {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => {
      readFileHook?.(filePath);
      return fs.readFileSync(filePath);
    },
    readdirSync: (directoryPath) => fs.readdirSync(directoryPath),
    openSync: (filePath, flags) => {
      const fd = fs.openSync(filePath, flags);
      hook(filePath, fd);
      return fd;
    },
    fstatSync: (fd) => fs.fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) =>
      fs.readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => fs.closeSync(fd),
  };
}

describe("loadProjectAgent", () => {
  it("loads the fixed uppercase definition and persists only slug/root/cwd identity", async () => {
    const root = createProject();
    const loaded = await load(root);
    assert.equal(loaded.agent.name, "embedded.worker");
    assert.equal(loaded.agent.source, "project");
    assert.equal(loaded.agent.maxExecutionTimeMs, DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS);
    const plan = buildAsyncRunnerPlan("project-ceiling", {
      tasks: [{ agent: loaded.agent.name, task: "bounded project run" }],
      agents: [loaded.agent],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx: makeAsyncCtx(root),
      maxSubagentDepth: 2,
    });
    assert.ok("plan" in plan);
    if ("plan" in plan) assert.equal(plan.plan.tasks[0]?.timeoutMs, 14_400_000);
    const canonicalRoot = fs.realpathSync(root);
    assert.deepEqual(loaded.identity, {
      slug: "worker",
      root: canonicalRoot,
      cwd: canonicalRoot,
    });
  });

  it("preserves an explicit project-agent execution ceiling", async () => {
    const root = createProject(
      "---\nname: worker\npackage: embedded\ndescription: Worker\ntools: read\nmaxExecutionTimeMs: 1234\n---\nPrompt\n",
    );
    const loaded = await load(root);
    assert.equal(loaded.agent.maxExecutionTimeMs, 1234);
  });

  it("rejects one embedded slug resolving to different roots before publishing either config", async () => {
    const firstRoot = createProject(
      "---\nname: worker\npackage: embedded\ndescription: First\ntools: read\n---\nFirst prompt\n",
    );
    const secondRoot = createProject(
      "---\nname: worker\npackage: embedded\ndescription: Second\ntools: write\n---\nSecond prompt\n",
    );
    const result = await resolveProjectAgentExecution(
      {
        tasks: [
          { agent: "embedded.worker", task: "first", cwd: firstRoot },
          { agent: "embedded.worker", task: "second", cwd: secondRoot },
        ],
      } as never,
      firstRoot,
      "both",
      null,
      {
        discoverAgents: () => ({ agents: [] }),
        getProjectAgentAccess: () => ({
          architect: true,
          canInitiate: true,
          trustStore: trustedStore(),
        }),
      } as never,
    );
    assert.ok("error" in result);
    if ("error" in result) {
      assert.match(result.error, /multiple canonical definitions/);
      assert.doesNotMatch(result.error, /First prompt|Second prompt/);
    }
  });

  it("allows one embedded definition from multiple subdirectories of one root", async () => {
    const root = createProject();
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    const result = await resolveProjectAgentExecution(
      {
        tasks: [
          { agent: "embedded.worker", task: "one", cwd: "one" },
          { agent: "embedded.worker", task: "two", cwd: "two" },
        ],
      } as never,
      root,
      "both",
      null,
      {
        discoverAgents: () => ({ agents: [] }),
        getProjectAgentAccess: () => ({
          architect: true,
          canInitiate: true,
          trustStore: trustedStore(),
        }),
      } as never,
    );
    assert.equal("error" in result, false);
    if (!("error" in result)) assert.equal(result.projectAgentIdentities?.length, 2);
  });

  it("keeps the requested discovery scope for mixed embedded dispatches", async () => {
    for (const scope of ["user", "project", "both"] as const) {
      const root = createProject();
      let observedScope: string | undefined;
      const result = await resolveProjectAgentExecution(
        {
          tasks: [
            { agent: "embedded.worker", task: "embedded" },
            { agent: "ordinary", task: "ordinary" },
          ],
        } as never,
        root,
        scope,
        null,
        {
          discoverAgents: (_cwd: string, requestedScope: string) => {
            observedScope = requestedScope;
            return { agents: [] };
          },
          getProjectAgentAccess: () => ({
            architect: true,
            canInitiate: true,
            trustStore: trustedStore(),
          }),
        } as never,
      );
      assert.equal("error" in result, false, scope);
      assert.equal(observedScope, scope);
    }
  });

  it("rechecks persisted trust on a later load", async () => {
    const root = createProject();
    let decision = true;
    const store: ProjectAgentTrustStore = {
      getEntry: (cwd) => ({ path: cwd, decision }),
    };
    await load(root, store);
    decision = false;
    await assert.rejects(() => load(root, store), /project trust is not persisted/);
  });

  it("rejects a symlinked definition", async () => {
    const root = createProject();
    const custom = path.join(root, ".tlh", "agents", "custom");
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, fs.readFileSync(path.join(custom, "WORKER.md")));
    fs.rmSync(path.join(custom, "WORKER.md"));
    fs.symlinkSync(outside, path.join(custom, "WORKER.md"));
    await assert.rejects(() => load(root), /regular non-symlink file/);
  });

  it("rejects a definition larger than the pre-read cap", async () => {
    const root = createProject(
      `---\nname: worker\npackage: embedded\ndescription: Worker\ntools: read\n---\n${"x".repeat(MAX_PROJECT_AGENT_FILE_BYTES)}\n`,
    );
    await assert.rejects(() => load(root), /exceeds 65536 bytes/);
  });

  it("fails closed when either secure definition open flag is unavailable, zero, or invalid", async () => {
    const validFlags: ProjectAgentSecureOpenFlags = {
      noFollow: fs.constants.O_NOFOLLOW,
      nonBlocking: fs.constants.O_NONBLOCK,
    };
    const cases: ReadonlyArray<[string, ProjectAgentSecureOpenFlags]> = [
      ["O_NOFOLLOW unavailable", { ...validFlags, noFollow: undefined }],
      ["O_NOFOLLOW zero", { ...validFlags, noFollow: 0 }],
      ["O_NOFOLLOW invalid", { ...validFlags, noFollow: Number.NaN }],
      ["O_NONBLOCK unavailable", { ...validFlags, nonBlocking: undefined }],
      ["O_NONBLOCK zero", { ...validFlags, nonBlocking: 0 }],
      ["O_NONBLOCK invalid", { ...validFlags, nonBlocking: Number.NaN }],
    ];

    for (const [label, secureOpenFlags] of cases) {
      const root = createProject();
      let opened = false;
      const fileSystem: ProjectAgentFileSystem = {
        ...hookedFileSystem(() => {
          opened = true;
        }),
        secureOpenFlags,
      };
      await assert.rejects(
        () => load(root, trustedStore(), fileSystem),
        /secure definition-file access is unavailable/,
        label,
      );
      assert.equal(opened, false, `${label}: must fail before opening a descriptor`);
    }
  });

  it(
    "rejects a real FIFO without blocking the parent process",
    {
      skip:
        process.platform === "win32" ||
        typeof fs.constants.O_NOFOLLOW !== "number" ||
        fs.constants.O_NOFOLLOW === 0 ||
        typeof fs.constants.O_NONBLOCK !== "number" ||
        fs.constants.O_NONBLOCK === 0,
    },
    () => {
      const root = createProject();
      const definition = path.join(root, ".tlh", "agents", "custom", "WORKER.md");
      fs.unlinkSync(definition);
      execFileSync("mkfifo", [definition]);

      const loaderUrl = new URL("../../src/agents/project-agent-loader.ts", import.meta.url).href;
      const testLoaderUrl = new URL("../support/register-loader.mjs", import.meta.url).href;
      const script = `
        import { loadProjectAgent } from ${JSON.stringify(loaderUrl)};
        try {
          await loadProjectAgent({
            cwd: ${JSON.stringify(root)},
            slug: "worker",
            trustStore: { getEntry: (cwd) => ({ path: cwd, decision: true }) },
          });
          process.stdout.write("loaded");
        } catch (error) {
          if (error instanceof Error && error.message.includes("regular non-symlink file")) {
            process.stdout.write("fifo-rejected");
          } else {
            console.error(error);
            process.exitCode = 1;
          }
        }
      `;
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          testLoaderUrl,
          "--input-type=module",
          "--eval",
          script,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: scaleTestTimeout(2_000),
        },
      );

      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.signal, null);
      assert.equal(child.stdout.trim(), "fifo-rejected", child.stderr);
      assert.equal(fs.lstatSync(definition).isFIFO(), true);
    },
  );

  it("rejects a symlinked fixed parent directory", async () => {
    const root = createProject();
    const fixedDirectory = path.join(root, ".tlh");
    fs.renameSync(fixedDirectory, `${fixedDirectory}-real`);
    fs.symlinkSync(`${fixedDirectory}-real`, fixedDirectory, "dir");
    await assert.rejects(() => load(root), /regular non-symlink directory/);
  });

  it("rejects a final definition replacement after the descriptor is opened", async () => {
    const root = createProject();
    const definition = path.join(fs.realpathSync(root), ".tlh", "agents", "custom", "WORKER.md");
    let swapped = false;
    const fileSystem = hookedFileSystem((filePath) => {
      if (filePath !== definition || swapped) return;
      swapped = true;
      fs.renameSync(definition, `${definition}.original`);
      fs.writeFileSync(definition, "replacement", "utf8");
    });
    await assert.rejects(() => load(root, trustedStore(), fileSystem), /changed during access/);
  });

  it("rejects an ancestor directory replacement after the descriptor is opened", async () => {
    const root = createProject();
    const custom = path.join(fs.realpathSync(root), ".tlh", "agents", "custom");
    const definition = path.join(custom, "WORKER.md");
    let swapped = false;
    const fileSystem = hookedFileSystem((filePath) => {
      if (filePath !== definition || swapped) return;
      swapped = true;
      fs.renameSync(custom, `${custom}.original`);
      fs.mkdirSync(custom);
      fs.writeFileSync(definition, "replacement", "utf8");
    });
    await assert.rejects(
      () => load(root, trustedStore(), fileSystem),
      /parent directory changed during access/,
    );
  });

  it("does not read the definition body through its path", async () => {
    const root = createProject();
    const definition = path.join(fs.realpathSync(root), ".tlh", "agents", "custom", "WORKER.md");
    const fileSystem = hookedFileSystem(
      () => {},
      (filePath) => {
        if (filePath === definition) throw new Error("definition body was path-read");
      },
    );
    const loaded = await load(root, trustedStore(), fileSystem);
    assert.equal(loaded.agent.name, "embedded.worker");
  });

  it("requires the exact uppercase slug filename", async () => {
    const root = createProject();
    const custom = path.join(root, ".tlh", "agents", "custom");
    fs.renameSync(path.join(custom, "WORKER.md"), path.join(custom, "worker.md"));
    await assert.rejects(() => load(root), /definition file does not exist/);
  });

  it("rejects frontmatter whose identity does not match the requested slug", async () => {
    const root = createProject(
      "---\nname: other\npackage: embedded\ndescription: Other\ntools: read\n---\nPrompt\n",
    );
    await assert.rejects(() => load(root), /frontmatter name\/package/);
  });

  it("rechecks persisted trust before a later control authorization", async () => {
    const root = createProject();
    let decision = true;
    const store: ProjectAgentTrustStore = {
      getEntry: (cwd) => ({ path: cwd, decision }),
    };
    const loaded = await load(root, store);
    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => "session" },
    } as never;
    const deps = {
      getProjectAgentAccess: () => ({ architect: true, canInitiate: true, trustStore: store }),
      discoverAgents: () => ({ agents: [] }),
    } as never;
    await authorizePersistedProjectAgentRun({
      target: {
        runId: "run",
        agent: "embedded.worker",
        cwd: loaded.identity.cwd,
        projectAgent: loaded.identity,
      },
      ctx,
      deps,
    });
    decision = false;
    await assert.rejects(
      () =>
        authorizePersistedProjectAgentRun({
          target: {
            runId: "run",
            agent: "embedded.worker",
            cwd: loaded.identity.cwd,
            projectAgent: loaded.identity,
          },
          ctx,
          deps,
        }),
      /project trust is not persisted/,
    );
  });

  it("keeps execution cwd inside the canonical Git root", () => {
    const root = createProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-outside-"));
    temporaryProjects.push(outside);
    const result = validateProjectAgentCwdContainment(root, outside);
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /outside/);
  });
});
