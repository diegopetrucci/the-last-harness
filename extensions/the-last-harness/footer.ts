import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRIMARY_AGENT } from "../the-last-harness-primary-agent.mjs";
import { formatCompactTokenCount, formatHomePath, sanitizeStatusText } from "./common.js";
import type { FooterGitCache } from "./footer-git-cache.js";
import { formatTlhInstallNoticeTrackLabel } from "./install-state.js";
import { composeTlhFooterFirstLine } from "./footer-first-line.js";
import {
  getTlhSubscriptionUsageFooterState,
  type TlhFooterSubscriptionUsageOptions,
} from "./footer-subscription-usage.js";
import type { TlhInstallNotice } from "./types.js";
import type { ProviderAuthHealthStore } from "./provider-auth-health.js";

const FAST_STATUS_KEY = "fast";
const NO_PROVIDER_WARNING_TEXT = "\u26a0 no provider \u2014 run /login";

function formatCost(cost: number): string {
  return cost < 0.001 ? "<$0.001" : `$${cost.toFixed(3)}`;
}

function getCurrentThinkingLevel(pi: ExtensionAPI): string {
  try {
    return pi.getThinkingLevel();
  } catch {
    return "off";
  }
}

function collectUsageTotals(ctx: ExtensionContext) {
  // Mirror upstream Pi footer getSessionStats: assistant + toolResult messages,
  // standalone "usage" entries (e.g. cache_warm), and compaction/branch_summary usage.
  const totals = { cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    const raw = entry as {
      type: string;
      message?: { role?: string; usage?: unknown };
      usage?: unknown;
    };
    let usage: unknown;
    if (raw.type === "usage" || raw.type === "branch_summary" || raw.type === "compaction") {
      usage = raw.usage;
    } else if (
      raw.type === "message" &&
      (raw.message?.role === "assistant" || raw.message?.role === "toolResult")
    ) {
      usage = raw.message.usage;
    }
    if (!usage || typeof usage !== "object") {
      continue;
    }
    totals.cost += Number((usage as { cost?: { total?: unknown } }).cost?.total) || 0;
  }
  return totals;
}

function formatNoProviderWarningLine(width: number, theme: Theme): string {
  const warningText = theme.fg("warning", NO_PROVIDER_WARNING_TEXT);
  return truncateToWidth(warningText, width, theme.fg("warning", "..."));
}

type TlhFooterUsageOptions = TlhFooterSubscriptionUsageOptions;

/**
 * Choose the widest reauth warning text that fits within `width` visible columns.
 * Progressive degradation avoids truncating provider names into unreadable fragments:
 *   1. "\u26a0 reauth: anthropic, openai-codex" — full names
 *   2. "\u26a0 reauth: anthropic, codex"        — last hyphen-segment of each name
 *   3. "\u26a0 reauth \u00d7N"                       — count only (always renders)
 *
 * Exported for testing only; use createTlhFooter in production.
 */
export function formatReauthWarningLine(
  providers: readonly string[],
  width: number,
  theme: Theme,
): string | undefined {
  if (providers.length === 0) return undefined;

  // Variant 1: full provider names
  const fullText = `\u26a0 reauth: ${providers.join(", ")}`;
  const fullStyled = theme.fg("warning", fullText);
  if (visibleWidth(fullStyled) <= width) return fullStyled;

  // Variant 2: last hyphen-segment of each name (e.g. openai-codex → codex)
  const shortLabels = providers.map((p) => p.split("-").at(-1) ?? p);
  const shortText = `\u26a0 reauth: ${shortLabels.join(", ")}`;
  const shortStyled = theme.fg("warning", shortText);
  if (visibleWidth(shortStyled) <= width) return shortStyled;

  // Variant 3: count only — truncated to width for layout consistency.
  // The count property (how many providers need attention) yields at extreme
  // widths (below ~11 columns); nothing is legible there anyway, and silently
  // overflowing the render width would corrupt the whole footer layout.
  const countText = `\u26a0 reauth \u00d7${providers.length}`;
  const countStyled = theme.fg("warning", countText);
  return truncateToWidth(countStyled, width, theme.fg("warning", "..."));
}

function sanitizeCommitSubject(text: string): string {
  return sanitizeStatusText(
    text.replace(/\p{Cc}/gu, (character) =>
      character === "\r" || character === "\n" || character === "\t" ? " " : "",
    ),
  );
}

