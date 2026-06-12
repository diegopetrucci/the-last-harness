import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhAttributionConfig, TlhAttributionWriteResult, TlhCommitAttributionState, TlhSettings } from "./types.js";

export const TLH_DEFAULT_COMMIT_ATTRIBUTION = `Co-authored-by: The Last Harness <hi@thelastharness.com>`;

const TOGGLE_TLH_GIT_ATTRIBUTION_COMMAND_HELP = "Usage: /toggle-tlh-git-attribution";
const TLH_GIT_COMMIT_ATTRIBUTION_PROMPT_HEADING = "## TLH Git Commit Attribution";
const TLH_GIT_COMMIT_BLOCK_REASON = "Blocked TLH bash git commit because the commit message is missing the required TLH attribution footer.";
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--config-env", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);
const ENV_SHORT_OPTIONS_WITH_VALUES = new Set(["-C", "-P", "-a", "-u"]);
const ENV_LONG_OPTIONS_WITH_VALUES = new Set(["--argv0", "--chdir", "--unset"]);
const ENV_SHORT_OPTIONS_WITHOUT_VALUES = new Set(["-0", "-i", "-v"]);
const ENV_LONG_OPTIONS_WITHOUT_VALUES = new Set(["--ignore-environment", "--null"]);
const ENV_SHORT_SPLIT_STRING_OPTIONS = new Set(["-S"]);
const ENV_LONG_SPLIT_STRING_OPTIONS = new Set(["--split-string"]);
const SHELL_COMMAND_WRAPPERS = new Set(["bash", "sh"]);
const SHELL_OPTIONS_WITH_VALUES = new Set(["-o", "-O", "--rcfile", "--init-file"]);
const MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH = 4;

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

