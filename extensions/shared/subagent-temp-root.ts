import * as os from "node:os";
import * as path from "node:path";

export type TempRootResolverOptions = {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
};

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(options?: TempRootResolverOptions): string {
  const env = options?.env ?? process.env;
  const getuid =
    options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") {
    return `uid-${getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  const userInfo = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
  try {
    const username = userInfo?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-directory-based scoping.
  }

  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

  const resolveHomedir =
    options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
  try {
    const fallbackHomedir = resolveHomedir?.();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // Fall through to the last-resort shared scope.
  }

  return "shared";
}

/**
 * Resolve the temp root directory used for async run state.
 *
 * Fork delta (GitHub issue #45): integration tests previously shared the
 * uid-scoped temp root with live sessions, causing ghost notifications when
 * test runs left stale async/result files behind. Setting
 * PI_SUBAGENTS_TEMP_ROOT to a non-empty (trimmed) path redirects the temp
 * root (and all directories derived from it) away from the shared
 * os.tmpdir()+scope-id location, without changing default behavior when the
 * variable is unset or blank.
 */
export function resolveTempRootDir(options?: TempRootResolverOptions): string {
  const env = options?.env ?? process.env;
  const override = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (override) {
    return override;
  }
  return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId(options)}`);
}