type TlhMainTrackFooterState = {
  behindCount?: number;
};

function formatTlhInstallNoticeLine(
  notice: TlhInstallNotice,
  width: number,
  theme: Theme,
  mainTrackBehindCount?: number,
): string {
  const label = formatTlhInstallNoticeTrackLabel(notice);
  const isMainRef = notice.kind === "ref" && label === "main";
  const hasMainTrackCommitSha =
    isMainRef &&
    typeof notice.commitSha === "string" &&
    /^[0-9a-f]{40}$/i.test(notice.commitSha.trim());
  const commitSubject =
    isMainRef && typeof notice.commitSubject === "string"
      ? sanitizeCommitSubject(notice.commitSubject)
      : "";
  const commitSubjectSuffix = commitSubject
    ? `${theme.fg("dim", " • ")}${theme.fg("dim", commitSubject)}`
    : "";
  const behindSuffix =
    hasMainTrackCommitSha &&
    typeof mainTrackBehindCount === "number" &&
    Number.isSafeInteger(mainTrackBehindCount) &&
    mainTrackBehindCount > 0
      ? `${theme.fg("dim", " • ")}${theme.fg(
          "dim",
          `${mainTrackBehindCount} commit${mainTrackBehindCount === 1 ? "" : "s"} behind origin/main`,
        )}`
      : "";
  const warningStr =
    `${theme.fg("dim", "TLH ")}${theme.fg("warning", label)}` + commitSubjectSuffix + behindSuffix;
  return truncateToWidth(warningStr, width, theme.fg("dim", "..."));
}

