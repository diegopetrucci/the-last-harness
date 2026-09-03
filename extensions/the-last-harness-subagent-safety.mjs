/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI */

/**
 * @typedef {object} TlhStartupModeOptions
 * @property {Record<string, string | undefined>=} env
 * @property {(() => string)=} buildChildSubagentSystemPrompt
 * @property {(() => void)=} registerChild
 * @property {(() => void)=} registerParent
 */

export const ALLOWED_SUBAGENTS = Object.freeze([
  "developer",
  "test-runner",
  "code-reviewer",
  "repo-scout",
  "diff-summarizer",
  "librarian",
  "web-scout",
  "oracle",
  "contrarian",
]);
export const SAFE_SUBAGENT_ACTIONS = Object.freeze([
  "list",
  "get",
  "status",
  "interrupt",
  "doctor",
  "resume",
  "steer",
]);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

// Provider-aware model policy attaches generated fallback candidates to an
// in-process dispatch object without exposing them as caller-facing tool
// parameters. Symbols are ignored by JSON/schema traversal while surviving the
// shallow target copies used by the dispatch path.
export const PROVIDER_AWARE_FALLBACK_MODELS = Symbol.for("tlh.providerAwareFallbackModels");

const DEFAULT_ALLOWED_SUBAGENTS = ALLOWED_SUBAGENTS;
const ALLOWED_SUBAGENTS_BY_ID = new Map(
  ALLOWED_SUBAGENTS.map((agent) => [agent.toLowerCase(), agent]),
);

const EMBEDDED_SUBAGENT_TARGET_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;

export function isEmbeddedSubagentTarget(value) {
  return typeof value === "string" && EMBEDDED_SUBAGENT_TARGET_PATTERN.test(value.trim());
}

const SAFE_SUBAGENT_ACTION_SET = new Set(SAFE_SUBAGENT_ACTIONS);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read provider-aware fallback candidates attached to an in-process dispatch
 * target. Symbols are deliberately outside ordinary tool input so this reader
 * can consume model-default mutations without exposing a caller-facing field.
 */
export function getProviderAwareFallbackModels(target) {
  if (!isRecord(target)) return undefined;
  const candidates = target[PROVIDER_AWARE_FALLBACK_MODELS];
  if (!Array.isArray(candidates)) return undefined;
  const normalized = candidates.filter(
    (candidate) => typeof candidate === "string" && candidate.trim() !== "",
  );
  return normalized.length > 0 ? [...normalized] : undefined;
}

function stringField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeExperimentalFeatureId(featureId) {
  return stringField(featureId)?.toLowerCase();
}

export function normalizeEnabledExperimentalFeatures(enabledFeatures) {
  if (
    !Array.isArray(enabledFeatures) ||
    enabledFeatures.some((feature) => typeof feature !== "string")
  ) {
    return [];
  }

  return [
    ...new Set(
      enabledFeatures.map((feature) => normalizeExperimentalFeatureId(feature)).filter(Boolean),
    ),
  ].sort();
}

export function readEnabledExperimentalFeatures(config) {
  if (!isRecord(config)) {
    return [];
  }

  return normalizeEnabledExperimentalFeatures(config.enabledFeatures);
}

export function allowedSubagentsForExperimentalConfig(_config) {
  return DEFAULT_ALLOWED_SUBAGENTS;
}

function normalizeAllowedSubagent(agent) {
  const normalizedAgent = stringField(agent)?.toLowerCase();
  return normalizedAgent ? ALLOWED_SUBAGENTS_BY_ID.get(normalizedAgent) : undefined;
}

function normalizeAllowedSubagents(allowedSubagents) {
  if (!Array.isArray(allowedSubagents)) {
    return DEFAULT_ALLOWED_SUBAGENTS;
  }

  const normalized = [
    ...new Set(allowedSubagents.map((agent) => normalizeAllowedSubagent(agent)).filter(Boolean)),
  ];
  return normalized.length > 0 ? normalized : DEFAULT_ALLOWED_SUBAGENTS;
}

export function collectSubagentTargets(input) {
  if (!isRecord(input)) {
    return [];
  }

  const targets = [];
  const topLevelAgent = stringField(input.agent);
  if (topLevelAgent) {
    targets.push(topLevelAgent);
  }

  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (!isRecord(task)) continue;
      const agent = stringField(task.agent);
      if (agent) targets.push(agent);
    }
  }

  return [...new Set(targets)];
}

function forceUserAgentScope(input, mode, { allowBoth = false } = {}) {
  const rawScope = input.agentScope;
  if (rawScope !== undefined) {
    if (typeof rawScope !== "string") {
      return `TLH primary-agent subagent ${mode} calls must use agentScope: "user" or omit agentScope.`;
    }
    const agentScope = rawScope.trim();
    const scopeIsAllowed =
      !agentScope || agentScope === "user" || (allowBoth && agentScope === "both");
    if (!scopeIsAllowed) {
      return `TLH primary-agent subagent ${mode} calls may not use agentScope: "${agentScope}". TLH minor agents must run from the isolated user scope.`;
    }
  }

  input.agentScope = "user";
  return undefined;
}

