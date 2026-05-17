export const DEFAULT_PRIMARY_AGENT = "architect";
export const DISABLED_PRIMARY_AGENT = "disabled";
export const PRIMARY_AGENT_SESSION_STATE_ENTRY = "tlh-primary-agent-state";
export const SELECTABLE_PRIMARY_AGENTS = Object.freeze(["architect", "product"]);
export const PRIMARY_AGENT_CYCLE = Object.freeze(["architect", "product", DISABLED_PRIMARY_AGENT]);

const PRIMARY_AGENT_SELECTIONS = new Set(PRIMARY_AGENT_CYCLE);

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeSelection(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function invalidSelectionLabel(value) {
	if (typeof value === "string") {
		return value.trim() || String(value);
	}
	return String(value);
}

export function isPrimaryAgentSelection(value) {
	return typeof value === "string" && PRIMARY_AGENT_SELECTIONS.has(value);
}

export function isEnabledPrimaryAgentSelection(selection) {
	return selection !== DISABLED_PRIMARY_AGENT;
}

export function resolvePrimaryAgentConfig(config) {
	if (!isRecord(config)) {
		return { selection: DEFAULT_PRIMARY_AGENT };
	}

	if (config.enabled === false) {
		return { selection: DISABLED_PRIMARY_AGENT };
	}

	if (hasOwn(config, "selected")) {
		const selected = normalizeSelection(config.selected);
		if (selected && PRIMARY_AGENT_SELECTIONS.has(selected)) {
			return { selection: selected };
		}
		return { selection: DEFAULT_PRIMARY_AGENT, invalidSelected: invalidSelectionLabel(config.selected) };
	}

	return { selection: DEFAULT_PRIMARY_AGENT };
}

export function resolvePrimaryAgentSessionState(data) {
	if (typeof data === "boolean") {
		return { selection: data ? DEFAULT_PRIMARY_AGENT : DISABLED_PRIMARY_AGENT };
	}
	if (!isRecord(data)) {
		return {};
	}

	if (data.enabled === false) {
		return { selection: DISABLED_PRIMARY_AGENT };
	}

	if (hasOwn(data, "selected")) {
		const selected = normalizeSelection(data.selected);
		if (selected && PRIMARY_AGENT_SELECTIONS.has(selected)) {
			return { selection: selected };
		}
		return { selection: DEFAULT_PRIMARY_AGENT, invalidSelected: invalidSelectionLabel(data.selected) };
	}

	if (data.enabled === true) {
		return { selection: DEFAULT_PRIMARY_AGENT };
	}

	return {};
}

export function primaryAgentSelectionFromBranch(entries) {
	if (!Array.isArray(entries)) {
		return {};
	}

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PRIMARY_AGENT_SESSION_STATE_ENTRY) {
			continue;
		}
		return resolvePrimaryAgentSessionState(entry.data);
	}
	return {};
}

export function nextPrimaryAgentSelection(currentSelection) {
	const index = PRIMARY_AGENT_CYCLE.indexOf(currentSelection);
	return PRIMARY_AGENT_CYCLE[(index + 1) % PRIMARY_AGENT_CYCLE.length];
}

export function primaryAgentDefaultLabel(config) {
	if (!isRecord(config) || (!hasOwn(config, "enabled") && !hasOwn(config, "selected"))) {
		return `unset (TLH default: ${DEFAULT_PRIMARY_AGENT})`;
	}

	const resolution = resolvePrimaryAgentConfig(config);
	if (resolution.invalidSelected) {
		return `invalid "${resolution.invalidSelected}" (TLH fallback: ${DEFAULT_PRIMARY_AGENT})`;
	}
	return resolution.selection;
}
