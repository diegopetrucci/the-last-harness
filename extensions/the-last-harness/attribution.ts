import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import {
	commandBasename,
	extractHereDocBodies,
	getEnvLeadingOptionParseResult,
	getProcessSubstitutionOutput,
	getWrappedShellCommand,
	getWrappedShellCommandFromTokens,
	isSupportedEnvCommand,
	MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH,
	normalizeShellCommandTokens,
	normalizeShellCommandTokensFromTokens,
	normalizeTrailingLineEnding,
	splitShellCommandSegments,
	stripLeadingOptionTerminator,
	stripLeadingShellCommandPrefixes,
	tokenizeShellWords,
} from "./shell-parser.js";
import type { TlhAttributionConfig, TlhCommitAttributionState, TlhSettings } from "./types.js";

export const TLH_DEFAULT_COMMIT_ATTRIBUTION = `Co-authored-by: The Last Harness <hi@thelastharness.com>`;

const TLH_GIT_COMMIT_ATTRIBUTION_PROMPT_HEADING = "## TLH Git Commit Attribution";
const TLH_GIT_COMMIT_BLOCK_REASON = "Blocked TLH bash git commit because the commit message is missing the required TLH attribution footer.";
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--config-env", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);

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

type AttributionCommandModule = {
	handleToggleTlhGitAttributionCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type TlhAttributionCommandFacadeOptions = {
	loadModule?: () => Promise<AttributionCommandModule>;
};

function createRetryableLazyImport<TModule>(loader: () => Promise<TModule>): () => Promise<TModule> {
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

export function registerToggleTlhGitAttributionCommand(pi: ExtensionAPI, options: TlhAttributionCommandFacadeOptions = {}): void {
	const loadModule = createRetryableLazyImport(
		options.loadModule ?? (() => import("./attribution-command.js") as Promise<AttributionCommandModule>),
	);
	pi.registerCommand("toggle-tlh-git-attribution", {
		description: "Toggle TLH git commit attribution",
		handler: async (args, ctx) => {
			const module = await loadModule();
			await module.handleToggleTlhGitAttributionCommand(pi, args, ctx);
		},
	});
}