/**
 * Project custom agents are a separate, trusted execution scope. A request
 * containing one is run as a single project-scoped dispatch so the executor
 * can combine canonical packaged roles with the exact trusted snapshot. An
 * explicitly requested user/both scope is rejected rather than silently
 * downgrading the project target to an untrusted profile lookup.
 */
function forceExecutionAgentScope(input) {
  if (!isRecord(input) || !collectSubagentTargets(input).some(isEmbeddedSubagentTarget)) {
    return forceUserAgentScope(input, "execution");
  }

  const rawScope = input.agentScope;
  if (rawScope !== undefined) {
    if (typeof rawScope !== "string") {
      return 'TLH primary-agent subagent execution containing an embedded target must use agentScope: "project" or omit agentScope.';
    }
    const agentScope = rawScope.trim();
    if (agentScope && agentScope !== "project") {
      return `TLH primary-agent embedded execution may not use agentScope: "${agentScope}"; project scope is required for embedded targets.`;
    }
  }

  input.agentScope = "project";
  return undefined;
}

function validateExecutionBearingTargets(
  input,
  allowedSubagents,
  allowedSubagentSet,
  allowEmbeddedTargets,
) {
  const embeddedSuffix = allowEmbeddedTargets ? ", or embedded.<slug>" : "";
  const targets = collectSubagentTargets(input);
  if (targets.length === 0) {
    return `TLH primary-agent subagent execution must target one of: ${allowedSubagents.join(", ")}${embeddedSuffix}.`;
  }

  const disallowed = targets.filter(
    (agent) =>
      !allowedSubagentSet.has(agent) && !(allowEmbeddedTargets && isEmbeddedSubagentTarget(agent)),
  );
  if (disallowed.length > 0) {
    return `TLH primary agents may delegate only to: ${allowedSubagents.join(", ")}${embeddedSuffix}. Disallowed target(s): ${disallowed.join(", ")}.`;
  }

  return undefined;
}

const STEER_EXECUTION_FIELDS = ["agent", "tasks", "chain", "agentScope"];

function validateSteerAction(input) {
  const id = stringField(input.id);
  if (!id) {
    return "TLH primary agents may not call steer without a non-empty string id.";
  }
  const message = stringField(input.message);
  if (!message) {
    return "TLH primary agents may not call steer without a non-empty string message. Steer intent must be explicit; a task-as-message fallback is not allowed.";
  }
  for (const field of STEER_EXECUTION_FIELDS) {
    if (input[field] !== undefined) {
      return `TLH primary agents may not include '${field}' on a steer call. Steer is a control-channel message, not an execution request.`;
    }
  }
  if (input.index !== undefined) {
    if (typeof input.index !== "number" || !Number.isInteger(input.index) || input.index < 0) {
      return "TLH primary agents may not call steer with a non-integer or negative index.";
    }
  }
  return undefined;
}

export function validateSubagentToolInput(input, options = {}) {
  const allowedSubagents = normalizeAllowedSubagents(options.allowedSubagents);
  const allowedSubagentSet = new Set(allowedSubagents);

  if (!isRecord(input)) {
    return "TLH primary-agent subagent calls must use an object input.";
  }

  const action = stringField(input.action);
  if (action) {
    if (!SAFE_SUBAGENT_ACTION_SET.has(action)) {
      return `TLH primary agents may not use subagent management action '${action}'. Allowed actions: ${SAFE_SUBAGENT_ACTIONS.join(", ")}.`;
    }
    if (action === "list" || action === "get") {
      return forceUserAgentScope(input, action, { allowBoth: true });
    }
    if (action === "resume") {
      const scopeReason = forceUserAgentScope(input, action, { allowBoth: true });
      if (scopeReason) {
        return scopeReason;
      }
      return undefined;
    }
    if (action === "steer") {
      return validateSteerAction(input);
    }
    return undefined;
  }

  const scopeReason = forceExecutionAgentScope(input);
  if (scopeReason) {
    return scopeReason;
  }

  return validateExecutionBearingTargets(
    input,
    allowedSubagents,
    allowedSubagentSet,
    Boolean(options.allowEmbeddedTargets),
  );
}

/**
 * @param {ExtensionAPI} pi
 * @param {() => string} buildChildSubagentSystemPrompt
 */
export function registerChildSubagentPrompt(pi, buildChildSubagentSystemPrompt) {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: [event.systemPrompt, buildChildSubagentSystemPrompt()]
      .filter(Boolean)
      .join("\n\n"),
  }));
}

/**
 * @param {ExtensionAPI} pi
 * @param {TlhStartupModeOptions} [options={}]
 * @returns {"child" | "parent"}
 */
export function registerTlhStartupMode(pi, options = {}) {
  const {
    env = process.env,
    buildChildSubagentSystemPrompt,
    registerChild,
    registerParent,
  } = options;
  if (env?.[SUBAGENT_CHILD_ENV] === "1") {
    if (typeof registerChild === "function") {
      registerChild();
    } else if (typeof buildChildSubagentSystemPrompt === "function") {
      registerChildSubagentPrompt(pi, buildChildSubagentSystemPrompt);
    }
    return "child";
  }

  registerParent?.();
  return "parent";
}
