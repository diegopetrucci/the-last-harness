// TLH compatibility shim for Pi's model persistence boundary.
// See ../../docs/upstream-sync-inventory.md before changing this compatibility seam.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  AgentSession,
  getPackageDir,
  VERSION,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { safeTlhProfileFilePath } from "./profile-state.js";

type TlhModelSelection = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
type AgentSessionModel = Parameters<typeof AgentSession.prototype.setModel>[0];
type AgentSessionModelMutationOptions = Parameters<typeof AgentSession.prototype.setModel>[1];
type AgentSessionPrototype = typeof AgentSession.prototype;
type AgentSessionConstructor = { prototype: AgentSessionPrototype };
type AgentSessionModelSetter = typeof AgentSession.prototype.setModel;

declare const TLH_MODEL_SELECTION_SESSION_BRAND: unique symbol;

/** Opaque identity owned by the runtime that currently owns model correlation. */
export type TlhModelSelectionPersistenceSession = {
  readonly [TLH_MODEL_SELECTION_SESSION_BRAND]: true;
};

type TlhModelSelectionPersistenceContext = {
  session: TlhModelSelectionPersistenceSession;
  generation: number;
  onSameModelPersistence: ((model: TlhModelSelection) => void) | undefined;
};

type TlhModelSelectionPersistenceInvocation = {
  session: TlhModelSelectionPersistenceSession | undefined;
  generation: number | undefined;
  persist: boolean;
  model: TlhModelSelection;
  previousModel: TlhModelSelection | undefined;
};

type TlhModelSelectionPersistencePatch = {
  ownerToken: object;
  modelSelectionContext: AsyncLocalStorage<TlhModelSelectionPersistenceInvocation>;
  entries: TlhModelSelectionPersistencePatchEntry[];
  state: TlhModelSelectionPersistenceState;
};

type TlhModelSelectionPersistencePatchEntry = {
  prototype: PatchedAgentSessionPrototype;
  original: AgentSessionModelSetter;
  wrapper: AgentSessionModelSetter;
};

type TlhModelSelectionPersistenceState = {
  nextGeneration: number;
  modelContext: TlhModelSelectionPersistenceContext | undefined;
  claimedInvocations: WeakSet<TlhModelSelectionPersistenceInvocation>;
};

type TlhModelSelectionDefaultsClaim = {
  persisted: true;
};

type PatchedAgentSessionPrototype = AgentSessionPrototype & {
  [TLH_MODEL_SELECTION_PERSISTENCE_PATCH]?: TlhModelSelectionPersistencePatch;
};

const TLH_MODEL_SELECTION_PERSISTENCE_PATCH = Symbol.for("tlh.modelSelectionPersistencePatch");
const BUNDLED_NODE_ENTRYPOINT_RE = /(?:^|[/\\])dist[/\\]bundle[/\\]cli\.js$/;
const PINNED_PI_VERSION = "0.84.4";
const tlhRequire = createRequire(import.meta.url);

type BundledPackageResolution =
  | { status: "not-bundled" }
  | { status: "safe"; packageDir: string }
  | { status: "unsafe"; reason: string };

type BundledAgentSessionResolution =
  | { status: "not-bundled" }
  | { status: "safe"; constructor: AgentSessionConstructor }
  | { status: "unsafe"; reason: string };

const bundledAgentSessionConstructors = new Map<string, AgentSessionConstructor | undefined>();
let bundledAgentSessionResolution: BundledAgentSessionResolution | undefined;
let modelSelectionPersistenceInstallAttempted = false;
let installedModelSelectionPersistencePatch: TlhModelSelectionPersistencePatch | undefined;

function isAgentSessionConstructor(value: unknown): value is AgentSessionConstructor {
  if (typeof value !== "function") {
    return false;
  }
  const prototype = (value as { prototype?: unknown }).prototype;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    typeof (prototype as { setModel?: unknown }).setModel === "function"
  );
}

