/**
 * Runtime bridge from the TLH extension target to the generated subagent
 * loader. The dynamic URL keeps the two runtime TypeScript targets separate;
 * the subagent target owns compilation of its loader and generated JavaScript.
 */

const projectAgentLoaderModuleUrl = new URL(
  ["..", "subagents", "src", "agents", "project-agent-loader.js"].join("/"),
  import.meta.url,
);

export async function loadProjectAgentSnapshot(options) {
  const module = await import(projectAgentLoaderModuleUrl.href);
  return module.loadProjectAgentSnapshot(options);
}

export async function reauthorizeTlhProjectAgentTrust(projectRoot, options = {}) {
  const module = await import(projectAgentLoaderModuleUrl.href);
  const input = options ?? {};
  const dependencies = input.trustDependencies;
  return module.resolveProjectAgentTrust(projectRoot, {
    agentDir: input.agentDir,
    trustStore: input.trustStore,
    trustOverride: input.trustOverride,
    createProjectTrustStore: input.createProjectTrustStore ?? dependencies?.createProjectTrustStore,
  });
}
