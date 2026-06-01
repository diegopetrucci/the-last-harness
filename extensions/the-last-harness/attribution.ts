import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhAttributionConfig, TlhAttributionWriteResult, TlhCommitAttributionState, TlhSettings } from "./types.js";

export const TLH_DEFAULT_COMMIT_ATTRIBUTION = `🤖 Generated with [The Last Harness](https://github.com/diegopetrucci/the-last-harness)\n\nCo-authored-by: The Last Harness <noreply@the-last-harness.invalid>`;

const TOGGLE_TLH_GIT_ATTRIBUTION_COMMAND_HELP = "Usage: /toggle-tlh-git-attribution";
const TLH_GIT_COMMIT_ATTRIBUTION_PROMPT_HEADING = "## TLH Git Commit Attribution";
const TLH_GIT_COMMIT_BLOCK_REASON = "Blocked TLH bash git commit because the commit message is missing the required TLH attribution footer.";
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--config-env", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);

type HereDocSpec = {
	delimiter: string;
	allowIndent: boolean;
};

function normalizeTlhAttributionConfig(config: unknown): TlhAttributionConfig | undefined {
	if (!isRecord(config)) {
		return undefined;
	}
	const commit = config.commit;
	if (commit === undefined) {
		return {};
	}
	return typeof commit === "boolean" ? { commit } : undefined;
}

export function getTlhAttributionConfig(cwd: string): TlhAttributionConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return normalizeTlhAttributionConfig(settings.tlh?.attribution);
	} catch {
		return undefined;
	}
}

export function resolveTlhCommitAttribution(config: TlhAttributionConfig | undefined): TlhCommitAttributionState {
	if (config?.commit === false) {
		return { enabled: false };
	}
	return {
		enabled: true,
		footer: TLH_DEFAULT_COMMIT_ATTRIBUTION,
	};
}

function commandIncludesTlhCommitAttributionFooter(command: string, footer: string): boolean {
	let searchOffset = 0;
	for (const line of footer.split("\n").filter(Boolean)) {
		const index = command.indexOf(line, searchOffset);
		if (index === -1) {
			return false;
		}
		searchOffset = index + line.length;
	}
	return true;
}

function readHereDocSpec(command: string, startIndex: number): { spec: HereDocSpec; endIndex: number } | undefined {
	if (command[startIndex] !== "<" || command[startIndex + 1] !== "<" || command[startIndex + 2] === "<") {
		return undefined;
	}

	let index = startIndex + 2;
	let allowIndent = false;
	if (command[index] === "-") {
		allowIndent = true;
		index += 1;
	}
	while (command[index] === " " || command[index] === "\t") {
		index += 1;
	}

	const quote = command[index];
	if (quote === "'" || quote === '"') {
		const endIndex = command.indexOf(quote, index + 1);
		if (endIndex === -1) {
			return undefined;
		}
		const delimiter = command.slice(index + 1, endIndex);
		return delimiter ? { spec: { delimiter, allowIndent }, endIndex: endIndex + 1 } : undefined;
	}

	const delimiterStart = index;
	while (index < command.length && !/[\s;&|<>]/.test(command[index])) {
		index += 1;
	}
	const delimiter = command.slice(delimiterStart, index);
	return delimiter ? { spec: { delimiter, allowIndent }, endIndex: index } : undefined;
}

function readHereDocBodies(command: string, startIndex: number, specs: HereDocSpec[]): { bodies: string[]; nextIndex: number } {
	const bodies: string[] = [];
	let index = startIndex;

	for (const spec of specs) {
		const bodyStart = index;
		let foundDelimiter = false;

		while (index <= command.length) {
			const lineEnd = command.indexOf("\n", index);
			const nextIndex = lineEnd === -1 ? command.length : lineEnd + 1;
			const line = lineEnd === -1 ? command.slice(index) : command.slice(index, lineEnd);
			const comparableLine = spec.allowIndent ? line.replace(/^\t+/, "") : line;
			if (comparableLine === spec.delimiter) {
				bodies.push(command.slice(bodyStart, index));
				index = nextIndex;
				foundDelimiter = true;
				break;
			}
			if (lineEnd === -1) {
				index = command.length;
				break;
			}
			index = nextIndex;
		}

		if (!foundDelimiter) {
			bodies.push(command.slice(bodyStart));
			return { bodies, nextIndex: command.length };
		}
	}

	return { bodies, nextIndex: index };
}