function asAgentSessionConstructor(value: unknown): AgentSessionConstructor | undefined {
  const candidate =
    typeof value === "function"
      ? value
      : typeof value === "object" && value !== null
        ? (value as { AgentSession?: unknown }).AgentSession
        : undefined;
  return isAgentSessionConstructor(candidate) ? candidate : undefined;
}

function getRealBundledCliEntrypoint(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return undefined;
  }
  try {
    const realEntrypoint = realpathSync(entrypoint);
    return BUNDLED_NODE_ENTRYPOINT_RE.test(realEntrypoint) ? realEntrypoint : undefined;
  } catch {
    // An unknown or synthetic entrypoint is not enough to authorize loading a
    // second Pi runtime. Only a canonical, existing bundle CLI can opt in.
    return undefined;
  }
}

function isPathContained(root: string, child: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(child)) {
    return false;
  }
  const childRelative = relative(root, child);
  return (
    childRelative !== "" &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`) &&
    !isAbsolute(childRelative)
  );
}

function validateBundledPackageRoot(
  packageDir: string,
  cliEntrypoint: string,
): BundledPackageResolution {
  try {
    const canonicalPackageDir = realpathSync(packageDir);
    const expectedCli = join(canonicalPackageDir, "dist", "bundle", "cli.js");
    const expectedIndex = join(canonicalPackageDir, "dist", "bundle", "index.js");
    const expectedPackageJson = join(canonicalPackageDir, "package.json");
    const expectedDist = join(canonicalPackageDir, "dist");
    const expectedBundle = join(expectedDist, "bundle");

    if (canonicalPackageDir !== packageDir || cliEntrypoint !== expectedCli) {
      return {
        status: "unsafe",
        reason: "the bundled CLI or package root resolves through an unexpected path",
      };
    }
    if (
      !isPathContained(canonicalPackageDir, cliEntrypoint) ||
      !isPathContained(canonicalPackageDir, expectedIndex) ||
      !isPathContained(canonicalPackageDir, expectedPackageJson)
    ) {
      return { status: "unsafe", reason: "the published bundle path escapes its package root" };
    }
    for (const directory of [expectedDist, expectedBundle]) {
      if (realpathSync(directory) !== directory || !statSync(directory).isDirectory()) {
        return { status: "unsafe", reason: "the published bundle directory is not canonical" };
      }
    }
    for (const file of [expectedCli, expectedIndex, expectedPackageJson]) {
      if (realpathSync(file) !== file || !statSync(file).isFile()) {
        return { status: "unsafe", reason: "the published bundle file layout is not canonical" };
      }
    }

    const packageMetadata = JSON.parse(readFileSync(expectedPackageJson, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      VERSION !== PINNED_PI_VERSION ||
      packageMetadata.name !== "@earendil-works/pi-coding-agent" ||
      packageMetadata.version !== VERSION
    ) {
      return {
        status: "unsafe",
        reason: `expected @earendil-works/pi-coding-agent ${PINNED_PI_VERSION}`,
      };
    }
    return { status: "safe", packageDir: canonicalPackageDir };
  } catch (error) {
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve the published Pi bundle used by the active Node CLI.
 *
 * The normal source is Pi's canonical getPackageDir(). A file-source TLH
 * install can resolve that helper from a different development copy, however;
 * only in that case do we anchor the fallback to the real CLI executable's
 * exact dist/bundle/cli.js layout. We never search cwd, PATH, NODE_PATH, or
 * node_modules for a runtime package.
 */
function resolveBundledPackage(): BundledPackageResolution {
  const cliEntrypoint = getRealBundledCliEntrypoint();
  if (!cliEntrypoint) {
    return { status: "not-bundled" };
  }

  let importedPackageDir: string | undefined;
  try {
    importedPackageDir = realpathSync(getPackageDir());
  } catch {
    // The executable-anchored fallback below remains safe if its exact
    // published layout and metadata validate.
  }

  if (importedPackageDir) {
    const importedCli = join(importedPackageDir, "dist", "bundle", "cli.js");
    if (cliEntrypoint === importedCli) {
      return validateBundledPackageRoot(importedPackageDir, cliEntrypoint);
    }
  }

  // The active entrypoint is already canonical and has the exact published
  // layout. Derive the root only by walking that known layout; do not accept a
  // caller-provided path or probe any sibling/parent package directories.
  const activePackageDir = dirname(dirname(dirname(cliEntrypoint)));
  return validateBundledPackageRoot(activePackageDir, cliEntrypoint);
}

function getBundledAgentSessionConstructor(
  packageDir: string,
): AgentSessionConstructor | undefined {
  if (bundledAgentSessionConstructors.has(packageDir)) {
    return bundledAgentSessionConstructors.get(packageDir);
  }

  const bundlePath = join(packageDir, "dist", "bundle", "index.js");
  try {
    const bundledModule = tlhRequire(bundlePath) as unknown;
    const bundledConstructor = asAgentSessionConstructor(bundledModule);
    if (!bundledConstructor) {
      throw new Error("the published bundle does not export AgentSession with setModel");
    }
    bundledAgentSessionConstructors.set(packageDir, bundledConstructor);
    return bundledConstructor;
  } catch (error) {
    console.warn(
      `[TLH] Unable to load Pi's bundled AgentSession entry ${bundlePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    bundledAgentSessionConstructors.set(packageDir, undefined);
    return undefined;
  }
}

