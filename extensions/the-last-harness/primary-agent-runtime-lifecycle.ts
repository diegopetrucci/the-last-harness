import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  getAgentDir,
  type ExtensionContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

import {
  DISABLED_PRIMARY_AGENT,
  isEnabledPrimaryAgentSelection,
} from "../the-last-harness-primary-agent.mjs";
import { isRecord } from "./common.js";
import { defaultProjectTrustForCwd } from "./primary-agent-runtime-settings.js";
import {
  isPersistedProjectAgentTrustDenial,
  normalizeActiveProjectAgentSnapshot,
  normalizeProjectDefaultsResult,
  pathWithinProjectRoot,
  projectDefaultsWarningKey,
  sessionIdForContext,
  truncateProjectDefaultsWarning,
  validatePrimaryProjectAgentCwdContainment,
  type ActiveProjectAgentSnapshot,
  type ActiveProjectDefaults,
  type ProjectAgentCapability,
  type ProjectAgentRebindResult,
} from "./primary-agent-runtime-boundaries.js";
import {
  loadProjectAgentSnapshot,
  reauthorizeTlhProjectAgentTrust,
} from "./project-agent-loader-bridge.mjs";
import { loadProjectDefaults } from "./project-defaults-loader-bridge.mjs";
import {
  releaseTlhProjectAgentRunReferencesForSession,
  releaseTlhProjectAgentSnapshotReference,
  retainTlhProjectAgentSnapshotReference,
  setTlhProjectAgentAccessProvider,
} from "./project-agent-access.mjs";
import {
  inventoryProjectAgentGuidance,
  type ProjectAgentGuidanceInventory,
} from "../shared/project-agent-guidance.js";
import type { TlhPrimaryAgentSelection } from "./types.js";

/**
 * Structural contract used by the injectable bridge. Callers still widen the
 * returned value to unknown before normalizeProjectDefaultsResult parses it.
 */
export interface ProjectDefaultsLoaderResult {
  readonly status: string;
  readonly warnings?: readonly unknown[];
  readonly defaults?: Record<string, unknown>;
  readonly projectRoot?: string;
  readonly trust?: Record<string, unknown>;
}

export type ProjectDefaultsLoader = (options: {
  cwd: string;
  sessionId?: string;
  agentDir?: string;
  defaultProjectTrust?: "ask" | "always" | "never";
  trust?: {
    sessionId?: string;
    trustOverride?: boolean;
    defaultProjectTrust?: "ask" | "always" | "never";
    createProjectTrustStore?: (agentDir: string) => object;
    hasTrustRequiringProjectResources?: (cwd: string) => boolean;
    isProjectTrusted?: () => boolean;
    hasUI?: boolean;
    trustUiTimeoutMs?: number;
    ui?: {
      confirm(
        title: string,
        message: string,
        options?: ExtensionUIDialogOptions,
      ): Promise<boolean> | boolean;
    };
  };
}) => Promise<ProjectDefaultsLoaderResult>;

export interface ProjectAgentSnapshotLoadResult {
  status: string;
  capability?: ProjectAgentCapability;
  trust?: { kind: "project-agent"; trusted: boolean; source: string };
  provenance?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
}

export type ProjectAgentSnapshotLoader = (options: {
  cwd: string;
  sessionId: string;
  agentDir: string;
  trustDependencies: {
    createProjectTrustStore: (agentDir: string) => object;
  };
}) => Promise<ProjectAgentSnapshotLoadResult>;

export type SessionStartOperation = {
  readonly requestId: number;
  readonly runtimeEpoch: number;
};

interface ProjectAgentRuntimeGlobalState {
  referenceId?: string;
  sessionId?: string;
  epoch: number;
}

const PROJECT_AGENT_RUNTIME_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-runtime-state");
const PROJECT_AGENT_RUNTIME_GLOBAL = globalThis as typeof globalThis & {
  [PROJECT_AGENT_RUNTIME_GLOBAL_KEY]?: ProjectAgentRuntimeGlobalState;
};
const PROJECT_AGENT_RUNTIME_STATE =
  PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] ??
  (PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] = { epoch: 0 });

const PROJECT_AGENT_TRUST_DEPENDENCIES = {
  createProjectTrustStore: (agentDir: string) => new ProjectTrustStore(agentDir),
};

type ProjectAgentReferenceLease = {
  referenceId: string;
  release: () => Promise<void>;
};

