/**
 * Runtime bridge from the TLH extension target to the generated subagents
 * project-defaults loader. The dynamic URL keeps the two runtime TypeScript
 * targets separate; the subagents target owns compilation of its loader and
 * generated JavaScript.
 *
 * Trust is the shared worktree-level .tlh decision: since project-defaults-loader.js
 * imports resolveProjectAgentTrust from project-agent-loader.js, and Node.js ESM
 * caches modules by resolved path, both loaders share the same SESSION_TRUST_DECISIONS
 * map. When the agents loader resolves trust first, this bridge reuses that decision
 * for the same sessionId and does not re-prompt. A defaults-only project may establish
 * the shared decision here, so callers must provide interactive UI when appropriate.
 */

const projectDefaultsLoaderModuleUrl = new URL(
  ["..", "subagents", "src", "agents", "project-defaults-loader.js"].join("/"),
  import.meta.url,
);

export async function loadProjectDefaults(options) {
  const module = await import(projectDefaultsLoaderModuleUrl.href);
  return module.loadProjectDefaults(options);
}