function readShellCommandSegment(command: string, startIndex: number): { segment: string; nextIndex: number } {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	const hereDocs: HereDocSpec[] = [];

	for (let index = startIndex; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") {
				quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				quote = undefined;
			}
			continue;
		}
		if (quote === "`") {
			if (character === "`") {
				quote = undefined;
			}
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "<" && command[index + 1] === "<") {
			const spec = readHereDocSpec(command, index);
			if (spec) {
				hereDocs.push(spec.spec);
				index = spec.endIndex - 1;
				continue;
			}
		}
		if (character !== "\n" && character !== ";" && character !== "&" && character !== "|") {
			continue;
		}

		if (character === "\n" && hereDocs.length > 0) {
			const { nextIndex } = readHereDocBodies(command, index + 1, hereDocs);
			return { segment: command.slice(startIndex, nextIndex), nextIndex };
		}

		const next = command[index + 1];
		const separatorLength =
			(character === "&" && next === "&") || (character === "|" && (next === "|" || next === "&")) ? 2 : 1;
		return {
			segment: command.slice(startIndex, index),
			nextIndex: index + separatorLength,
		};
	}

	return { segment: command.slice(startIndex), nextIndex: command.length };
}

function splitShellCommandSegments(command: string): string[] {
	if (!command) {
		return [""];
	}

	const segments: string[] = [];
	let startIndex = 0;
	while (startIndex < command.length) {
		const { segment, nextIndex } = readShellCommandSegment(command, startIndex);
		segments.push(segment);
		if (nextIndex <= startIndex) {
			break;
		}
		startIndex = nextIndex;
	}
	return segments;
}

function tokenizeShellWords(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	for (const character of command) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") {
				quote = undefined;
				continue;
			}
			current += character;
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				quote = undefined;
				continue;
			}
			current += character;
			continue;
		}
		if (quote === "`") {
			if (character === "`") {
				quote = undefined;
				continue;
			}
			current += character;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (current) {
		tokens.push(current);
	}
	return tokens;
}

function getGitCommitArguments(segment: string): string[] | undefined {
	const tokens = tokenizeShellWords(segment);
	if (tokens[0]?.toLowerCase() !== "git") {
		return undefined;
	}

	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.toLowerCase() === "commit") {
			return tokens.slice(index + 1);
		}
		if (!token.startsWith("-")) {
			return undefined;
		}
		if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-C") || token.startsWith("-c")) {
			continue;
		}
		if (["--config-env", "--git-dir", "--namespace", "--super-prefix", "--work-tree"].some((option) => token.startsWith(`${option}=`))) {
			continue;
		}
	}
	return undefined;
}

function getInlineGitCommitMessageParts(commitArguments: string[]): string[] {
	const messages: string[] = [];

	for (let index = 0; index < commitArguments.length; index += 1) {
		const token = commitArguments[index];
		const lowerToken = token.toLowerCase();
		if (lowerToken === "-m" || lowerToken === "--message") {
			const value = commitArguments[index + 1];
			if (value !== undefined) {
				messages.push(value);
				index += 1;
			}
			continue;
		}
		if (lowerToken.startsWith("--message=")) {
			messages.push(token.slice("--message=".length));
			continue;
		}
		if (token.startsWith("-") && !token.startsWith("--")) {
			const shortFlags = token.slice(1);
			const messageFlagIndex = shortFlags.indexOf("m");
			if (messageFlagIndex === -1) {
				continue;
			}
			const attachedValue = shortFlags.slice(messageFlagIndex + 1);
			if (attachedValue) {
				messages.push(attachedValue);
				continue;
			}
			const value = commitArguments[index + 1];
			if (value !== undefined) {
				messages.push(value);
				index += 1;
			}
		}
	}

	return messages;
}

function hasInlineGitCommitMessageArgument(commitArguments: string[]): boolean {
	return getInlineGitCommitMessageParts(commitArguments).length > 0;
}

function getInlineGitCommitFileArgument(commitArguments: string[]): "stdin" | "process-substitution" | undefined {
	for (let index = 0; index < commitArguments.length; index += 1) {
		const token = commitArguments[index];
		const lowerToken = token.toLowerCase();
		if (lowerToken === "-f" || lowerToken === "--file") {
			const value = commitArguments[index + 1];
			if (value === "-") {
				return "stdin";
			}
			if (value?.startsWith("<(")) {
				return "process-substitution";
			}
			continue;
		}
		if (lowerToken.startsWith("-f")) {
			const value = token.slice(2);
			if (value === "-") {
				return "stdin";
			}
			if (value.startsWith("<(")) {
				return "process-substitution";
			}
			continue;
		}
		if (lowerToken.startsWith("--file=")) {
			const value = token.slice("--file=".length);
			if (value === "-") {
				return "stdin";
			}
			if (value.startsWith("<(")) {
				return "process-substitution";
			}
		}
	}
	return undefined;
}

function extractHereDocBodies(segment: string): string[] {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	const hereDocs: HereDocSpec[] = [];

	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") {
				quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				quote = undefined;
			}
			continue;
		}
		if (quote === "`") {
			if (character === "`") {
				quote = undefined;
			}
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "<" && segment[index + 1] === "<") {
			const spec = readHereDocSpec(segment, index);
			if (spec) {
				hereDocs.push(spec.spec);
				index = spec.endIndex - 1;
				continue;
			}
		}
		if (character === "\n") {
			return hereDocs.length > 0 ? readHereDocBodies(segment, index + 1, hereDocs).bodies : [];
		}
	}

	return [];
}

function normalizeTrailingLineEnding(value: string): string {
	return value.replace(/\r?\n$/, "");
}