function getAgentSessionConstructors(
  bundledAgentSession?: unknown,
): AgentSessionConstructor[] | undefined {
  const modularConstructor: AgentSessionConstructor = AgentSession;
  const constructors: AgentSessionConstructor[] = [modularConstructor];
  const cachedResolution = bundledAgentSessionResolution;
  if (cachedResolution) {
    if (cachedResolution.status === "not-bundled") {
      return constructors;
    }
    if (cachedResolution.status === "unsafe") {
      console.warn(
        `[TLH] installTlhModelSelectionPersistenceOverride: refusing an unsafe Pi bundle: ${cachedResolution.reason}`,
      );
      return undefined;
    }
    if (cachedResolution.constructor.prototype !== modularConstructor.prototype) {
      constructors.push(cachedResolution.constructor);
    }
    return constructors;
  }

  if (bundledAgentSession !== undefined) {
    const validatedBundledAgentSession = asAgentSessionConstructor(bundledAgentSession);
    if (!validatedBundledAgentSession) {
      const reason = "the virtual Pi module has no valid AgentSession.setModel export";
      bundledAgentSessionResolution = { status: "unsafe", reason };
      console.warn(
        `[TLH] installTlhModelSelectionPersistenceOverride: ${reason}; refusing a partial installation.`,
      );
      return undefined;
    }
    if (validatedBundledAgentSession.prototype !== modularConstructor.prototype) {
      bundledAgentSessionResolution = {
        status: "safe",
        constructor: validatedBundledAgentSession,
      };
      constructors.push(validatedBundledAgentSession);
      return constructors;
    }
    // A native extension import can resolve to the modular copy even while
    // Pi is running its bundled CLI. Treat that as no virtual bundle route and
    // continue through the canonical executable resolution below.
  }

  const packageResolution = resolveBundledPackage();
  if (packageResolution.status === "not-bundled") {
    bundledAgentSessionResolution = { status: "not-bundled" };
    return constructors;
  }
  if (packageResolution.status === "unsafe") {
    bundledAgentSessionResolution = packageResolution;
    console.warn(
      `[TLH] installTlhModelSelectionPersistenceOverride: refusing an unsafe Pi bundle: ${packageResolution.reason}`,
    );
    return undefined;
  }

  const bundledConstructor = getBundledAgentSessionConstructor(packageResolution.packageDir);
  if (!bundledConstructor) {
    const reason = "the published bundle does not export AgentSession with setModel";
    bundledAgentSessionResolution = { status: "unsafe", reason };
    return undefined;
  }
  bundledAgentSessionResolution = { status: "safe", constructor: bundledConstructor };
  if (!constructors.some((candidate) => candidate.prototype === bundledConstructor.prototype)) {
    constructors.push(bundledConstructor);
  }
  return constructors;
}