function commitMessageEndsWithFooter(message: string, footer: string): boolean {
	const trimmed = message.trimEnd();
	if (trimmed === footer) {
		return true;
	}
	return trimmed.endsWith(`\n\n${footer}`) || trimmed.endsWith(`\r\n\r\n${footer}`);
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
		if (character === "<" && command[index + 1] === "(") {
			const processSubstitution = readProcessSubstitutionBody(command, index + 2);
			if (processSubstitution) {
				index = processSubstitution.endIndex - 1;
				continue;
			}
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

type ShellCommandSegment = {
	segment: string;
	separator: string;
};

function splitShellCommandSegments(command: string): ShellCommandSegment[] {
	if (!command) {
		return [{ segment: "", separator: "" }];
	}

	const segments: ShellCommandSegment[] = [];
	let startIndex = 0;
	while (startIndex < command.length) {
		const { segment, nextIndex } = readShellCommandSegment(command, startIndex);
		segments.push({
			segment,
			separator: command.slice(startIndex + segment.length, nextIndex),
		});
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

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
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
		if (character === "<" && command[index + 1] === "(") {
			const processSubstitution = readProcessSubstitutionBody(command, index + 2);
			if (processSubstitution) {
				current += command.slice(index, processSubstitution.endIndex);
				index = processSubstitution.endIndex - 1;
				continue;
			}
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

function isShellVariableAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripLeadingShellCommandPrefixes(tokens: string[]): string[] {
	let startIndex = 0;
	while (startIndex < tokens.length) {
		const token = tokens[startIndex];
		const lowerToken = token.toLowerCase();
		if (["!", "if", "then", "else", "do", "command"].includes(lowerToken)) {
			startIndex += 1;
			continue;
		}
		if (isShellVariableAssignmentToken(token)) {
			startIndex += 1;
			continue;
		}
		break;
	}
	return tokens.slice(startIndex);
}

function commandBasename(token: string): string {
	const normalizedToken = token.toLowerCase();
	const slashIndex = normalizedToken.lastIndexOf("/");
	return slashIndex === -1 ? normalizedToken : normalizedToken.slice(slashIndex + 1);
}

function isSupportedEnvCommand(command: string): boolean {
	return commandBasename(command) === "env";
}

function normalizeCaseInsensitiveLongOptionToken(token: string): string {
	return token.startsWith("--") ? token.toLowerCase() : token;
}

type EnvLeadingOptionParseResult =
	| { kind: "continue"; nextIndex: number }
	| { kind: "missing-value" }
	| { kind: "split-string"; effectiveTokens: string[] | undefined }
	| { kind: "unknown-option" }
	| { kind: "not-an-option" };

function isSupportedEnvOptionWithoutValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_OPTIONS_WITHOUT_VALUES.has(token) || ENV_LONG_OPTIONS_WITHOUT_VALUES.has(normalizedToken);
}

function isSupportedEnvOptionWithValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_OPTIONS_WITH_VALUES.has(token) || ENV_LONG_OPTIONS_WITH_VALUES.has(normalizedToken);
}

function isSupportedEnvOptionWithAttachedValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return normalizedToken.startsWith("--argv0=") || normalizedToken.startsWith("--chdir=") || normalizedToken.startsWith("--unset=");
}

function isEnvSplitStringOption(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_SPLIT_STRING_OPTIONS.has(token) || ENV_LONG_SPLIT_STRING_OPTIONS.has(normalizedToken);
}

function getAttachedEnvSplitStringCommand(token: string): string | undefined {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	if (normalizedToken.startsWith("--split-string=")) {
		return token.slice(token.indexOf("=") + 1);
	}
	if (token.startsWith("-S") && token.length > 2) {
		return token.slice(2);
	}
	return undefined;
}

function stripLeadingOptionTerminator(tokens: string[]): string[] {
	return tokens[0] === "--" ? tokens.slice(1) : tokens;
}

function buildEnvSplitStringEffectiveTokens(payload: string, remainingTokens: string[]): string[] {
	return stripLeadingOptionTerminator([...tokenizeShellWords(payload), ...remainingTokens]);
}

function getEnvSplitStringEffectiveTokens(tokens: string[], splitStringIndex: number): string[] | undefined {
	const attachedPayload = getAttachedEnvSplitStringCommand(tokens[splitStringIndex] ?? "");
	const payload = attachedPayload ?? tokens[splitStringIndex + 1];
	if (payload === undefined) {
		return undefined;
	}
	const remainingTokens = attachedPayload !== undefined ? tokens.slice(splitStringIndex + 1) : tokens.slice(splitStringIndex + 2);
	return buildEnvSplitStringEffectiveTokens(payload, remainingTokens);
}

function getShortEnvLeadingOptionParseResult(tokens: string[], index: number): EnvLeadingOptionParseResult | undefined {
	const token = tokens[index];
	if (!token || token === "-" || !token.startsWith("-") || token.startsWith("--")) {
		return undefined;
	}

	const shortOptions = token.slice(1);
	for (let optionIndex = 0; optionIndex < shortOptions.length; optionIndex += 1) {
		const option = `-${shortOptions[optionIndex]}`;
		if (ENV_SHORT_OPTIONS_WITHOUT_VALUES.has(option)) {
			continue;
		}
		if (ENV_SHORT_OPTIONS_WITH_VALUES.has(option)) {
			const attachedValue = shortOptions.slice(optionIndex + 1);
			if (attachedValue) {
				return { kind: "continue", nextIndex: index + 1 };
			}
			return tokens[index + 1] === undefined ? { kind: "missing-value" } : { kind: "continue", nextIndex: index + 2 };
		}
		if (ENV_SHORT_SPLIT_STRING_OPTIONS.has(option)) {
			const attachedPayload = shortOptions.slice(optionIndex + 1);
			const payload = attachedPayload || tokens[index + 1];
			if (payload === undefined) {
				return { kind: "split-string", effectiveTokens: undefined };
			}
			const remainingTokens = attachedPayload ? tokens.slice(index + 1) : tokens.slice(index + 2);
			return { kind: "split-string", effectiveTokens: buildEnvSplitStringEffectiveTokens(payload, remainingTokens) };
		}
		return { kind: "unknown-option" };
	}

	return { kind: "continue", nextIndex: index + 1 };
}

function getEnvLeadingOptionParseResult(tokens: string[], index: number): EnvLeadingOptionParseResult {
	const token = tokens[index] ?? "";
	if (isShellVariableAssignmentToken(token) || isSupportedEnvOptionWithoutValue(token)) {
		return { kind: "continue", nextIndex: index + 1 };
	}
	if (isSupportedEnvOptionWithValue(token)) {
		return tokens[index + 1] === undefined ? { kind: "missing-value" } : { kind: "continue", nextIndex: index + 2 };
	}
	if (isSupportedEnvOptionWithAttachedValue(token)) {
		return { kind: "continue", nextIndex: index + 1 };
	}
	if (isEnvSplitStringOption(token) || getAttachedEnvSplitStringCommand(token) !== undefined) {
		return { kind: "split-string", effectiveTokens: getEnvSplitStringEffectiveTokens(tokens, index) };
	}
	const shortOptionParseResult = getShortEnvLeadingOptionParseResult(tokens, index);
	if (shortOptionParseResult) {
		return shortOptionParseResult;
	}
	if (token.startsWith("-")) {
		return { kind: "unknown-option" };
	}
	return { kind: "not-an-option" };
}

function unwrapLeadingEnvCommandTokens(tokens: string[]): string[] | undefined {
	if (!isSupportedEnvCommand(tokens[0] ?? "")) {
		return undefined;
	}

	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--") {
			index += 1;
			break;
		}
		const parseResult = getEnvLeadingOptionParseResult(tokens, index);
		if (parseResult.kind === "continue") {
			index = parseResult.nextIndex;
			continue;
		}
		if (parseResult.kind === "missing-value") {
			return [];
		}
		if (parseResult.kind === "split-string" || parseResult.kind === "unknown-option") {
			return undefined;
		}
		break;
	}
	return tokens.slice(index);
}

