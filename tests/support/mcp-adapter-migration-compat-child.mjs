import { existsSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [loaderPath, fixtureRoot, cwd, nativeEnabled] = process.argv.slice(2);
if (!loaderPath || !fixtureRoot || !cwd) {
  throw new Error("usage: child LOADER_PATH FIXTURE_ROOT CWD [native]");
}

const root = resolve(fixtureRoot);
const home = join(root, "home");
const agent = join(root, "agent");
const oauth = join(root, "oauth");
const temp = join(root, "tmp");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.TLH_AGENT_DIR = agent;
process.env.MCP_OAUTH_DIR = oauth;
process.env.XDG_CONFIG_HOME = join(root, "xdg", "config");
process.env.XDG_CACHE_HOME = join(root, "xdg", "cache");
process.env.XDG_DATA_HOME = join(root, "xdg", "data");
process.env.XDG_STATE_HOME = join(root, "xdg", "state");
process.env.TMPDIR = temp;

const loader = await import(pathToFileURL(resolve(loaderPath)).href);
const native = nativeEnabled === "true";
if (native) {
  if (typeof loader.setPiMcpConfigEnabled !== "function") {
    throw new Error(`released loader at ${loaderPath} has no native-enable integration`);
  }
  // The released 5.0.0 index.ts calls this after observing Pi's
  // `typeof pi.registerMcpServer === "function"` capability. The parent test
  // verifies that source line before this child enables native reading.
  loader.setPiMcpConfigEnabled(true);
}

const config = loader.loadMcpConfig(undefined, resolve(cwd));
const summary = loader.getMcpDiscoverySummary(undefined, resolve(cwd), {
  includeHostConfigs: false,
});
const discovery = loader.getConfigDiscoveryPaths(undefined, resolve(cwd));
const notices =
  typeof loader.getLegacyMcpMigrationNotices === "function"
    ? loader.getLegacyMcpMigrationNotices(resolve(cwd))
    : [];

const result = {
  loaderPath: resolve(loaderPath),
  config,
  discovery,
  notices,
  summary: {
    hasAnyConfig: summary.hasAnyConfig,
    hasSharedServers: summary.hasSharedServers,
    hasPiOwnedServers: summary.hasPiOwnedServers,
    totalServerCount: summary.totalServerCount,
    imports: summary.imports,
    hostConfigDiscovery: summary.hostConfigDiscovery,
  },
  nativeEnabled: native,
  checkedFiles: [
    join(agent, "mcp.json"),
    join(agent, "mcp-adapter.json"),
    join(resolve(cwd), ".mcp.json"),
    join(resolve(cwd), ".pi", "mcp.json"),
    join(resolve(cwd), ".pi", "mcp-adapter.json"),
  ].filter((path) => existsSync(path)),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
