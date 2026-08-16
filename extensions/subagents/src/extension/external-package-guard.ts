import * as fs from "node:fs";
import * as path from "node:path";

// Deliberately limited to the retired npm/git sources TLH previously managed.
// local:/path entries are outside this migration's ownership evidence and scope.
export const EXTERNAL_SUBAGENT_PACKAGE_SOURCES = Object.freeze([
  "npm:@diegopetrucci/pi-subagents",
  "npm:pi-subagents",
  "git:github.com/nicobailon/pi-subagents",
  "git:github.com/diegopetrucci/pi-subagents",
]);

const EXTERNAL_SUBAGENT_PACKAGE_IDENTITIES = new Set(
  EXTERNAL_SUBAGENT_PACKAGE_SOURCES.map((source) => externalSubagentPackageIdentity(source)),
);

interface PlainObject {
  [key: string]: unknown;
}

export interface ExternalSubagentPackageMatch {
  scope: "user" | "project";
  settingsPath: string;
  source: string;
  identity: string;
}

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function packageSourceOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (isPlainObject(entry) && typeof entry.source === "string") return entry.source;
  return undefined;
}

function npmIdentity(source: string): string {
  const spec = source.slice("npm:".length).trim();
  if (!spec) return source;
  if (spec.startsWith("@")) {
    const versionSeparator = spec.indexOf("@", 1);
    return `npm:${versionSeparator === -1 ? spec : spec.slice(0, versionSeparator)}`;
  }
  const versionSeparator = spec.indexOf("@");
  return `npm:${versionSeparator === -1 ? spec : spec.slice(0, versionSeparator)}`;
}

function stripGitPathRef(value: string): string {
  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) value = value.slice(0, hashIndex);
  value = value.replace(/\.git(?=@)/i, "");
  const firstSlash = value.indexOf("/");
  const lastAt = value.lastIndexOf("@");
  if (lastAt > firstSlash) value = value.slice(0, lastAt);
  return value.replace(/\.git$/i, "");
}

function gitIdentity(source: string): string {
  let value = source.trim();
  if (value.startsWith("git:") && !/^git:\/\//i.test(value))
    value = value.slice("git:".length).trim();

  const scpMatch = value.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    return `git:${scpMatch[1]!.toLowerCase()}/${stripGitPathRef(scpMatch[2]!).toLowerCase()}`;
  }
  if (/^(https?|ssh|git):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `git:${parsed.hostname.toLowerCase()}/${stripGitPathRef(parsed.pathname.replace(/^\/+/, "")).toLowerCase()}`;
    } catch {
      // Fall through to the same best-effort normalization used for Pi git: forms.
    }
  }

  value = value.replace(/^\/+/, "");
  return `git:${stripGitPathRef(value).toLowerCase()}`;
}

/**
 * Normalize the package forms that can identify the retired external subagents
 * packages. A top-level parity test keeps this behavior and source list aligned
 * with scripts/lib/default-extensions.mts.
 */
export function externalSubagentPackageIdentity(entry: unknown): string | undefined {
  const source = packageSourceOf(entry)?.trim();
  if (!source) return undefined;
  if (source.startsWith("npm:")) return npmIdentity(source);
  if (
    source.startsWith("git:") ||
    /^(https?|ssh|git):\/\//i.test(source) ||
    source.startsWith("git@")
  ) {
    return gitIdentity(source);
  }
  return undefined;
}

function settingsMatches(
  settingsPath: string,
  scope: ExternalSubagentPackageMatch["scope"],
): ExternalSubagentPackageMatch[] {
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return [];
  }
  if (!isPlainObject(settings) || !Array.isArray(settings.packages)) return [];

  const matches: ExternalSubagentPackageMatch[] = [];
  const seen = new Set<string>();
  for (const entry of settings.packages) {
    const source = packageSourceOf(entry)?.trim();
    const identity = externalSubagentPackageIdentity(entry);
    if (
      !source ||
      !identity ||
      !EXTERNAL_SUBAGENT_PACKAGE_IDENTITIES.has(identity) ||
      seen.has(identity)
    )
      continue;
    seen.add(identity);
    matches.push({ scope, settingsPath, source, identity });
  }
  return matches;
}

export function findConfiguredExternalSubagentPackages(options: {
  agentDir: string;
  cwd: string;
  configDirName: string;
}): ExternalSubagentPackageMatch[] {
  const userSettingsPath = path.join(options.agentDir, "settings.json");
  // Project trust is only available later through an event context. Conservatively
  // defer for a configured project entry rather than risk duplicate registration.
  const projectSettingsPath = path.join(options.cwd, options.configDirName, "settings.json");
  return [
    ...settingsMatches(userSettingsPath, "user"),
    ...settingsMatches(projectSettingsPath, "project"),
  ];
}

export function externalSubagentCoexistenceWarning(
  matches: readonly ExternalSubagentPackageMatch[],
): string {
  const scopes = [...new Set(matches.map((match) => match.scope))].join(" and ");
  return `TLH bundled subagents did not register because an external pi-subagents package remains active in ${scopes} settings. Remove that external package entry and restart tlh to enable the bundled subagents runtime.`;
}