function normalizeShellCommandTokensFromTokens(tokens: string[]): string[] {
	let normalizedTokens = stripLeadingShellCommandPrefixes(tokens);
	while (true) {
		const unwrappedTokens = unwrapLeadingEnvCommandTokens(normalizedTokens);
		if (!unwrappedTokens) {
			return normalizedTokens;
		}
		normalizedTokens = stripLeadingShellCommandPrefixes(unwrappedTokens);
	}
}

function normalizeShellCommandTokens(segment: string): string[] {
	return normalizeShellCommandTokensFromTokens(tokenizeShellWords(segment));
}

function getGitCommitArgumentsFromTokens(tokens: string[]): string[] | undefined {
	if (commandBasename(tokens[0] ?? "") !== "git") {
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

function getGitCommitArguments(segment: string): string[] | undefined {
	return getGitCommitArgumentsFromTokens(normalizeShellCommandTokens(segment));
}

function shortGitCommitMessageOptionConsumesFollowingValue(token: string): boolean {
	if (!token.startsWith("-") || token.startsWith("--")) {
		return false;
	}
	const messageFlagIndex = token.slice(1).indexOf("m");
	if (messageFlagIndex === -1) {
		return false;
	}
	return token.slice(messageFlagIndex + 2).length === 0;
}

function gitCommitOptionConsumesFollowingValue(commitArguments: string[], index: number): boolean {
	const token = commitArguments[index];
	if (!token) {
		return false;
	}
	const lowerToken = token.toLowerCase();
	if (lowerToken === "-m" || lowerToken === "--message" || lowerToken === "-f" || lowerToken === "--file") {
		return commitArguments[index + 1] !== undefined;
	}
	if (shortGitCommitMessageOptionConsumesFollowingValue(token)) {
		return commitArguments[index + 1] !== undefined;
	}
	return false;
}

function splitGitCommitArgumentsAtPathspecTerminator(commitArguments: string[]): {
	optionArguments: string[];
	pathspecArguments: string[];
} {
	for (let index = 0; index < commitArguments.length; index += 1) {
		if (gitCommitOptionConsumesFollowingValue(commitArguments, index)) {
			index += 1;
			continue;
		}
		if (commitArguments[index] === "--") {
			return {
				optionArguments: commitArguments.slice(0, index),
				pathspecArguments: commitArguments.slice(index + 1),
			};
		}
	}
	return { optionArguments: commitArguments, pathspecArguments: [] };
}

function getInlineGitCommitMessageParts(commitArguments: string[]): string[] {
	const messages: string[] = [];
	const { optionArguments } = splitGitCommitArgumentsAtPathspecTerminator(commitArguments);

	for (let index = 0; index < optionArguments.length; index += 1) {
		const token = optionArguments[index];
		const lowerToken = token.toLowerCase();
		if (lowerToken === "-m" || lowerToken === "--message") {
			const value = optionArguments[index + 1];
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
			const value = optionArguments[index + 1];
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

function getInlineGitCommitFileArgumentValue(commitArguments: string[]): string | undefined {
	let value: string | undefined;
	const { optionArguments } = splitGitCommitArgumentsAtPathspecTerminator(commitArguments);
	for (let index = 0; index < optionArguments.length; index += 1) {
		const token = optionArguments[index];
		const lowerToken = token.toLowerCase();
		if (lowerToken === "-f" || lowerToken === "--file") {
			const nextValue = optionArguments[index + 1];
			if (nextValue !== undefined) {
				value = nextValue;
				index += 1;
			}
			continue;
		}
		if (lowerToken.startsWith("-f")) {
			value = token.slice(2);
			continue;
		}
		if (lowerToken.startsWith("--file=")) {
			value = token.slice("--file=".length);
		}
	}
	return value;
}

function hasInlineLikeGitCommitMessageOrFileArgument(commitArguments: string[]): boolean {
	return hasInlineGitCommitMessageArgument(commitArguments) || hasInlineGitCommitFileArgument(commitArguments);
}

function getInlineGitCommitFileArgument(commitArguments: string[]): "stdin" | "process-substitution" | undefined {
	const value = getInlineGitCommitFileArgumentValue(commitArguments);
	if (value === "-") {
		return "stdin";
	}
	if (value?.startsWith("<(")) {
		return "process-substitution";
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

function readProcessSubstitutionBody(command: string, startIndex: number): { body: string; endIndex: number } | undefined {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	const hereDocs: HereDocSpec[] = [];
	let depth = 1;

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
		if (character === "\n" && hereDocs.length > 0) {
			const { nextIndex } = readHereDocBodies(command, index + 1, hereDocs);
			index = nextIndex - 1;
			hereDocs.length = 0;
			continue;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return { body: command.slice(startIndex, index), endIndex: index + 1 };
		}
	}

	return undefined;
}

function getShellCommandPrefix(command: string): string {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
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
		if (character === "\n") {
			return command.slice(0, index);
		}
	}

	return command;
}

function renderPrintfEscape(format: string, index: number): { output: string; nextIndex: number } | undefined {
	const specifier = format[index + 1];
	if (specifier === undefined) {
		return undefined;
	}
	if (specifier === "n") {
		return { output: "\n", nextIndex: index + 1 };
	}
	return undefined;
}

function renderPrintfCycle(format: string, args: string[], startIndex: number): { output: string; nextIndex: number } | undefined {
	let output = "";
	let nextIndex = startIndex;

	for (let index = 0; index < format.length; index += 1) {
		const character = format[index];
		if (character === "\\") {
			const escape = renderPrintfEscape(format, index);
			if (!escape) {
				return undefined;
			}
			output += escape.output;
			index = escape.nextIndex;
			continue;
		}
		if (character !== "%") {
			output += character;
			continue;
		}
		const specifier = format[index + 1];
		if (specifier === undefined) {
			return undefined;
		}
		index += 1;
		if (specifier === "%") {
			output += "%";
			continue;
		}
		if (specifier !== "s") {
			return undefined;
		}
		output += args[nextIndex] ?? "";
		nextIndex += 1;
	}

	return { output, nextIndex };
}

function renderPrintfOutput(args: string[]): string | undefined {
	let formatIndex = 0;
	if (args[formatIndex] === "--") {
		formatIndex += 1;
	}
	const format = args[formatIndex];
	if (format === undefined) {
		return "";
	}

	const values = args.slice(formatIndex + 1);
	if (format.length === 0) {
		return "";
	}

	let output = "";
	let nextIndex = 0;
	do {
		const cycle = renderPrintfCycle(format, values, nextIndex);
		if (!cycle) {
			return undefined;
		}
		output += cycle.output;
		if (cycle.nextIndex === nextIndex && nextIndex < values.length) {
			return undefined;
		}
		nextIndex = cycle.nextIndex;
	} while (nextIndex < values.length);

	return output;
}

function renderEchoOutput(args: string[]): string {
	let index = 0;
	let appendTrailingNewline = true;
	while (/^-n+$/.test(args[index] ?? "")) {
		appendTrailingNewline = false;
		index += 1;
	}
	if (args[index] === "--") {
		index += 1;
	}
	return `${args.slice(index).join(" ")}${appendTrailingNewline ? "\n" : ""}`;
}

function getObviousShellSegmentOutput(segment: string): string | undefined {
	const commandPrefix = getShellCommandPrefix(segment);
	const tokens = stripLeadingShellCommandPrefixes(tokenizeShellWords(commandPrefix.trim()));
	if (tokens.length === 0) {
		return "";
	}

	const command = tokens[0]?.toLowerCase();
	if (command === "cat") {
		const hereDocBodies = extractHereDocBodies(segment);
		if (hereDocBodies.length === 0 || tokens.slice(1).some((token) => !token.startsWith("<<"))) {
			return undefined;
		}
		return hereDocBodies.join("");
	}
	if (command === "printf") {
		return renderPrintfOutput(tokens.slice(1));
	}
	if (command === "echo") {
		return renderEchoOutput(tokens.slice(1));
	}
	return undefined;
}

function getProcessSubstitutionOutput(command: string): string | undefined {
	let output = "";
	for (const { segment, separator } of splitShellCommandSegments(command)) {
		if (separator && separator !== ";" && separator !== "\n") {
			return undefined;
		}
		const trimmedSegment = segment.trim();
		if (!trimmedSegment) {
			continue;
		}
		const segmentOutput = getObviousShellSegmentOutput(trimmedSegment);
		if (segmentOutput === undefined) {
			return undefined;
		}
		output += segmentOutput;
	}
	return output;
}

function processSubstitutionIncludesTlhCommitAttributionFooter(fileArgument: string, footer: string): boolean {
	if (!fileArgument.startsWith("<(") || !fileArgument.endsWith(")")) {
		return false;
	}
	const output = getProcessSubstitutionOutput(fileArgument.slice(2, -1));
	return output !== undefined && commitMessageEndsWithFooter(output, footer);
}

function hasInlineGitCommitFileArgument(commitArguments: string[]): boolean {
	return getInlineGitCommitFileArgument(commitArguments) !== undefined;
}

function isSupportedShellCommandWrapper(command: string): boolean {
	return SHELL_COMMAND_WRAPPERS.has(commandBasename(command));
}

function getWrappedShellCommandFromTokens(tokens: string[]): string | undefined {
	const normalizedTokens = normalizeShellCommandTokensFromTokens(tokens);
	if (normalizedTokens.length === 0 || !isSupportedShellCommandWrapper(normalizedTokens[0])) {
		return undefined;
	}

	for (let index = 1; index < normalizedTokens.length; index += 1) {
		const token = normalizedTokens[index];
		const lowerToken = token.toLowerCase();
		if (token === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
			const commandToken = normalizedTokens[index + 1];
			return commandToken === "--" ? normalizedTokens[index + 2] : commandToken;
		}
		if (SHELL_OPTIONS_WITH_VALUES.has(lowerToken) || lowerToken === "+o") {
			if (normalizedTokens[index + 1] === undefined) {
				return undefined;
			}
			index += 1;
			continue;
		}
		if (lowerToken.startsWith("--rcfile=") || lowerToken.startsWith("--init-file=")) {
			continue;
		}
		if (/^\+[A-Za-z]+$/.test(token)) {
			continue;
		}
		if (!token.startsWith("-")) {
			return undefined;
		}
	}
	return undefined;
}

function getWrappedShellCommand(segment: string): string | undefined {
	return getWrappedShellCommandFromTokens(tokenizeShellWords(segment));
}

function areInlineGitCommitArgumentsAttributed(commitArguments: string[], footer: string, segment?: string): boolean {
	const inlineMessages = getInlineGitCommitMessageParts(commitArguments);
	if (inlineMessages.length > 0) {
		return commitMessageEndsWithFooter(inlineMessages.join("\n\n"), footer);
	}
	const fileArgument = getInlineGitCommitFileArgument(commitArguments);
	if (fileArgument === "stdin") {
		if (!segment) {
			return false;
		}
		const hereDocBody = extractHereDocBodies(segment).at(-1);
		return hereDocBody !== undefined && commitMessageEndsWithFooter(normalizeTrailingLineEnding(hereDocBody), footer);
	}
	if (fileArgument === "process-substitution") {
		const fileValue = getInlineGitCommitFileArgumentValue(commitArguments);
		return fileValue !== undefined && processSubstitutionIncludesTlhCommitAttributionFooter(fileValue, footer);
	}
	return false;
}

function buildTlhGitCommitAttributionBlockReason(footer: string): string {
	return [TLH_GIT_COMMIT_BLOCK_REASON, "Retry with this exact footer at the end of the commit message:", footer].join("\n\n");
}

function hasObviousGitCommitInTokens(tokens: string[], depth = 0): boolean {
	if (depth > MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH) {
		return true;
	}

	const normalizedTokens = normalizeShellCommandTokensFromTokens(tokens);
	const commitArguments = getGitCommitArgumentsFromTokens(normalizedTokens);
	if (commitArguments) {
		return hasInlineLikeGitCommitMessageOrFileArgument(commitArguments);
	}

	const wrappedCommand = getWrappedShellCommandFromTokens(normalizedTokens);
	return wrappedCommand !== undefined && hasObviousGitCommitInCommand(wrappedCommand, depth + 1);
}

function hasObviousGitCommitInCommand(command: string, depth = 0): boolean {
	if (depth > MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH) {
		return true;
	}

	for (const { segment } of splitShellCommandSegments(command)) {
		const trimmedSegment = segment.trim();
		if (!trimmedSegment) {
			continue;
		}
		if (hasObviousGitCommitInTokens(tokenizeShellWords(trimmedSegment), depth)) {
			return true;
		}
	}
	return false;
}

function getWrappedShellGitCommitAttributionBlockReasonFromTokens(
	tokens: string[],
	footer: string,
	depth = 0,
	failClosedOnCommitLike = false,
	sourceSegment?: string,
): string | undefined {
	if (depth > MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH) {
		return buildTlhGitCommitAttributionBlockReason(footer);
	}

	const normalizedTokens = normalizeShellCommandTokensFromTokens(tokens);
	const commitArguments = getGitCommitArgumentsFromTokens(normalizedTokens);
	if (commitArguments) {
		if (hasInlineLikeGitCommitMessageOrFileArgument(commitArguments)) {
			return areInlineGitCommitArgumentsAttributed(commitArguments, footer, sourceSegment)
				? undefined
				: buildTlhGitCommitAttributionBlockReason(footer);
		}
		return failClosedOnCommitLike ? buildTlhGitCommitAttributionBlockReason(footer) : undefined;
	}

	const wrappedCommand = getWrappedShellCommandFromTokens(normalizedTokens);
	return wrappedCommand !== undefined
		? getWrappedShellGitCommitAttributionBlockReason(wrappedCommand, footer, depth + 1, failClosedOnCommitLike, sourceSegment)
		: undefined;
}

function getEnvContextGitCommitAttributionBlockReasonFromTokens(
	tokens: string[],
	footer: string,
	sourceSegment: string,
	depth = 0,
	failClosedOnCommitLike = false,
): string | undefined {
	if (depth > MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH) {
		return buildTlhGitCommitAttributionBlockReason(footer);
	}

	const envTokens = isSupportedEnvCommand(tokens[0] ?? "") ? tokens.slice(1) : tokens;
	let index = 0;
	while (index < envTokens.length) {
		if (envTokens[index] === "--") {
			index += 1;
			break;
		}
		const parseResult = getEnvLeadingOptionParseResult(envTokens, index);
		if (parseResult.kind === "continue") {
			index = parseResult.nextIndex;
			continue;
		}
		if (parseResult.kind === "missing-value") {
			return undefined;
		}
		if (parseResult.kind === "split-string") {
			return parseResult.effectiveTokens !== undefined
				? getEnvContextGitCommitAttributionBlockReasonFromTokens(
					parseResult.effectiveTokens,
					footer,
					sourceSegment,
					depth + 1,
					failClosedOnCommitLike,
				)
				: undefined;
		}
		if (parseResult.kind === "unknown-option") {
			return getEnvContextGitCommitAttributionBlockReasonFromTokens(
				stripLeadingOptionTerminator(envTokens.slice(index + 1)),
				footer,
				sourceSegment,
				depth + 1,
				true,
			);
		}
		break;
	}

	return getWrappedShellGitCommitAttributionBlockReasonFromTokens(
		envTokens.slice(index),
		footer,
		depth + 1,
		failClosedOnCommitLike,
		sourceSegment,
	);
}

function getUnsupportedEnvGitCommitAttributionBlockReason(
	segment: string,
	footer: string,
	depth = 0,
	sourceSegment = segment,
): string | undefined {
	const tokens = stripLeadingShellCommandPrefixes(tokenizeShellWords(segment));
	if (!isSupportedEnvCommand(tokens[0] ?? "")) {
		return undefined;
	}

	let index = 1;
	while (index < tokens.length) {
		if (tokens[index] === "--") {
			index += 1;
			break;
		}
		const parseResult = getEnvLeadingOptionParseResult(tokens, index);
		if (parseResult.kind === "continue") {
			index = parseResult.nextIndex;
			continue;
		}
		if (parseResult.kind === "missing-value") {
			return undefined;
		}
		if (parseResult.kind === "split-string") {
			return parseResult.effectiveTokens !== undefined
				? getEnvContextGitCommitAttributionBlockReasonFromTokens(parseResult.effectiveTokens, footer, sourceSegment, depth + 1)
				: undefined;
		}
		if (parseResult.kind === "unknown-option") {
			return getEnvContextGitCommitAttributionBlockReasonFromTokens(
				stripLeadingOptionTerminator(tokens.slice(index + 1)),
				footer,
				sourceSegment,
				depth + 1,
				true,
			);
		}
		break;
	}
	return undefined;
}

function getWrappedShellGitCommitAttributionBlockReason(
	command: string,
	footer: string,
	depth = 0,
	failClosedOnCommitLike = false,
	sourceSegment?: string,
): string | undefined {
	if (depth > MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH) {
		return buildTlhGitCommitAttributionBlockReason(footer);
	}

	for (const { segment } of splitShellCommandSegments(command)) {
		const trimmedSegment = segment.trim();
		if (!trimmedSegment) {
			continue;
		}
		const effectiveSourceSegment = sourceSegment ?? trimmedSegment;
		const commitArguments = getGitCommitArguments(trimmedSegment);
		const isObviousInlineGitCommit = commitArguments !== undefined && hasInlineLikeGitCommitMessageOrFileArgument(commitArguments);
		if (isObviousInlineGitCommit) {
			if (
				areInlineGitCommitArgumentsAttributed(commitArguments, footer, trimmedSegment)
				|| areInlineGitCommitArgumentsAttributed(commitArguments, footer, effectiveSourceSegment)
			) {
				continue;
			}
			return buildTlhGitCommitAttributionBlockReason(footer);
		}
		if (failClosedOnCommitLike && commitArguments) {
			return buildTlhGitCommitAttributionBlockReason(footer);
		}

		const unsupportedEnvBlockReason = getUnsupportedEnvGitCommitAttributionBlockReason(trimmedSegment, footer, depth, effectiveSourceSegment);
		if (unsupportedEnvBlockReason) {
			return unsupportedEnvBlockReason;
		}

		const wrappedCommand = getWrappedShellCommand(trimmedSegment);
		if (!wrappedCommand) {
			continue;
		}
		const blockReason = getWrappedShellGitCommitAttributionBlockReason(
			wrappedCommand,
			footer,
			depth + 1,
			failClosedOnCommitLike,
			effectiveSourceSegment,
		);
		if (blockReason) {
			return blockReason;
		}
	}
	return undefined;
}

export function buildTlhCommitAttributionPrompt(state: TlhCommitAttributionState): string | undefined {
	if (!state.enabled || !state.footer) {
		return undefined;
	}
	return [
		TLH_GIT_COMMIT_ATTRIBUTION_PROMPT_HEADING,
		"If you create a git commit with the bash tool, end the commit message with a blank line followed by this exact TLH footer:",
		`\`\`\`text\n${state.footer}\n\`\`\``,
	].join("\n\n");
}

export function getTlhGitCommitAttributionBlockReason(command: string, state: TlhCommitAttributionState): string | undefined {
	if (!state.enabled || !state.footer) {
		return undefined;
	}
	return getWrappedShellGitCommitAttributionBlockReason(command, state.footer);
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