export function createTlhFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  getPrimaryName: () => string,
  footerData?: ReadonlyFooterDataProvider,
  usageOptions: TlhFooterUsageOptions = {},
  gitCache?: FooterGitCache | null,
  installNotice?: TlhInstallNotice,
  providerAuthHealth?: ProviderAuthHealthStore,
  mainTrackFooterState?: TlhMainTrackFooterState,
) {
  return {
    render(width: number): string[] {
      const model = ctx.model;
      const totals = collectUsageTotals(ctx);
      const contextUsage = ctx.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
      const contextPercentValue = contextUsage?.percent ?? 0;
      const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

      // Line 1: cwd • branch • git-status • PR • sessionName (unchanged)
      const pwd = composeTlhFooterFirstLine({
        cwd: formatHomePath(ctx.sessionManager.getCwd()),
        sessionName: ctx.sessionManager.getSessionName(),
        status: gitCache?.getStatusSnapshot(),
        pullRequest: gitCache?.getPullRequestSnapshot(),
        fallbackBranch: footerData?.getGitBranch?.(),
      });
      const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
      const extensionStatuses = footerData?.getExtensionStatuses?.();
      const hasFastStatus = extensionStatuses?.has(FAST_STATUS_KEY) ?? false;

      // Line 2 (single flowing left-justified line):
      //   agent: <primaryName> • <model|no-model> [• thinking] • context% [• fast]
      // Each segment is explicitly themed to avoid ANSI foreground-reset bleed from nested
      // theme.fg() calls. Non-default agent names are highlighted with the accent color.
      const modelOrNoModel = model?.id ?? "no-model";
      const modelPart: string = modelOrNoModel;

      const primaryName = getPrimaryName();
      const dimSep = theme.fg("dim", " • ");
      const nameSegment =
        primaryName === DEFAULT_PRIMARY_AGENT
          ? theme.fg("dim", primaryName)
          : theme.fg("accent", primaryName);

      let agentLine2Str =
        theme.fg("dim", "agent: ") + nameSegment + dimSep + theme.fg("dim", modelPart);

      if (model?.reasoning) {
        const thinkingLevel = getCurrentThinkingLevel(pi);
        agentLine2Str +=
          dimSep + theme.fg("dim", thinkingLevel === "off" ? "thinking off" : thinkingLevel);
      }

      const contextPercentDisplay =
        contextPercent === "?"
          ? `?/${formatCompactTokenCount(contextWindow)}`
          : `${contextPercent}%/${formatCompactTokenCount(contextWindow)}`;
      let contextPercentStr: string;
      if (contextPercentValue > 90) {
        contextPercentStr = theme.fg("error", contextPercentDisplay);
      } else if (contextPercentValue > 70) {
        contextPercentStr = theme.fg("warning", contextPercentDisplay);
      } else {
        contextPercentStr = theme.fg("dim", contextPercentDisplay);
      }
      agentLine2Str += dimSep + contextPercentStr;

      const fastLine2Suffix = hasFastStatus ? dimSep + theme.fg("dim", FAST_STATUS_KEY) : "";
      const fastLine2SuffixWidth = visibleWidth(fastLine2Suffix);
      const agentLine2 =
        fastLine2SuffixWidth <= width
          ? `${truncateToWidth(
              agentLine2Str,
              width - fastLine2SuffixWidth,
              theme.fg("dim", "..."),
            )}${fastLine2Suffix}`
          : truncateToWidth(agentLine2Str + fastLine2Suffix, width, theme.fg("dim", "..."));

      // Line 3 (optional): [<cost> · ]<subscription usage segment>
      // Omitted entirely when both parts are absent.
      const subscriptionUsageState = getTlhSubscriptionUsageFooterState(ctx, model, usageOptions);
      const costStr =
        totals.cost > 0 && !subscriptionUsageState.suppressCost
          ? formatCost(totals.cost)
          : undefined;
      const line3Parts: string[] = [];
      if (costStr) line3Parts.push(costStr);
      if (subscriptionUsageState.segment) line3Parts.push(subscriptionUsageState.segment);
      const line3 = line3Parts.length > 0 ? line3Parts.join(" · ") : undefined;

      const lines: string[] = [pwdLine, agentLine2];

      // Read the upstream cached count on every render so the warning dismisses after login.
      // This is intentionally limited to footer data; it does not inspect credentials or probe.
      if (footerData?.getAvailableProviderCount?.() === 0) {
        lines.push(formatNoProviderWarningLine(width, theme));
      }

      // Reauth warning line: rendered before cost/status lines so it is not the first
      // segment lost to truncation at narrow widths.
      // Only 'reauth-required' providers render; transient-unavailable and unknown are silent.
      // Progressive degradation ensures both provider names are always distinguishable:
      //   1. full names    "⚠ reauth: anthropic, openai-codex"
      //   2. short labels  "⚠ reauth: anthropic, codex"  (last hyphen-segment)
      //   3. count only    "⚠ reauth ×2"                 (always fits)
      if (providerAuthHealth) {
        const reauthProviders = providerAuthHealth.getReauthProviders();
        const warningLine = formatReauthWarningLine(reauthProviders, width, theme);
        if (warningLine !== undefined) lines.push(warningLine);
      }

      if (line3 !== undefined) {
        lines.push(truncateToWidth(theme.fg("dim", line3), width, theme.fg("dim", "...")));
      }

      // Hint line (conditional on pending editor text during an active turn)
      const editorText = ctx.ui.getEditorText();
      if (editorText.length > 0 && !ctx.isIdle()) {
        const steerKey = keyText("tui.input.submit") || "enter";
        const queueKey = keyText("app.message.followUp") || "alt+enter";
        const steeringHint = `${theme.fg("dim", steerKey)}${theme.fg("muted", " steer")}`;
        const queueHint = `${theme.fg("dim", queueKey)}${theme.fg("muted", " queue follow-up")}`;
        lines.push(
          truncateToWidth(
            `${steeringHint}${theme.fg("muted", " · ")}${queueHint}`,
            width,
            theme.fg("dim", "..."),
          ),
        );
      }

      // Extension status line (conditional on registered extension statuses)
      if (extensionStatuses && extensionStatuses.size > 0) {
        const visibleStatuses = Array.from(extensionStatuses.entries())
          .filter(([key]) => key !== FAST_STATUS_KEY)
          .sort(([a], [b]) => a.localeCompare(b));
        const statusLine = visibleStatuses
          .map(([, text]) => sanitizeStatusText(text))
          .filter(Boolean)
          .join(" ");
        if (statusLine) {
          lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
        }
      }

      // Install notice line (last line): shown when running from a non-release track.
      // render() reads only in-memory session state — no file I/O.
      if (installNotice) {
        lines.push(
          formatTlhInstallNoticeLine(
            installNotice,
            width,
            theme,
            mainTrackFooterState?.behindCount,
          ),
        );
      }

      return lines;
    },
    invalidate() {},
    dispose() {
      gitCache?.dispose();
      // providerAuthHealth is session-owned; its lifecycle is managed by the session,
      // not the footer. Do not dispose here.
    },
  };
}
