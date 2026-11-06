import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { PRIMARY_AGENT_CYCLE } from "../the-last-harness-primary-agent.mjs";
import { isThinkingLevel } from "./thinking.js";
import type {
  AgentPrompt,
  ThinkingLevel,
  TlhPrimaryAgentConfig,
  TlhPrimaryAgentSelection,
  TlhPrimaryAgentWriteResult,
  TlhSettings,
  TlhSubagentOverride,
} from "./types.js";

export function getTlhGlobalSettings(cwd: string): TlhSettings {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
    return isRecord(settings) ? (settings as TlhSettings) : {};
  } catch {
    return {};
  }
}

export function getTlhPrimaryAgentConfig(cwd: string): TlhPrimaryAgentConfig | undefined {
  return getTlhGlobalSettings(cwd).tlh?.primaryAgent;
}

export function getTlhDurableThinkingLevel(cwd: string): ThinkingLevel | undefined {
  const level = getTlhGlobalSettings(cwd).defaultThinkingLevel;
  return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
}

/** Read a valid stored effort override for a primary; invalid values are ignored. */
export function getTlhPrimaryEffortOverride(
  primaryConfig: TlhPrimaryAgentConfig | undefined,
  primary: string,
): ThinkingLevel | undefined {
  const overrides: unknown = primaryConfig?.effortOverrides;
  if (!isRecord(overrides) || !Object.hasOwn(overrides, primary)) {
    return undefined;
  }
  const level = overrides[primary];
  return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
}

export function getTlhSubagentOverrides(cwd: string): ReadonlyMap<string, TlhSubagentOverride> {
  const overrides = getTlhGlobalSettings(cwd).subagents?.agentOverrides;
  if (!isRecord(overrides)) {
    return new Map();
  }
  return new Map(
    Object.entries(overrides)
      .filter(([, value]) => isRecord(value))
      .map(([agent, value]) => [agent, value as TlhSubagentOverride]),
  );
}

export function resolvePrimaryAutoApplySetting(
  primaryConfig: TlhPrimaryAgentConfig | undefined,
  primary: AgentPrompt,
  key: "applyModel" | "applyThinking",
): boolean {
  const configured = primaryConfig?.[key];
  if (typeof configured === "boolean") {
    return configured;
  }
  return primary[key] === true;
}

export function parseTlhSettingsContent(content: string | undefined): Record<string, unknown> {
  if (!content) {
    return {};
  }
  const parsed = JSON.parse(content.replace(/^\uFEFF/, "")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("settings.json must contain a JSON object");
  }
  return parsed;
}

function prepareTlhPrimaryAgentSettings(
  content: string | undefined,
  invalidTlhMessage: string,
  invalidPrimaryAgentMessage: string,
): { settings: Record<string, unknown>; primaryAgent: Record<string, unknown> } {
  const settings = parseTlhSettingsContent(content);
  const rawTlh = settings.tlh;
  let tlh: Record<string, unknown>;
  if (rawTlh === undefined) {
    tlh = {};
    settings.tlh = tlh;
  } else if (isRecord(rawTlh)) {
    tlh = rawTlh;
  } else {
    throw new Error(invalidTlhMessage);
  }

  const rawPrimaryAgent = tlh.primaryAgent;
  let primaryAgent: Record<string, unknown>;
  if (rawPrimaryAgent === undefined) {
    primaryAgent = {};
    tlh.primaryAgent = primaryAgent;
  } else if (isRecord(rawPrimaryAgent)) {
    primaryAgent = rawPrimaryAgent;
  } else {
    throw new Error(invalidPrimaryAgentMessage);
  }

  return { settings, primaryAgent };
}

