import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { DISABLED_PRIMARY_AGENT, PRIMARY_AGENT_CYCLE } from "../the-last-harness-primary-agent.mjs";
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

export function defaultProjectTrustForCwd(cwd: string): "ask" | "always" | "never" {
  try {
    const value = SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted: false,
    }).getDefaultProjectTrust();
    return value === "always" || value === "never" ? value : "ask";
  } catch {
    return "ask";
  }
}

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
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("settings.json must contain a JSON object");
  }
  return parsed;
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
      const settings = parseTlhSettingsContent(current);
      const rawTlh = settings.tlh;
      let tlh: Record<string, unknown>;
      if (rawTlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
      } else if (isRecord(rawTlh)) {
        tlh = rawTlh;
      } else {
        throw new Error("settings.tlh must be an object to update model-override settings.");
      }

      const rawPrimaryAgent = tlh.primaryAgent;
      let primaryAgent: Record<string, unknown>;
      if (rawPrimaryAgent === undefined) {
        primaryAgent = {};
        tlh.primaryAgent = primaryAgent;
      } else if (isRecord(rawPrimaryAgent)) {
        primaryAgent = rawPrimaryAgent;
      } else {
        throw new Error(
          "settings.tlh.primaryAgent must be an object to update model-override settings.",
        );
      }

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

export function writeTlhPrimaryAgentDefault(
  cwd: string,
  selection: TlhPrimaryAgentSelection | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write primary-agent settings outside the isolated TLH profile.",
    (current) => {
      const settings = parseTlhSettingsContent(current);
      const rawTlh = settings.tlh;
      let tlh: Record<string, unknown>;
      if (rawTlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
      } else if (isRecord(rawTlh)) {
        tlh = rawTlh;
      } else {
        throw new Error("settings.tlh must be an object to update primary-agent settings.");
      }

      const rawPrimaryAgent = tlh.primaryAgent;
      let primaryAgent: Record<string, unknown>;
      if (rawPrimaryAgent === undefined) {
        primaryAgent = {};
        tlh.primaryAgent = primaryAgent;
      } else if (isRecord(rawPrimaryAgent)) {
        primaryAgent = rawPrimaryAgent;
      } else {
        throw new Error(
          "settings.tlh.primaryAgent must be an object to update primary-agent defaults.",
        );
      }

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
      } else if (selection === DISABLED_PRIMARY_AGENT) {
        setField("enabled", false);
        setField("selected", DISABLED_PRIMARY_AGENT);
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