export type PrimaryAgentResourceLifecycle = {
  beginSessionStart(): SessionStartOperation;
  isCurrentRuntime(): boolean;
  isCurrentSessionStartOperation(operation: SessionStartOperation): boolean;
  loadSessionResources(ctx: ExtensionContext, operation: SessionStartOperation): Promise<void>;
  activeProjectAgentSnapshot(): ActiveProjectAgentSnapshot | undefined;
  activeProjectDefaultsForCwd(cwd: string): ActiveProjectDefaults | undefined;
  projectAgentGuidanceSnapshot(): ProjectAgentGuidanceInventory | undefined;
  warnProjectDefaultsOnce(
    ctx: ExtensionContext,
    projectRoot: string | undefined,
    agent: string | undefined,
    message: string,
    identityMessage?: string,
  ): void;
  /**
   * Invalidate this runtime's session resource state and release its owner
   * lease. Returns false only when a newer runtime/session operation won the
   * race; a release failure still returns true and never grants authority.
   * When supplied, `onCurrent` runs at the owner's final currentness guard so
   * facade cleanup cannot resume after a newer session takes ownership.
   */
  shutdown(onCurrent?: () => void): Promise<boolean>;
};

/**
 * Retire the process-global access provider before a replacement runtime is
 * registered. Clearing the owner id synchronously makes a failed asynchronous
 * cleanup unable to authorize the replacement runtime.
 */
export function retireTlhPrimaryAgentResourceRuntime(): void {
  setTlhProjectAgentAccessProvider(undefined);
  if (!PROJECT_AGENT_RUNTIME_STATE.referenceId) return;
  const previousReferenceId = PROJECT_AGENT_RUNTIME_STATE.referenceId;
  PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
  void releaseTlhProjectAgentSnapshotReference(previousReferenceId).catch(() => {
    // The new runtime starts without active project authority. A failed
    // cleanup cannot be used as authorization for the new runtime.
  });
}

