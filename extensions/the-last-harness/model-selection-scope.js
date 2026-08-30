import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { AgentSession, getPackageDir, VERSION, } from "@earendil-works/pi-coding-agent";
import { safeTlhProfileFilePath } from "./profile-state.js";
const TLH_MODEL_SELECTION_PERSISTENCE_PATCH = Symbol.for("tlh.modelSelectionPersistencePatch");
const BUNDLED_NODE_ENTRYPOINT_RE = /(?:^|[/\\])dist[/\\]bundle[/\\]cli\.js$/;
const PINNED_PI_VERSION = "0.84.4";
const tlhRequire = createRequire(import.meta.url);
const bundledAgentSessionConstructors = new Map();
let bundledAgentSessionResolution;
let modelSelectionPersistenceInstallAttempted = false;
let installedModelSelectionPersistencePatch;
function isAgentSessionConstructor(value) {
    if (typeof value !== "function") {
        return false;
    }
    const prototype = value.prototype;
    return (typeof prototype === "object" &&
        prototype !== null &&
        typeof prototype.setModel === "function");
}
function asAgentSessionConstructor(value) {
    const candidate = typeof value === "function"
        ? value
        : typeof value === "object" && value !== null
            ? value.AgentSession
            : undefined;
    return isAgentSessionConstructor(candidate) ? candidate : undefined;
}
function getRealBundledCliEntrypoint() {
    const entrypoint = process.argv[1];
    if (!entrypoint) {
        return undefined;
    }
    try {
        const realEntrypoint = realpathSync(entrypoint);
        return BUNDLED_NODE_ENTRYPOINT_RE.test(realEntrypoint) ? realEntrypoint : undefined;
    }
    catch {
        return undefined;
    }
}
function isPathContained(root, child) {
    if (!isAbsolute(root) || !isAbsolute(child)) {
        return false;
    }
    const childRelative = relative(root, child);
    return (childRelative !== "" &&
        childRelative !== ".." &&
        !childRelative.startsWith(`..${sep}`) &&
        !isAbsolute(childRelative));
}
function validateBundledPackageRoot(packageDir, cliEntrypoint) {
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
        if (!isPathContained(canonicalPackageDir, cliEntrypoint) ||
            !isPathContained(canonicalPackageDir, expectedIndex) ||
            !isPathContained(canonicalPackageDir, expectedPackageJson)) {
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
        const packageMetadata = JSON.parse(readFileSync(expectedPackageJson, "utf8"));
        if (VERSION !== PINNED_PI_VERSION ||
            packageMetadata.name !== "@earendil-works/pi-coding-agent" ||
            packageMetadata.version !== VERSION) {
            return {
                status: "unsafe",
                reason: `expected @earendil-works/pi-coding-agent ${PINNED_PI_VERSION}`,
            };
        }
        return { status: "safe", packageDir: canonicalPackageDir };
    }
    catch (error) {
        return {
            status: "unsafe",
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
function resolveBundledPackage() {
    const cliEntrypoint = getRealBundledCliEntrypoint();
    if (!cliEntrypoint) {
        return { status: "not-bundled" };
    }
    let importedPackageDir;
    try {
        importedPackageDir = realpathSync(getPackageDir());
    }
    catch {
    }
    if (importedPackageDir) {
        const importedCli = join(importedPackageDir, "dist", "bundle", "cli.js");
        if (cliEntrypoint === importedCli) {
            return validateBundledPackageRoot(importedPackageDir, cliEntrypoint);
        }
    }
    const activePackageDir = dirname(dirname(dirname(cliEntrypoint)));
    return validateBundledPackageRoot(activePackageDir, cliEntrypoint);
}
function getBundledAgentSessionConstructor(packageDir) {
    if (bundledAgentSessionConstructors.has(packageDir)) {
        return bundledAgentSessionConstructors.get(packageDir);
    }
    const bundlePath = join(packageDir, "dist", "bundle", "index.js");
    try {
        const bundledModule = tlhRequire(bundlePath);
        const bundledConstructor = asAgentSessionConstructor(bundledModule);
        if (!bundledConstructor) {
            throw new Error("the published bundle does not export AgentSession with setModel");
        }
        bundledAgentSessionConstructors.set(packageDir, bundledConstructor);
        return bundledConstructor;
    }
    catch (error) {
        console.warn(`[TLH] Unable to load Pi's bundled AgentSession entry ${bundlePath}: ${error instanceof Error ? error.message : String(error)}`);
        bundledAgentSessionConstructors.set(packageDir, undefined);
        return undefined;
    }
}
function getAgentSessionConstructors(bundledAgentSession) {
    const modularConstructor = AgentSession;
    const constructors = [modularConstructor];
    const cachedResolution = bundledAgentSessionResolution;
    if (cachedResolution) {
        if (cachedResolution.status === "not-bundled") {
            return constructors;
        }
        if (cachedResolution.status === "unsafe") {
            console.warn(`[TLH] installTlhModelSelectionPersistenceOverride: refusing an unsafe Pi bundle: ${cachedResolution.reason}`);
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
            console.warn(`[TLH] installTlhModelSelectionPersistenceOverride: ${reason}; refusing a partial installation.`);
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
    }
    const packageResolution = resolveBundledPackage();
    if (packageResolution.status === "not-bundled") {
        bundledAgentSessionResolution = { status: "not-bundled" };
        return constructors;
    }
    if (packageResolution.status === "unsafe") {
        bundledAgentSessionResolution = packageResolution;
        console.warn(`[TLH] installTlhModelSelectionPersistenceOverride: refusing an unsafe Pi bundle: ${packageResolution.reason}`);
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
function getPatchedPrototype(constructor = AgentSession) {
    return constructor.prototype;
}
function isModelSelectionPersistencePatch(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value;
    return (typeof candidate.ownerToken === "object" &&
        candidate.ownerToken !== null &&
        typeof candidate.modelSelectionContext?.run === "function" &&
        Array.isArray(candidate.entries) &&
        typeof candidate.state === "object" &&
        candidate.state !== null &&
        candidate.state.claimedInvocations instanceof WeakSet);
}
function getPatchFromPrototype(prototype) {
    const value = prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
    return isModelSelectionPersistencePatch(value) ? value : undefined;
}
function getInstalledPatch() {
    return installedModelSelectionPersistencePatch;
}
function canWriteTlhDefaults() {
    return safeTlhProfileFilePath("settings.json") !== undefined;
}
function modelMatches(left, right) {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    return left.provider === right.provider && left.id === right.id;
}
function asModelSelection(model) {
    return model ? { provider: model.provider, id: model.id } : undefined;
}
function currentModelSelectionPersistence(patch, session) {
    const context = patch.state.modelContext;
    const invocation = patch.modelSelectionContext.getStore();
    if (!context ||
        context.session !== session ||
        !invocation ||
        invocation.session !== session ||
        invocation.generation !== context.generation) {
        return undefined;
    }
    return invocation;
}
function createSetModelWrapper(patch, original) {
    return function (model, options) {
        const activeContext = patch.state.modelContext;
        const invocation = {
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
        void result.then(() => {
            if (!invocation.persist || !modelMatches(invocation.previousModel, invocation.model)) {
                return;
            }
            const currentContext = patch.state.modelContext;
            if (!invocation.session ||
                !currentContext ||
                currentContext.session !== invocation.session ||
                currentContext.generation !== invocation.generation) {
                return;
            }
            try {
                currentContext.onSameModelPersistence?.(invocation.model);
            }
            catch {
            }
        }, () => {
        });
        return result;
    };
}
function createModelSelectionPersistencePatch() {
    return {
        ownerToken: Object.freeze({}),
        modelSelectionContext: new AsyncLocalStorage(),
        entries: [],
        state: {
            nextGeneration: 0,
            modelContext: undefined,
            claimedInvocations: new WeakSet(),
        },
    };
}
export function installTlhModelSelectionPersistenceOverride(bundledAgentSession) {
    if (modelSelectionPersistenceInstallAttempted) {
        return installedModelSelectionPersistencePatch !== undefined;
    }
    if (!canWriteTlhDefaults()) {
        return false;
    }
    modelSelectionPersistenceInstallAttempted = true;
    const constructors = getAgentSessionConstructors(bundledAgentSession);
    if (!constructors) {
        return false;
    }
    const targets = constructors.map((constructor) => getPatchedPrototype(constructor));
    const rawPatches = targets.map((prototype) => prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH]);
    if (rawPatches.some((value) => value !== undefined && !isModelSelectionPersistencePatch(value))) {
        console.warn("[TLH] installTlhModelSelectionPersistenceOverride: an AgentSession prototype has an unknown owner; " +
            "refusing to overwrite it.");
        return false;
    }
    const existingPatches = [
        ...new Set(rawPatches.filter((value) => isModelSelectionPersistencePatch(value))),
    ];
    if (existingPatches.length > 1) {
        console.warn("[TLH] installTlhModelSelectionPersistenceOverride: AgentSession prototypes have different owners; " +
            "refusing a split installation.");
        return false;
    }
    const patch = existingPatches[0] ?? createModelSelectionPersistencePatch();
    for (const target of targets) {
        const existingPatch = getPatchFromPrototype(target);
        if (existingPatch === patch && !patch.entries.some((entry) => entry.prototype === target)) {
            console.warn("[TLH] installTlhModelSelectionPersistenceOverride: an existing owner is missing its prototype entry; " +
                "refusing to guess the original setter.");
            return false;
        }
        if (!existingPatch && typeof target.setModel !== "function") {
            console.warn("[TLH] installTlhModelSelectionPersistenceOverride: AgentSession.setModel is unavailable; " +
                "skipping wrapper.");
            return false;
        }
    }
    const installedEntries = [];
    try {
        for (const target of targets) {
            if (getPatchFromPrototype(target)) {
                continue;
            }
            const original = target.setModel;
            const wrapper = createSetModelWrapper(patch, original);
            const entry = {
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
    }
    catch {
        for (const entry of installedEntries.reverse()) {
            try {
                if (entry.prototype.setModel === entry.wrapper) {
                    entry.prototype.setModel = entry.original;
                }
            }
            catch {
            }
            try {
                if (entry.prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH] === patch) {
                    delete entry.prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
                }
            }
            catch {
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
export function beginTlhModelSelectionPersistenceSession(onSameModelPersistence) {
    const patch = getInstalledPatch();
    if (!patch) {
        return undefined;
    }
    const session = Object.freeze({});
    const generation = patch.state.nextGeneration + 1;
    patch.state.nextGeneration = generation;
    patch.state.modelContext = {
        session,
        generation,
        onSameModelPersistence,
    };
    return session;
}
export function updateTlhModelSelectionPersistenceContext(session, onSameModelPersistence) {
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
export function readTlhModelSelectionPersistence(session) {
    const patch = getInstalledPatch();
    return patch ? currentModelSelectionPersistence(patch, session) : undefined;
}
export function endTlhModelSelectionPersistenceSession(session) {
    const patch = getInstalledPatch();
    if (!patch || patch.state.modelContext?.session !== session) {
        return;
    }
    patch.state.modelContext = undefined;
}
export function claimTlhModelSelectionDefaults(session, model, previousModel) {
    const patch = getInstalledPatch();
    if (!patch) {
        return undefined;
    }
    const invocation = readTlhModelSelectionPersistence(session);
    if (!invocation ||
        !invocation.persist ||
        !modelMatches(invocation.model, model) ||
        !modelMatches(invocation.previousModel, previousModel) ||
        patch.state.claimedInvocations.has(invocation)) {
        return undefined;
    }
    patch.state.claimedInvocations.add(invocation);
    return { persisted: true };
}
export function isTlhPersistedModelSelection(claim) {
    return claim?.persisted === true;
}
