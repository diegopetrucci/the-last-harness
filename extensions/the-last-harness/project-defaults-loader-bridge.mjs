/**
 * Runtime bridge from the TLH extension target to the generated subagents
 * project-defaults loader. The dynamic URL keeps the two runtime TypeScript
 * targets separate; the subagents target owns compilation of its loader and
 * generated JavaScript.
 *
 * Project defaults use a separate project-configuration trust policy. The lazy
 * defaults loader owns its nominally distinct result type and module-private,
 * plane-tagged session cache; it never shares custom-agent execution trust or
 * authorizes .tlh/agents/custom definitions. A session/defaults approval only
 * permits model/effort values from .tlh/defaults.json for that session.
 */

const projectDefaultsLoaderModuleUrl = new URL(
  ["..", "subagents", "src", "agents", "project-defaults-loader.js"].join("/"),
  import.meta.url,
);

export async function loadProjectDefaults(options) {
  const module = await import(projectDefaultsLoaderModuleUrl.href);
  return module.loadProjectDefaults(options);
}