export function createTlhPrimaryAgentResourceLifecycle(options: {
  getPrimaryAgentSelection: () => TlhPrimaryAgentSelection;
  hasActivePrimaryAgent: () => boolean;
  projectAgentLoader?: ProjectAgentSnapshotLoader;
  projectDefaultsLoader?: ProjectDefaultsLoader;
}): PrimaryAgentResourceLifecycle {
  const {
    getPrimaryAgentSelection,
    hasActivePrimaryAgent,
    projectAgentLoader = loadProjectAgentSnapshot,
    projectDefaultsLoader: projectDefaultsLoaderFn = loadProjectDefaults,
  } = options;

  const runtimeOwnerPrefix = `runtime:${randomUUID()}`;
  let runtimeReferenceId = `${runtimeOwnerPrefix}:owner:${randomUUID()}`;
  const runtimeEpoch = ++PROJECT_AGENT_RUNTIME_STATE.epoch;
  let activeProjectAgentSnapshot: ActiveProjectAgentSnapshot | undefined;
  let projectAgentLoadRequest = 0;
  let projectAgentTrustWarningSessionId: string | undefined;
  const projectDefaultsWarned = new Set<string>();
  let activeProjectDefaults: ActiveProjectDefaults | undefined;
  let sessionStartRequestId = 0;
  let sessionProjectAgentGuidanceSnapshot: ProjectAgentGuidanceInventory | undefined;

  const isCurrentProjectAgentOperation = (loadRequest: number, sessionId: string): boolean =>
    runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
    projectAgentLoadRequest === loadRequest &&
    PROJECT_AGENT_RUNTIME_STATE.sessionId === sessionId;

  const releaseProjectAgentReferenceQuietly = async (referenceId: string): Promise<void> => {
    try {
      await releaseTlhProjectAgentSnapshotReference(referenceId);
    } catch {
      // A failed cleanup can never become execution authority. Keep the
      // active state unchanged and do not fall back to the unverified result.
    }
  };

  const retainProjectAgentReferenceTemporarily = async (
    capability: ProjectAgentCapability,
    kind: "load" | "rebind",
  ): Promise<ProjectAgentReferenceLease | undefined> => {
    const referenceId = `${runtimeOwnerPrefix}:${kind}:${randomUUID()}`;
    try {
      await retainTlhProjectAgentSnapshotReference(capability, referenceId);
    } catch {
      // A structurally valid loader result without a registry capability is
      // not execution authority. Do not fall back to the returned metadata.
      return undefined;
    }
    let retained = true;
    return {
      referenceId,
      release: async () => {
        if (!retained) return;
        retained = false;
        await releaseProjectAgentReferenceQuietly(referenceId);
      },
    };
  };

  const isCurrentSessionStartOperation = (operation: SessionStartOperation): boolean =>
    operation.requestId === sessionStartRequestId &&
    operation.runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch;

  /**
   * The access provider is process-private and carries no model-facing fields.
   * It remains installed for this runtime's lifetime while its captured
   * capability is replaced on each session_start/reload.
   */
  setTlhProjectAgentAccessProvider(() => {
    const snapshot = activeProjectAgentSnapshot;
    if (!snapshot) return undefined;
    const selection = getPrimaryAgentSelection();
    const architect =
      selection === "architect" &&
      isEnabledPrimaryAgentSelection(selection) &&
      hasActivePrimaryAgent();
    return {
      capability: snapshot.capability,
      expected: snapshot.provenance,
      architect,
      // Disabled mode keeps the TLH safety plane active but intentionally has
      // no primary persona. It may still initiate an explicitly requested
      // project custom run; retained controls remain architect-only.
      canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
      ...(snapshot.reauthorizeTrust ? { reauthorize: snapshot.reauthorizeTrust } : {}),
      ...(snapshot.rebindProjectAgent ? { rebind: snapshot.rebindProjectAgent } : {}),
    };
  });

  function warnProjectDefaultsOnce(
    ctx: ExtensionContext,
    projectRoot: string | undefined,
    agent: string | undefined,
    message: string,
    identityMessage = message,
  ): void {
    const boundedMessage = truncateProjectDefaultsWarning(message);
    if (boundedMessage.length === 0) return;
    try {
      if (ctx.hasUI === false) return;
      const key = projectDefaultsWarningKey(
        projectRoot,
        ctx.cwd,
        agent,
        boundedMessage,
        identityMessage,
      );
      if (projectDefaultsWarned.has(key)) return;
      ctx.ui.notify(boundedMessage, "warning");
      projectDefaultsWarned.add(key);
    } catch {
      // Project/defaults diagnostics are advisory. A non-interactive or broken
      // notification surface must never escape session_start or dispatch.
    }
  }

  function warnPersistedProjectAgentTrustDenied(
    ctx: ExtensionContext,
    sessionId: string,
    loaded: unknown,
  ): void {
    if (
      ctx.hasUI === false ||
      projectAgentTrustWarningSessionId === sessionId ||
      !isPersistedProjectAgentTrustDenial(loaded)
    ) {
      return;
    }
    try {
      ctx.ui.notify(
        "TLH project custom agents are unavailable because persisted project trust does not authorize this project. Run /trust, persist trust for this project, then retry.",
        "warning",
      );
      projectAgentTrustWarningSessionId = sessionId;
    } catch {
      // A non-interactive or unavailable UI must not affect the fail-closed load.
    }
  }

  function notifyUndecidedProjectAgentGuidance(
    ctx: ExtensionContext,
    inventory: ProjectAgentGuidanceInventory,
  ): void {
    if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
      return;
    }

    const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
    if (!diagnostic) return;

    try {
      ctx.ui.notify(diagnostic.message, "warning");
    } catch {
      // Startup should remain usable when a non-interactive UI rejects a notification.
    }
  }

  function activeProjectDefaultsForCwd(cwd: string): ActiveProjectDefaults | undefined {
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch) return undefined;
    const defaults = activeProjectDefaults;
    if (defaults?.status !== "loaded" || !defaults.projectRoot) return undefined;
    const validation = validatePrimaryProjectAgentCwdContainment(defaults.projectRoot, cwd, []);
    return validation.valid ? defaults : undefined;
  }

  function attachProjectAgentRuntimeCallbacks(snapshot: ActiveProjectAgentSnapshot): void {
    if (!snapshot.trust) return;
    snapshot.reauthorizeTrust = async () => {
      try {
        const current = await reauthorizeTlhProjectAgentTrust(snapshot.provenance.projectRoot, {
          agentDir: getAgentDir(),
          trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
        });
        return current?.trusted === true;
      } catch {
        return false;
      }
    };
    snapshot.rebindProjectAgent = async (request) => {
      const runtimeLoadRequest = projectAgentLoadRequest;
      const runtimeSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
      const runtimeReferenceIdAtStart = runtimeReferenceId;
      const activeSnapshotAtStart = activeProjectAgentSnapshot;
      const agentMatch = /^embedded\.([a-z0-9][a-z0-9-]*)$/.exec(request.agent);
      if (
        !agentMatch ||
        !runtimeSessionId ||
        request.sessionId !== runtimeSessionId ||
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        activeSnapshotAtStart !== snapshot ||
        PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
      ) {
        return undefined;
      }
      const cwdValidation = validatePrimaryProjectAgentCwdContainment(
        request.projectRoot,
        request.cwd,
        [],
      );
      if (!cwdValidation.valid) return undefined;

      let loaded: unknown;
      try {
        loaded = await projectAgentLoader({
          cwd: request.cwd,
          sessionId: request.sessionId,
          agentDir: getAgentDir(),
          trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
        });
      } catch {
        return undefined;
      }
      const rebound = normalizeActiveProjectAgentSnapshot(loaded);
      if (!rebound) return undefined;

      // A loader registers the capability before returning it. Retain it before
      // any validation or stale-operation check can reject this load, then
      // release the lease in the finally block on every non-adoption path.
      const reboundLease = await retainProjectAgentReferenceTemporarily(
        rebound.capability,
        "rebind",
      );
      if (!reboundLease) return undefined;
      let adopted = false;
      try {
        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          !activeSnapshotAtStart ||
          rebound.trust?.trusted !== true ||
          rebound.provenance.sessionId !== request.sessionId ||
          rebound.provenance.processInstanceId !== snapshot.provenance.processInstanceId
        ) {
          return undefined;
        }

        let requestedRoot: string;
        let activeRoot: string;
        let reboundRoot: string;
        let reboundCwd: string;
        try {
          requestedRoot = fs.realpathSync(request.projectRoot);
          activeRoot = fs.realpathSync(snapshot.provenance.projectRoot);
          reboundRoot = fs.realpathSync(rebound.provenance.projectRoot);
          reboundCwd = fs.realpathSync(request.cwd);
        } catch {
          return undefined;
        }
        if (
          requestedRoot !== activeRoot ||
          requestedRoot !== reboundRoot ||
          !pathWithinProjectRoot(requestedRoot, reboundCwd)
        ) {
          return undefined;
        }

        const rawManifest =
          isRecord(loaded) && isRecord(loaded.manifest) ? loaded.manifest : undefined;
        const rawEntries = rawManifest?.entries;
        if (!Array.isArray(rawEntries)) return undefined;
        const rawEntry = rawEntries.find(
          (entry) => isRecord(entry) && isRecord(entry.agent) && entry.agent.name === request.agent,
        );
        if (!rawEntry || !isRecord(rawEntry.agent) || typeof rawEntry.digest !== "string") {
          return undefined;
        }
        const expectedPath = join(
          reboundRoot,
          ".tlh",
          "agents",
          "custom",
          `${agentMatch[1]!.toUpperCase()}.md`,
        );
        if (
          rawEntry.agent.name !== request.agent ||
          rawEntry.agent.localName !== agentMatch[1] ||
          rawEntry.agent.packageName !== "embedded" ||
          rawEntry.agent.source !== "project" ||
          rawEntry.agent.filePath !== expectedPath
        ) {
          return undefined;
        }

        const sameActiveCapability =
          activeSnapshotAtStart === snapshot &&
          PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceIdAtStart &&
          activeSnapshotAtStart.capability === rebound.capability;
        const makeRebindResult = (): ProjectAgentRebindResult => ({
          capability: rebound.capability,
          expected: { ...rebound.provenance },
          capture: {
            provenance: {
              ...rebound.provenance,
              source: "project",
              agent: request.agent,
              digest: rawEntry.digest as string,
            },
            config: rawEntry.agent as Record<string, unknown>,
          },
        });
        if (sameActiveCapability) return makeRebindResult();

        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          activeProjectAgentSnapshot !== activeSnapshotAtStart ||
          PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
        ) {
          return undefined;
        }
        try {
          // Retain-before-release preserves authority while the active owner
          // is transferred to this fresh generation.
          await releaseTlhProjectAgentSnapshotReference(runtimeReferenceIdAtStart);
        } catch {
          return undefined;
        }
        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          activeProjectAgentSnapshot !== activeSnapshotAtStart ||
          PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
        ) {
          return undefined;
        }

        attachProjectAgentRuntimeCallbacks(rebound);
        runtimeReferenceId = reboundLease.referenceId;
        PROJECT_AGENT_RUNTIME_STATE.referenceId = reboundLease.referenceId;
        activeProjectAgentSnapshot = rebound;
        adopted = true;
        return makeRebindResult();
      } finally {
        if (!adopted) await reboundLease.release();
      }
    };
  }

  async function loadProjectAgentSnapshotForSession(ctx: ExtensionContext): Promise<void> {
    // Replace only the active generation. Retained run references are owned by
    // the process-private snapshot registry and therefore survive same-session
    // reloads, while failed loads never authorize a new generation.
    const requestId = ++projectAgentLoadRequest;
    const previousReferenceId =
      runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
      PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
        ? runtimeReferenceId
        : undefined;
    activeProjectAgentSnapshot = undefined;
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch) return;
    if (previousReferenceId) {
      try {
        await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
      } catch {
        // A release failure leaves the old owner unavailable but must never
        // authorize a new capability or create an ambiguous owner reference.
        return;
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        requestId !== projectAgentLoadRequest ||
        PROJECT_AGENT_RUNTIME_STATE.referenceId !== previousReferenceId
      ) {
        return;
      }
      PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
    }
    const sessionId = sessionIdForContext(ctx);
    if (!sessionId) return;
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
      return;
    const previousSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
    if (previousSessionId && previousSessionId !== sessionId) {
      try {
        await releaseTlhProjectAgentRunReferencesForSession(previousSessionId);
      } catch {
        // Old-session run references cannot authorize a different current
        // session; continue loading, but never use them as the new authority.
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        requestId !== projectAgentLoadRequest ||
        PROJECT_AGENT_RUNTIME_STATE.sessionId !== previousSessionId
      ) {
        return;
      }
    }
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
      return;
    PROJECT_AGENT_RUNTIME_STATE.sessionId = sessionId;

    let loaded: unknown;
    try {
      loaded = await projectAgentLoader({
        cwd: ctx.cwd,
        sessionId,
        agentDir: getAgentDir(),
        trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
      });
    } catch {
      // Trust/scan failures are deliberately silent here. In particular, do
      // not turn an exception into permission to use an untrusted definition.
      return;
    }
    // Preserve the existing warning for a current persisted trust denial. A
    // denied result has no registered capability, while a loaded result is
    // retained immediately below before any stale-load rejection can abandon
    // its generation.
    if (isCurrentProjectAgentOperation(requestId, sessionId)) {
      warnPersistedProjectAgentTrustDenied(ctx, sessionId, loaded);
    }
    const normalized = normalizeActiveProjectAgentSnapshot(loaded);
    if (!normalized) return;

    // Retain the loader's newly registered capability before the current-load
    // check can reject a stale session start. The lease is transferred to the
    // runtime owner only after all adoption checks pass.
    const loadLease = await retainProjectAgentReferenceTemporarily(normalized.capability, "load");
    if (!loadLease) return;
    let adopted = false;
    try {
      if (!isCurrentProjectAgentOperation(requestId, sessionId)) return;
      attachProjectAgentRuntimeCallbacks(normalized);
      if (PROJECT_AGENT_RUNTIME_STATE.referenceId !== undefined) return;
      runtimeReferenceId = loadLease.referenceId;
      PROJECT_AGENT_RUNTIME_STATE.referenceId = loadLease.referenceId;
      activeProjectAgentSnapshot = normalized;
      adopted = true;
    } finally {
      if (!adopted) await loadLease.release();
    }
  }

  async function loadProjectDefaultsForSession(
    ctx: ExtensionContext,
    operation: SessionStartOperation,
  ): Promise<void> {
    /**
     * Configuration trust is deliberately separate from custom-agent execution
     * trust. A session/defaults approval can authorize model/effort defaults,
     * but can never authorize project custom-agent definitions.
     */
    if (!isCurrentSessionStartOperation(operation)) return;
    activeProjectDefaults = undefined;
    const sessionId = sessionIdForContext(ctx);
    if (!sessionId) return;

    let loaded: unknown;
    try {
      const defaultProjectTrust = defaultProjectTrustForCwd(ctx.cwd);
      loaded = await projectDefaultsLoaderFn({
        cwd: ctx.cwd,
        sessionId,
        agentDir: getAgentDir(),
        defaultProjectTrust,
        trust: {
          sessionId,
          defaultProjectTrust,
          createProjectTrustStore: PROJECT_AGENT_TRUST_DEPENDENCIES.createProjectTrustStore,
          hasTrustRequiringProjectResources,
          isProjectTrusted: () => ctx.isProjectTrusted(),
          hasUI: ctx.hasUI,
          ui:
            typeof ctx.ui?.confirm === "function"
              ? {
                  confirm: (title: string, message: string, options?: ExtensionUIDialogOptions) =>
                    ctx.ui.confirm(title, message, options),
                }
              : undefined,
        },
      });
    } catch {
      // Defaults-load failures are deliberately silent; never crash the session.
      return;
    }

    if (!isCurrentSessionStartOperation(operation)) return;

    let normalized: ActiveProjectDefaults | undefined;
    try {
      normalized = normalizeProjectDefaultsResult(loaded, ctx.cwd);
    } catch {
      // Malformed injected bridge values (including throwing getters/proxies)
      // must fail closed without escaping session_start.
      return;
    }
    if (!isCurrentSessionStartOperation(operation)) return;
    if (normalized?.status === "loaded") {
      for (const warning of normalized.warnings) {
        if (!isCurrentSessionStartOperation(operation)) return;
        warnProjectDefaultsOnce(ctx, normalized.projectRoot, undefined, warning);
      }
    }
    if (!isCurrentSessionStartOperation(operation)) return;
    activeProjectDefaults = normalized ?? undefined;
  }

  function beginSessionStart(): SessionStartOperation {
    const operation: SessionStartOperation = {
      requestId: ++sessionStartRequestId,
      runtimeEpoch,
    };
    // Invalidate the prior session's configuration plane immediately. A slow
    // capability load must not leave old project defaults available to a new
    // session before its own defaults operation reaches the loader.
    activeProjectDefaults = undefined;
    projectDefaultsWarned.clear();
    return operation;
  }

  async function loadSessionResources(
    ctx: ExtensionContext,
    operation: SessionStartOperation,
  ): Promise<void> {
    if (!isCurrentSessionStartOperation(operation)) return;
    await loadProjectAgentSnapshotForSession(ctx);
    if (!isCurrentSessionStartOperation(operation)) return;
    sessionProjectAgentGuidanceSnapshot = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
    notifyUndecidedProjectAgentGuidance(ctx, sessionProjectAgentGuidanceSnapshot);
    if (!isCurrentSessionStartOperation(operation)) return;
    await loadProjectDefaultsForSession(ctx, operation);
  }

  async function shutdown(onCurrent?: () => void): Promise<boolean> {
    // Invalidate resource operations before awaiting cleanup. A stale loader or
    // rebind can retain a registry capability, but it can never adopt it after
    // these counters move or after the active snapshot is cleared.
    sessionStartRequestId += 1;
    const shutdownRequestId = ++projectAgentLoadRequest;
    const previousReferenceId =
      runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
      PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
        ? runtimeReferenceId
        : undefined;
    activeProjectDefaults = undefined;
    projectDefaultsWarned.clear();
    activeProjectAgentSnapshot = undefined;
    if (previousReferenceId) {
      let released = true;
      try {
        await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
      } catch {
        released = false;
        // A release failure must not turn the stale capability into a new
        // authorization path. Leave the owner id for a later retry while
        // keeping this runtime's active snapshot unavailable.
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        shutdownRequestId !== projectAgentLoadRequest
      ) {
        return false;
      }
      if (released && PROJECT_AGENT_RUNTIME_STATE.referenceId === previousReferenceId) {
        PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
      }
    }
    if (
      runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
      shutdownRequestId !== projectAgentLoadRequest
    ) {
      return false;
    }
    sessionProjectAgentGuidanceSnapshot = undefined;
    projectAgentTrustWarningSessionId = undefined;
    onCurrent?.();
    return true;
  }

  return {
    beginSessionStart,
    isCurrentRuntime: () => runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch,
    isCurrentSessionStartOperation,
    loadSessionResources,
    activeProjectAgentSnapshot: () => activeProjectAgentSnapshot,
    activeProjectDefaultsForCwd,
    projectAgentGuidanceSnapshot: () => sessionProjectAgentGuidanceSnapshot,
    warnProjectDefaultsOnce,
    shutdown,
  };
}