function hasInlineGitCommitFileArgument(commitArguments: string[]): boolean {
	return getInlineGitCommitFileArgument(commitArguments) !== undefined;
}

function isObviousInlineGitCommitCommand(segment: string): boolean {
	const commitArguments = getGitCommitArguments(segment);
	if (!commitArguments) {
		return false;
	}
	return hasInlineGitCommitMessageArgument(commitArguments) || hasInlineGitCommitFileArgument(commitArguments);
}

function isAttributedObviousInlineGitCommitSegment(segment: string, footer: string): boolean {
	const commitArguments = getGitCommitArguments(segment);
	if (!commitArguments) {
		return false;
	}
	const inlineMessages = getInlineGitCommitMessageParts(commitArguments);
	if (inlineMessages.length > 0) {
		return inlineMessages.join("\n\n").endsWith(footer);
	}
	const fileArgument = getInlineGitCommitFileArgument(commitArguments);
	if (fileArgument === "stdin") {
		const hereDocBody = extractHereDocBodies(segment).at(-1);
		return hereDocBody !== undefined && normalizeTrailingLineEnding(hereDocBody).endsWith(footer);
	}
	if (fileArgument === "process-substitution") {
		return commandIncludesTlhCommitAttributionFooter(segment, footer);
	}
	return false;
}

export function buildTlhCommitAttributionPrompt(state: TlhCommitAttributionState): string | undefined {
	if (!state.enabled || !state.footer) {
		return undefined;
	}
	return [
		TLH_GIT_COMMIT_ATTRIBUTION_PROMPT_HEADING,
		"If you create a git commit with the bash tool, end the commit message with this exact TLH footer:",
		`\`\`\`text\n${state.footer}\n\`\`\``,
	].join("\n\n");
}

export function getTlhGitCommitAttributionBlockReason(command: string, state: TlhCommitAttributionState): string | undefined {
	if (!state.enabled || !state.footer) {
		return undefined;
	}
	for (const segment of splitShellCommandSegments(command)) {
		const trimmedSegment = segment.trim();
		if (!isObviousInlineGitCommitCommand(trimmedSegment)) {
			continue;
		}
		if (isAttributedObviousInlineGitCommitSegment(trimmedSegment, state.footer)) {
			continue;
		}
		return [TLH_GIT_COMMIT_BLOCK_REASON, "Retry with this exact footer at the end of the commit message:", state.footer].join(
			"\n\n",
		);
	}
	return undefined;
}

function validateTlhAttributionSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isRecord(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isRecord(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const attribution = isRecord(tlh) ? tlh.attribution : undefined;
	if (attribution !== undefined && !isRecord(attribution)) {
		throw new Error("settings field 'tlh.attribution' must be an object if present");
	}
	const commit = isRecord(attribution) ? attribution.commit : undefined;
	if (commit !== undefined && typeof commit !== "boolean") {
		throw new Error("settings field 'tlh.attribution.commit' must be a boolean if present");
	}
}

function parseTlhSettingsContent(content: string | undefined): TlhSettings {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content) as unknown;
	validateTlhAttributionSettings(parsed);
	return parsed;
}

function ensureMutableAttributionSettings(settings: TlhSettings): asserts settings is TlhSettings & {
	tlh: { attribution: TlhAttributionConfig };
} {
	validateTlhAttributionSettings(settings);
	settings.tlh ??= {};
	settings.tlh.attribution ??= {};
}

function toggleTlhCommitAttribution(cwd: string): TlhAttributionWriteResult {
	return withLockedTlhSettingsWrite(cwd, "Refusing to write attribution settings outside the isolated TLH profile.", (current) => {
		const settings = parseTlhSettingsContent(current);
		const currentState = resolveTlhCommitAttribution(settings.tlh?.attribution);
		const nextEnabled = !currentState.enabled;

		ensureMutableAttributionSettings(settings);
		settings.tlh.attribution = { commit: nextEnabled };
		return {
			changed: true,
			state: resolveTlhCommitAttribution(settings.tlh.attribution),
			nextContent: `${JSON.stringify(settings, null, 2)}\n`,
		};
	});
}

function formatCommitAttributionStatus(state: TlhCommitAttributionState): string {
	return state.enabled ? "TLH commit attribution is enabled." : "TLH commit attribution is disabled.";
}

export function registerToggleTlhGitAttributionCommand(pi: ExtensionAPI): void {
	pi.registerCommand("toggle-tlh-git-attribution", {
		description: "Toggle TLH git commit attribution",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(TOGGLE_TLH_GIT_ATTRIBUTION_COMMAND_HELP, "error");
				return;
			}

			try {
				const result = toggleTlhCommitAttribution(ctx.cwd);
				const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
				ctx.ui.notify(
					`Updated TLH commit attribution at ${formatHomePath(result.settingsPath)}. ${formatCommitAttributionStatus(result.state)}${backupLabel}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update TLH commit attribution: ${message}`, "error");
			}
		},
	});
}