function getPatchedPrototype(
  constructor: AgentSessionConstructor = AgentSession,
): PatchedAgentSessionPrototype {
  return constructor.prototype as PatchedAgentSessionPrototype;
}

function isModelSelectionPersistencePatch(
  value: unknown,
): value is TlhModelSelectionPersistencePatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TlhModelSelectionPersistencePatch>;
  return (
    typeof candidate.ownerToken === "object" &&
    candidate.ownerToken !== null &&
    typeof candidate.modelSelectionContext?.run === "function" &&
    Array.isArray(candidate.entries) &&
    typeof candidate.state === "object" &&
    candidate.state !== null &&
    candidate.state.claimedInvocations instanceof WeakSet
  );
}

function getPatchFromPrototype(
  prototype: PatchedAgentSessionPrototype,
): TlhModelSelectionPersistencePatch | undefined {
  const value = prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
  return isModelSelectionPersistencePatch(value) ? value : undefined;
}

function getInstalledPatch(): TlhModelSelectionPersistencePatch | undefined {
  // Installation resolves and validates the active Pi runtime exactly once.
  // Keep this hot-path lookup independent of package files so a later move or
  // transient filesystem failure cannot silently disable an installed seam.
  return installedModelSelectionPersistencePatch;
}

function canWriteTlhDefaults(): boolean {
  // The TLH wrapper always supplies a safe isolated path. Do not install the
  // process-wide model wrapper for a normal Pi profile.
  return safeTlhProfileFilePath("settings.json") !== undefined;
}

function modelMatches(
  left: TlhModelSelection | undefined,
  right: TlhModelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.provider === right.provider && left.id === right.id;
}

function asModelSelection(model: AgentSessionModel | TlhModelSelection): TlhModelSelection;
function asModelSelection(
  model: AgentSessionModel | TlhModelSelection | undefined,
): TlhModelSelection | undefined;
function asModelSelection(
  model: AgentSessionModel | TlhModelSelection | undefined,
): TlhModelSelection | undefined {
  return model ? { provider: model.provider, id: model.id } : undefined;
}

function currentModelSelectionPersistence(
  patch: TlhModelSelectionPersistencePatch,
  session: TlhModelSelectionPersistenceSession,
): TlhModelSelectionPersistenceInvocation | undefined {
  const context = patch.state.modelContext;
  const invocation = patch.modelSelectionContext.getStore();
  if (
    !context ||
    context.session !== session ||
    !invocation ||
    invocation.session !== session ||
    invocation.generation !== context.generation
  ) {
    return undefined;
  }
  return invocation;
}

function createSetModelWrapper(
  patch: TlhModelSelectionPersistencePatch,
  original: AgentSessionModelSetter,
): AgentSessionModelSetter {
  return function (
    this: AgentSession,
    model: AgentSessionModel,
    options?: AgentSessionModelMutationOptions,
  ): Promise<void> {
    const activeContext = patch.state.modelContext;
    const invocation: TlhModelSelectionPersistenceInvocation = {
      session: activeContext?.session,
      generation: activeContext?.generation,
      persist: options?.persist === true,
      model: asModelSelection(model),
      previousModel: undefined,
    };

    const result = patch.modelSelectionContext.run(invocation, () => {
      invocation.previousModel = asModelSelection(this.model);
      return arguments.length > 1
        ? original.call(this, model, options)
        : original.call(this, model);
    });

    // Attach the side effect to the original promise but return that exact
    // promise. This keeps Pi's return identity and rejection semantics intact;
    // a callback failure is swallowed after successful persistence so it can
    // never change the public setModel result.
    void result.then(
      () => {
        if (!invocation.persist || !modelMatches(invocation.previousModel, invocation.model)) {
          return;
        }
        const currentContext = patch.state.modelContext;
        if (
          !invocation.session ||
          !currentContext ||
          currentContext.session !== invocation.session ||
          currentContext.generation !== invocation.generation
        ) {
          return;
        }
        try {
          currentContext.onSameModelPersistence?.(invocation.model);
        } catch {
          // Pi's durable setModel operation has already succeeded. TLH's
          // compatibility side effect must not alter its result.
        }
      },
      () => {
        // Failed setModel calls must not invoke same-model persistence effects.
      },
    );
    return result;
  };
}

