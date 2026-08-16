import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerTlhActivityReporters } from "./the-last-harness/activity-reporters.js";
import { registerTlhEffectiveActivityTracker } from "./the-last-harness/activity-tracker.js";
import { registerToggleTlhGitAttributionCommand } from "./the-last-harness/attribution.js";
import { TLH_HEADER_TOGGLE_SHORTCUT } from "./the-last-harness/constants.js";
import { createTlhAutocompleteProvider } from "./the-last-harness/autocomplete.js";
import { registerContextCap } from "./the-last-harness/context-cap.js";
import { registerEffortCommand } from "./the-last-harness/effort.js";
import { registerExperimentalCommand } from "./the-last-harness/experimental.js";
import { createTlhFooter } from "./the-last-harness/footer.js";
import { FooterGitCache } from "./the-last-harness/footer-git-cache.js";
import { createTlhHeader } from "./the-last-harness/header.js";
import { readTlhInstallNotice } from "./the-last-harness/install-state.js";
import { estimateTlhLaunchContextAllocation } from "./the-last-harness/launch-context.js";
import { installTlhModelVisibilityFilter } from "./the-last-harness/model-visibility.js";
import { installTlhNewVersionNotificationOverride } from "./the-last-harness/new-version-notice.js";
import { installTlhPackageUpdateNotificationOverride } from "./the-last-harness/package-update-notice.js";
import { registerTlhPrimaryAgentRuntime } from "./the-last-harness/primary-agent-runtime.js";
import { collectStartupResourceSnapshot } from "./the-last-harness/resources.js";
import { getTlhStartupTip } from "./the-last-harness/startup-tip.js";
import { maybeNotifyModelEffortDrift } from "./the-last-harness/model-effort-notice.js";
import { registerReconcileCommand } from "./the-last-harness/reconcile-command.js";
import { registerSubagentSettingsCommand } from "./the-last-harness/subagent-settings.js";
import { createLazyTlhSubscriptionUsageService } from "./the-last-harness/subscription-usage-facade.js";
import { handleTlhChangelogCommand } from "./the-last-harness/changelog.js";
import { scheduleTlhLaunchTelemetry } from "./the-last-harness/launch-telemetry.js";
import { createReviewCommandHandler } from "./the-last-harness/review.js";
import { registerLazyTlhTicketWorkflowUi } from "./the-last-harness/ticket-workflow-ui-facade.js";
import {
  getCachedTlhUsageWeeklyVisibility,
  refreshCachedTlhUsageWeeklyVisibility,
  registerUsageCommand,
} from "./the-last-harness/usage-limits.js";
import {
  getTlhHeaderUpdate,
  maybeNotifyAvailableTlhUpdate,
  persistTlhLastSeenVersion,
} from "./the-last-harness/update-check.js";
import { registerVersionCommand } from "./the-last-harness/version.js";
import type {
  StartupResources,
  TlhLaunchContextAllocation,
  TlhUsageRefreshOptions,
} from "./the-last-harness/types.js";

const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";
const TOKENS_COMMAND_DESCRIPTION = "Generate and open a local TLH token-spend report";
const SESSION_LIMIT_REPORT_COMMAND_DESCRIPTION =
  "Generate and open a local TLH session-limit usage report across all in-window sessions";
const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION =
  "Open a native annotation window for the latest assistant message";
const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";

function getActiveProjectTrustDecision(ctx: ExtensionContext): boolean | undefined {
  const projectTrusted = (
    ctx as ExtensionContext & { isProjectTrusted?: () => unknown }
  ).isProjectTrusted?.();
  return typeof projectTrusted === "boolean" ? projectTrusted : undefined;
}

function createRetryableLazyImport<TModule>(
  loader: () => Promise<TModule>,
): () => Promise<TModule> {
  let modulePromise: Promise<TModule> | undefined;
  return () => {
    if (!modulePromise) {
      modulePromise = loader().catch((error) => {
        modulePromise = undefined;
        throw error;
      });
    }
    return modulePromise;
  };
}

