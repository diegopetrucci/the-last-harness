import type { GitStatusSnapshot, PullRequestSnapshot } from "./footer-git-cache.js";
import { formatTlhGitFooterSegments } from "./footer-git.js";

/** Bullet divider used between segments on the TLH footer's first line. */
export const FOOTER_FIRST_LINE_SEPARATOR = " • ";

export type TlhFooterFirstLineInput = {
  cwd: string;
  sessionName?: string | null;
  status?: GitStatusSnapshot | undefined;
  pullRequest?: PullRequestSnapshot | undefined;
  fallbackBranch?: string | null;
};

/**
 * Pure composer for the TLH footer's first line. Joins cwd, cached git
 * segments (branch + status indicators + PR), and the session name with the
 * existing bullet divider.
 *
 * Falls back to `fallbackBranch` (typically `footerData.getGitBranch()`) only
 * when the cached status snapshot is `undefined`, i.e. the git cache has not
 * been wired or its first refresh has not completed yet. The legacy
 * parenthesized `(branch)` format is intentionally gone — the bullet style is
 * the new canonical look.
 */
export function composeTlhFooterFirstLine(input: TlhFooterFirstLineInput): string {
  const segments: string[] = [input.cwd];
  if (input.status !== undefined) {
    for (const segment of formatTlhGitFooterSegments(input.status, input.pullRequest)) {
      segments.push(segment);
    }
  } else if (input.fallbackBranch) {
    segments.push(input.fallbackBranch);
  }
  if (input.sessionName) {
    segments.push(input.sessionName);
  }
  return segments.join(FOOTER_FIRST_LINE_SEPARATOR);
}