function createModelSelectionPersistencePatch(): TlhModelSelectionPersistencePatch {
  return {
    ownerToken: Object.freeze({}),
    modelSelectionContext: new AsyncLocalStorage<TlhModelSelectionPersistenceInvocation>(),
    entries: [],
    state: {
      nextGeneration: 0,
      modelContext: undefined,
      claimedInvocations: new WeakSet<TlhModelSelectionPersistenceInvocation>(),
    },
  };
}

/**
 * Install TLH's narrow model provenance wrapper. Pi 0.84.4 owns model
 * persistence and dispatches model_select from AgentSession.setModel; the
 * public method's awaited call boundary is the only place where `persist` is
 * available throughout the complete extension dispatch.
 *
 * Pi's package export map gives modular imports and the bundled Node CLI
 * distinct AgentSession constructors. When the latter is the active entry
 * point, both prototypes receive one shared, owner-marked patch atomically.
 */
export function installTlhModelSelectionPersistenceOverride(
  bundledAgentSession?: unknown,
): boolean {
  if (modelSelectionPersistenceInstallAttempted) {
    return installedModelSelectionPersistencePatch !== undefined;
  }
  modelSelectionPersistenceInstallAttempted = true;

  if (!canWriteTlhDefaults()) {
    return false;
  }

  const constructors = getAgentSessionConstructors(bundledAgentSession);
  if (!constructors) {
    return false;
  }
  const targets = constructors.map((constructor) => getPatchedPrototype(constructor));
  const rawPatches = targets.map((prototype) => prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH]);
  if (rawPatches.some((value) => value !== undefined && !isModelSelectionPersistencePatch(value))) {
    console.warn(
      "[TLH] installTlhModelSelectionPersistenceOverride: an AgentSession prototype has an unknown owner; " +
        "refusing to overwrite it.",
    );
    return false;
  }

  const existingPatches = [
    ...new Set(
      rawPatches.filter((value): value is TlhModelSelectionPersistencePatch =>
        isModelSelectionPersistencePatch(value),
      ),
    ),
  ];
  if (existingPatches.length > 1) {
    console.warn(
      "[TLH] installTlhModelSelectionPersistenceOverride: AgentSession prototypes have different owners; " +
        "refusing a split installation.",
    );
    return false;
  }

  const patch = existingPatches[0] ?? createModelSelectionPersistencePatch();
  for (const target of targets) {
    const existingPatch = getPatchFromPrototype(target);
    if (existingPatch === patch && !patch.entries.some((entry) => entry.prototype === target)) {
      console.warn(
        "[TLH] installTlhModelSelectionPersistenceOverride: an existing owner is missing its prototype entry; " +
          "refusing to guess the original setter.",
      );
      return false;
    }
    if (!existingPatch && typeof target.setModel !== "function") {
      console.warn(
        "[TLH] installTlhModelSelectionPersistenceOverride: AgentSession.setModel is unavailable; " +
          "skipping wrapper.",
      );
      return false;
    }
  }

  const installedEntries: TlhModelSelectionPersistencePatchEntry[] = [];
  try {
    for (const target of targets) {
      if (getPatchFromPrototype(target)) {
        continue;
      }

      const original = target.setModel;
      const wrapper = createSetModelWrapper(patch, original);
      const entry: TlhModelSelectionPersistencePatchEntry = {
        prototype: target,
        original,
        wrapper,
      };
      installedEntries.push(entry);
      target.setModel = wrapper;
      Object.defineProperty(target, TLH_MODEL_SELECTION_PERSISTENCE_PATCH, {
        configurable: true,
        enumerable: false,
        value: patch,
        writable: false,
      });
      patch.entries.push(entry);
    }
  } catch {
    // Installation is all-or-nothing. The marker is configurable solely so a
    // partial second-prototype install can be rolled back without touching an
    // owner that was already present before this call.
    for (const entry of installedEntries.reverse()) {
      try {
        if (entry.prototype.setModel === entry.wrapper) {
          entry.prototype.setModel = entry.original;
        }
      } catch {
        // Keep attempting the remaining rollback steps and targets.
      }
      try {
        if (entry.prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH] === patch) {
          delete entry.prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
        }
      } catch {
        // A hostile/non-configurable target cannot be repaired further here.
      }
      const entryIndex = patch.entries.indexOf(entry);
      if (entryIndex >= 0) {
        patch.entries.splice(entryIndex, 1);
      }
    }
    return false;
  }
  installedModelSelectionPersistencePatch = patch;
  return true;
}