export function writeTlhPrimaryAgentModelOverride(
  cwd: string,
  primary: TlhPrimaryAgentSelection,
  modelKey: string | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write model-override settings outside the isolated TLH profile.",
    (current) => {
      const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(
        current,
        "settings.tlh must be an object to update model-override settings.",
        "settings.tlh.primaryAgent must be an object to update model-override settings.",
      );

      const rawModelOverrides = primaryAgent.modelOverrides;
      let modelOverrides: Record<string, unknown>;
      if (rawModelOverrides === undefined) {
        modelOverrides = {};
        primaryAgent.modelOverrides = modelOverrides;
      } else if (isRecord(rawModelOverrides)) {
        modelOverrides = rawModelOverrides;
      } else {
        throw new Error("settings.tlh.primaryAgent.modelOverrides must be an object.");
      }

      const existingOverride = modelOverrides[primary];
      if (modelKey === undefined) {
        if (!Object.hasOwn(modelOverrides, primary)) {
          return { changed: false };
        }
        delete modelOverrides[primary];
      } else {
        if (existingOverride === modelKey) {
          return { changed: false };
        }
        modelOverrides[primary] = modelKey;
      }

      // Clean up empty modelOverrides object
      if (Object.keys(modelOverrides).length === 0) {
        delete primaryAgent.modelOverrides;
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

/** Set (or clear, when `level` is undefined) a primary's persisted effort override. */
export function writeTlhPrimaryAgentEffortOverride(
  cwd: string,
  primary: TlhPrimaryAgentSelection,
  level: ThinkingLevel | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write effort-override settings outside the isolated TLH profile.",
    (current) => {
      const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(
        current,
        "settings.tlh must be an object to update effort-override settings.",
        "settings.tlh.primaryAgent must be an object to update effort-override settings.",
      );

      const rawOverrides = primaryAgent.effortOverrides;
      let effortOverrides: Record<string, unknown>;
      if (rawOverrides === undefined) {
        effortOverrides = {};
        primaryAgent.effortOverrides = effortOverrides;
      } else if (isRecord(rawOverrides)) {
        effortOverrides = rawOverrides;
      } else {
        throw new Error("settings.tlh.primaryAgent.effortOverrides must be an object.");
      }

      if (level === undefined) {
        if (!Object.hasOwn(effortOverrides, primary)) {
          return { changed: false };
        }
        delete effortOverrides[primary];
      } else {
        if (effortOverrides[primary] === level) {
          return { changed: false };
        }
        effortOverrides[primary] = level;
      }

      if (Object.keys(effortOverrides).length === 0) {
        delete primaryAgent.effortOverrides;
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

export function writeTlhPrimaryAgentDefault(
  cwd: string,
  selection: TlhPrimaryAgentSelection | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write primary-agent settings outside the isolated TLH profile.",
    (current) => {
      const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(
        current,
        "settings.tlh must be an object to update primary-agent settings.",
        "settings.tlh.primaryAgent must be an object to update primary-agent defaults.",
      );

      let changed = false;
      const setField = (key: "enabled" | "selected", value: boolean | string | undefined) => {
        if (value === undefined) {
          if (Object.hasOwn(primaryAgent, key)) {
            delete primaryAgent[key];
            changed = true;
          }
          return;
        }
        if (primaryAgent[key] !== value) {
          primaryAgent[key] = value;
          changed = true;
        }
      };

      if (selection === undefined) {
        setField("enabled", undefined);
        setField("selected", undefined);
      } else {
        setField("enabled", true);
        setField("selected", selection);
      }

      if (!changed) {
        return { changed: false };
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

/**
 * Clear both the model and effort override for a primary in one guarded, backed-up
 * settings write. Empty `modelOverrides`/`effortOverrides` containers are dropped.
 * Non-object containers are left untouched (they carry no override TLH reads).
 */
export function writeTlhPrimaryAgentOverridesCleared(
  cwd: string,
  primary: TlhPrimaryAgentSelection,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write primary-override settings outside the isolated TLH profile.",
    (current) => {
      const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(
        current,
        "settings.tlh must be an object to update primary-override settings.",
        "settings.tlh.primaryAgent must be an object to update primary-override settings.",
      );

      let changed = false;
      for (const key of ["modelOverrides", "effortOverrides"] as const) {
        const container = primaryAgent[key];
        if (!isRecord(container) || !Object.hasOwn(container, primary)) {
          continue;
        }
        delete container[primary];
        changed = true;
        if (Object.keys(container).length === 0) {
          delete primaryAgent[key];
        }
      }
      if (!changed) {
        return { changed: false };
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

export function isTlhPrimaryAgentSelection(value: string): value is TlhPrimaryAgentSelection {
  return (PRIMARY_AGENT_CYCLE as readonly string[]).includes(value);
}

/**
 * Clear the stored model override for a named primary agent.
 *
 * Returns `undefined` when `agentName` is not a recognised primary-agent selection,
 * which is deliberately a refusal rather than a best-effort delete.
 */
export function clearPrimaryAgentModelOverrideByName(
  cwd: string,
  agentName: string,
): TlhPrimaryAgentWriteResult | undefined {
  if (!isTlhPrimaryAgentSelection(agentName)) {
    return undefined;
  }
  return writeTlhPrimaryAgentModelOverride(cwd, agentName, undefined);
}

/**
 * Clear the stored model and effort overrides for a named primary agent in one write.
 * Returns `undefined` for an unrecognised primary name (no write).
 */
export function clearPrimaryAgentOverridesByName(
  cwd: string,
  agentName: string,
): TlhPrimaryAgentWriteResult | undefined {
  if (!isTlhPrimaryAgentSelection(agentName)) {
    return undefined;
  }
  return writeTlhPrimaryAgentOverridesCleared(cwd, agentName);
}