const EMPTY_STARTUP_RESOURCES: StartupResources = {
  context: [],
  skills: [],
  prompts: [],
  extensions: [],
  themes: [],
};

type DeferredStartupTaskScheduler = (task: () => void) => void;
type StartupResourceCollector = typeof collectStartupResourceSnapshot;

let scheduleDeferredStartupTask: DeferredStartupTaskScheduler = (task) => {
  setImmediate(task);
};
let startupResourceCollector: StartupResourceCollector = collectStartupResourceSnapshot;

export const __testing = {
  setDeferredStartupTaskSchedulerForTests(scheduler: DeferredStartupTaskScheduler) {
    scheduleDeferredStartupTask = scheduler;
  },
  setStartupResourceCollectorForTests(collector: StartupResourceCollector) {
    startupResourceCollector = collector;
  },
  reset() {
    scheduleDeferredStartupTask = (task) => {
      setImmediate(task);
    };
    startupResourceCollector = collectStartupResourceSnapshot;
  },
};

export default function theLastHarness(pi: ExtensionAPI) {
  let activeTlhHeader: ReturnType<typeof createTlhHeader> | undefined;
  let activeTlhHeaderSessionToken = 0;
  let activeTlhHeaderComponentId = 0;
  let tlhHeaderComponentGeneration = 0;
  const invalidateActiveTlhHeaderSession = () => {
    activeTlhHeaderSessionToken += 1;
    activeTlhHeader = undefined;
    activeTlhHeaderComponentId = 0;
    return activeTlhHeaderSessionToken;
  };
  pi.on("session_shutdown", () => {
    invalidateActiveTlhHeaderSession();
  });

  installTlhModelVisibilityFilter();
  registerContextCap(pi);
  const activityTracker = registerTlhEffectiveActivityTracker(pi);
  registerTlhActivityReporters(pi, activityTracker);

  const primaryAgentRuntime = registerTlhPrimaryAgentRuntime(pi, { env: process.env });
  if (!primaryAgentRuntime) {
    return;
  }

  installTlhPackageUpdateNotificationOverride();
  installTlhNewVersionNotificationOverride();
  registerToggleTlhGitAttributionCommand(pi);
  const reviewCommandHandler = createReviewCommandHandler(pi);
  const loadTokensModule = createRetryableLazyImport(() => import("./the-last-harness/tokens.js"));
  const loadSessionLimitReportModule = createRetryableLazyImport(
    () => import("./the-last-harness/session-limit-report.js"),
  );
  const loadAnnotateLastMessageModule = createRetryableLazyImport(
    () => import("./the-last-harness/annotate-last-message.js"),
  );
  let tokensCommandHandlerPromise:
    | Promise<
        ReturnType<(typeof import("./the-last-harness/tokens.js"))["createTokensCommandHandler"]>
      >
    | undefined;
  let sessionLimitReportCommandHandlerPromise:
    | Promise<
        ReturnType<
          (typeof import("./the-last-harness/session-limit-report.js"))["createSessionLimitReportCommandHandler"]
        >
      >
    | undefined;
  let annotateLastMessageCommandPromise:
    | Promise<
        ReturnType<
          (typeof import("./the-last-harness/annotate-last-message.js"))["buildAnnotateLastMessageCommand"]
        >
      >
    | undefined;
  const getTokensCommandHandler = () => {
    if (!tokensCommandHandlerPromise) {
      tokensCommandHandlerPromise = loadTokensModule()
        .then((module) =>
          module.createTokensCommandHandler(pi, {
            getPrimaryAgentLabel: () => primaryAgentRuntime.currentPrimaryAgentLabel(),
          }),
        )
        .catch((error) => {
          tokensCommandHandlerPromise = undefined;
          throw error;
        });
    }
    return tokensCommandHandlerPromise;
  };
  const getSessionLimitReportCommandHandler = () => {
    if (!sessionLimitReportCommandHandlerPromise) {
      sessionLimitReportCommandHandlerPromise = loadSessionLimitReportModule()
        .then((module) =>
          module.createSessionLimitReportCommandHandler(pi, {
            getSnapshot: (ctx) => subscriptionUsageService.getSnapshotForContext(ctx),
          }),
        )
        .catch((error) => {
          sessionLimitReportCommandHandlerPromise = undefined;
          throw error;
        });
    }
    return sessionLimitReportCommandHandlerPromise;
  };
  const getAnnotateLastMessageCommand = () => {
    if (!annotateLastMessageCommandPromise) {
      annotateLastMessageCommandPromise = loadAnnotateLastMessageModule()
        .then((module) =>
          module.buildAnnotateLastMessageCommand({
            sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
          }),
        )
        .catch((error) => {
          annotateLastMessageCommandPromise = undefined;
          throw error;
        });
    }
    return annotateLastMessageCommandPromise;
  };
  pi.registerCommand("annotate-last-message", {
    description: ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const command = await getAnnotateLastMessageCommand();
      await command.handler(args, ctx);
    },
  });
  pi.on("session_shutdown", async () => {
    if (!annotateLastMessageCommandPromise) {
      return;
    }
    try {
      const command = await annotateLastMessageCommandPromise;
      command.handleSessionShutdown();
    } catch {
      // Swallow prior lazy-import/build failures during shutdown.
    }
  });
  registerEffortCommand(pi, primaryAgentRuntime);
  registerExperimentalCommand(pi);
  registerReconcileCommand(pi, primaryAgentRuntime);
  registerSubagentSettingsCommand(pi);
  registerLazyTlhTicketWorkflowUi(pi);
  pi.registerCommand("review", {
    description: REVIEW_COMMAND_DESCRIPTION,
    getArgumentCompletions: () => null,
    handler: reviewCommandHandler,
  });
  pi.registerCommand("tlh-changelog", {
    description: TLH_CHANGELOG_COMMAND_DESCRIPTION,
    handler: (args, ctx) => handleTlhChangelogCommand(pi, args, ctx),
  });
  pi.registerCommand("tokens", {
    description: TOKENS_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const handler = await getTokensCommandHandler();
      await handler(args, ctx);
    },
  });
  pi.registerCommand("what-consumed-my-session-limit-and-tokens", {
    description: SESSION_LIMIT_REPORT_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const handler = await getSessionLimitReportCommandHandler();
      await handler(args, ctx);
    },
  });
  registerUsageCommand(pi);
  registerVersionCommand(pi);
  pi.registerShortcut(TLH_HEADER_TOGGLE_SHORTCUT, {
    description: "Toggle TLH startup header resources",
    handler: (ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      activeTlhHeader?.toggleExpanded();
    },
  });
  const subscriptionUsageService = createLazyTlhSubscriptionUsageService();
  const refreshSubscriptionUsage = (
    ctx: ExtensionContext,
    options: TlhUsageRefreshOptions = {},
  ) => {
    if (!ctx.hasUI) {
      return;
    }
    subscriptionUsageService.refresh(ctx, options);
  };

  pi.on("model_select", (_event, ctx) => {
    refreshSubscriptionUsage(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshSubscriptionUsage(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const sessionToken = invalidateActiveTlhHeaderSession();
    await primaryAgentRuntime.applySessionStart(ctx);
    refreshCachedTlhUsageWeeklyVisibility(ctx.cwd);

    if (!ctx.hasUI) {
      return;
    }

    if (event.reason === "startup") {
      try {
        scheduleTlhLaunchTelemetry(ctx, primaryAgentRuntime.activePrimaryAgentPrompt()?.name);
      } catch {
        // Telemetry failures are non-fatal.
      }
    }
    ctx.ui.addAutocompleteProvider(createTlhAutocompleteProvider);

    const sessionState: {
      resources: StartupResources;
      launchContextAllocation?: TlhLaunchContextAllocation;
      header?: ReturnType<typeof createTlhHeader>;
      requestRender?: () => void;
    } = { resources: EMPTY_STARTUP_RESOURCES };
    const headerUpdate = getTlhHeaderUpdate();
    const startupTip = event.reason === "startup" ? getTlhStartupTip() : undefined;
    const installNotice = readTlhInstallNotice();

    if (typeof ctx.ui.setFooter === "function") {
      ctx.ui.setFooter((tui, theme, footerData) => {
        subscriptionUsageService.registerFooterRenderRequest(ctx, () => tui.requestRender());
        const gitCache = new FooterGitCache({
          cwd: () => ctx.sessionManager.getCwd(),
          onChange: () => tui.requestRender(),
          onBranchChangeSource:
            typeof footerData?.onBranchChange === "function"
              ? (cb) => footerData.onBranchChange(cb)
              : undefined,
        });
        return createTlhFooter(
          pi,
          ctx,
          theme,
          () => primaryAgentRuntime.currentPrimaryAgentLabel(),
          footerData,
          {
            subscriptionUsage: subscriptionUsageService,
            shouldShowWeekly: getCachedTlhUsageWeeklyVisibility,
          },
          gitCache,
          installNotice,
        );
      });
    }
    if (typeof ctx.ui.setHeader === "function") {
      ctx.ui.setHeader((tui, theme) => {
        const componentId = ++tlhHeaderComponentGeneration;
        const requestRender = () => {
          if (
            activeTlhHeaderSessionToken !== sessionToken ||
            activeTlhHeaderComponentId !== componentId
          ) {
            return;
          }
          tui.requestRender();
        };
        const header = createTlhHeader(
          theme,
          sessionState.resources,
          headerUpdate,
          event.reason === "startup" ? installNotice : undefined,
          {
            requestRender,
            startupTip,
            launchContextAllocation: sessionState.launchContextAllocation,
          },
        );
        sessionState.header = header;
        sessionState.requestRender = requestRender;
        if (activeTlhHeaderSessionToken === sessionToken) {
          activeTlhHeader = header;
          activeTlhHeaderComponentId = componentId;
        }
        return header;
      });
    }

    scheduleDeferredStartupTask(() => {
      persistTlhLastSeenVersion();
      maybeNotifyModelEffortDrift(ctx);
      void maybeNotifyAvailableTlhUpdate(ctx, {
        canNotify: () => activeTlhHeaderSessionToken === sessionToken,
      }).catch(() => undefined);
      const launchContextInputs = (() => {
        try {
          const baseSystemPrompt = ctx.getSystemPrompt();
          return {
            contextWindow: ctx.model?.contextWindow,
            baseSystemPrompt,
            launchSystemPrompt: primaryAgentRuntime.buildLaunchSystemPrompt(ctx, baseSystemPrompt),
            activeToolNames: pi.getActiveTools(),
            allTools: pi.getAllTools(),
          };
        } catch {
          return undefined;
        }
      })();
      void startupResourceCollector(ctx.cwd, {
        projectTrusted: getActiveProjectTrustDecision(ctx),
      })
        .then((snapshot) => {
          if (activeTlhHeaderSessionToken !== sessionToken) {
            return;
          }

          let launchContextAllocation: TlhLaunchContextAllocation | undefined;
          try {
            launchContextAllocation = launchContextInputs
              ? estimateTlhLaunchContextAllocation({
                  ...launchContextInputs,
                  promptMetadata: snapshot.promptMetadata,
                })
              : undefined;
          } catch {
            // Resource inventory still hydrates if launch-context attribution is unavailable.
          }

          sessionState.resources = snapshot.resources;
          sessionState.launchContextAllocation = launchContextAllocation;
          sessionState.header?.setResources(snapshot.resources);
          sessionState.header?.setLaunchContextAllocation(launchContextAllocation);
          sessionState.requestRender?.();
        })
        .catch(() => {
          // Keep startup resilient. The header can still render without resource details.
        });
    });

    refreshSubscriptionUsage(ctx);
  });
}