/** Start a new active session correlation context and return its opaque owner token. */
export function beginTlhModelSelectionPersistenceSession(
  onSameModelPersistence: (model: TlhModelSelection) => void,
): TlhModelSelectionPersistenceSession | undefined {
  const patch = getInstalledPatch();
  if (!patch) {
    return undefined;
  }
  const session = Object.freeze({}) as TlhModelSelectionPersistenceSession;
  const generation = patch.state.nextGeneration + 1;
  patch.state.nextGeneration = generation;
  patch.state.modelContext = {
    session,
    generation,
    onSameModelPersistence,
  };
  return session;
}

/** Update the live session context without opening a new correlation epoch. */
export function updateTlhModelSelectionPersistenceContext(
  session: TlhModelSelectionPersistenceSession,
  onSameModelPersistence?: (model: TlhModelSelection) => void,
): void {
  const patch = getInstalledPatch();
  if (!patch) {
    return;
  }
  const context = patch.state.modelContext;
  if (!context || context.session !== session) {
    return;
  }
  if (onSameModelPersistence !== undefined) {
    context.onSameModelPersistence = onSameModelPersistence;
  }
}

/**
 * Read the current setModel provenance for one owner. The async context and
 * owner token are both required, so stale runtimes cannot read a newer call.
 */
export function readTlhModelSelectionPersistence(
  session: TlhModelSelectionPersistenceSession,
): TlhModelSelectionPersistenceInvocation | undefined {
  const patch = getInstalledPatch();
  return patch ? currentModelSelectionPersistence(patch, session) : undefined;
}

/** End the active session epoch and discard all unconsumed model provenance. */
export function endTlhModelSelectionPersistenceSession(
  session: TlhModelSelectionPersistenceSession,
): void {
  const patch = getInstalledPatch();
  if (!patch || patch.state.modelContext?.session !== session) {
    return;
  }
  patch.state.modelContext = undefined;
}

/** Claim the matching persisted setModel invocation for a model_select event. */
export function claimTlhModelSelectionDefaults(
  session: TlhModelSelectionPersistenceSession,
  model: TlhModelSelection,
  previousModel?: TlhModelSelection,
): TlhModelSelectionDefaultsClaim | undefined {
  const patch = getInstalledPatch();
  if (!patch) {
    return undefined;
  }
  const invocation = readTlhModelSelectionPersistence(session);
  if (
    !invocation ||
    !invocation.persist ||
    !modelMatches(invocation.model, model) ||
    !modelMatches(invocation.previousModel, previousModel) ||
    patch.state.claimedInvocations.has(invocation)
  ) {
    return undefined;
  }
  patch.state.claimedInvocations.add(invocation);
  return { persisted: true };
}

export function isTlhPersistedModelSelection(
  claim: TlhModelSelectionDefaultsClaim | undefined,
): boolean {
  return claim?.persisted === true;
}
