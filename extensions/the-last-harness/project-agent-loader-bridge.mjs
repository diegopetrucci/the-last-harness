/** Runtime bridge to the generated embedded-agent loader. */

const projectAgentLoaderModuleUrl = new URL(
  ["..", "subagents", "src", "agents", "project-agent-loader.js"].join("/"),
  import.meta.url,
);

export async function loadProjectAgent(options) {
  const module = await import(projectAgentLoaderModuleUrl.href);
  return module.loadProjectAgent(options);
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
