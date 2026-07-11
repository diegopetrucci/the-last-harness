// Pure shell-parsing helpers, constants, and types.
// This module has no dependency on git-attribution concepts; the seam is
// one-directional: attribution.ts imports from here, never the reverse.

export const ENV_SHORT_OPTIONS_WITH_VALUES = new Set(["-C", "-P", "-a", "-u"]);
export const ENV_LONG_OPTIONS_WITH_VALUES = new Set(["--argv0", "--chdir", "--unset"]);
export const ENV_SHORT_OPTIONS_WITHOUT_VALUES = new Set(["-0", "-i", "-v"]);
export const ENV_LONG_OPTIONS_WITHOUT_VALUES = new Set(["--ignore-environment", "--null"]);
export const ENV_SHORT_SPLIT_STRING_OPTIONS = new Set(["-S"]);
export const ENV_LONG_SPLIT_STRING_OPTIONS = new Set(["--split-string"]);
export const SHELL_COMMAND_WRAPPERS = new Set(["bash", "sh"]);
export const SHELL_OPTIONS_WITH_VALUES = new Set(["-o", "-O", "--rcfile", "--init-file"]);
export const MAX_WRAPPED_SHELL_GIT_COMMIT_RECURSION_DEPTH = 4;

export type HereDocSpec = {
	delimiter: string;
	allowIndent: boolean;
};

export type ShellCommandSegment = {
	segment: string;
	separator: string;
};

export type EnvLeadingOptionParseResult =
	| { kind: "continue"; nextIndex: number }
	| { kind: "missing-value" }
	| { kind: "split-string"; effectiveTokens: string[] | undefined }
	| { kind: "unknown-option" }
	| { kind: "not-an-option" };

export function readHereDocSpec(command: string, startIndex: number): { spec: HereDocSpec; endIndex: number } | undefined {
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

export function readHereDocBodies(command: string, startIndex: number, specs: HereDocSpec[]): { bodies: string[]; nextIndex: number } {
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

export function extractHereDocBodies(segment: string): string[] {
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

export function normalizeTrailingLineEnding(value: string): string {
	return value.replace(/\r?\n$/, "");
}

export function readProcessSubstitutionBody(command: string, startIndex: number): { body: string; endIndex: number } | undefined {
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

export function readShellCommandSegment(command: string, startIndex: number): { segment: string; nextIndex: number } {
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

export function splitShellCommandSegments(command: string): ShellCommandSegment[] {
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

export function tokenizeShellWords(command: string): string[] {
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

export function isShellVariableAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function stripLeadingShellCommandPrefixes(tokens: string[]): string[] {
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

export function commandBasename(token: string): string {
	const normalizedToken = token.toLowerCase();
	const slashIndex = normalizedToken.lastIndexOf("/");
	return slashIndex === -1 ? normalizedToken : normalizedToken.slice(slashIndex + 1);
}

export function isSupportedEnvCommand(command: string): boolean {
	return commandBasename(command) === "env";
}

export function normalizeCaseInsensitiveLongOptionToken(token: string): string {
	return token.startsWith("--") ? token.toLowerCase() : token;
}

export function isSupportedEnvOptionWithoutValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_OPTIONS_WITHOUT_VALUES.has(token) || ENV_LONG_OPTIONS_WITHOUT_VALUES.has(normalizedToken);
}

export function isSupportedEnvOptionWithValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_OPTIONS_WITH_VALUES.has(token) || ENV_LONG_OPTIONS_WITH_VALUES.has(normalizedToken);
}

export function isSupportedEnvOptionWithAttachedValue(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return normalizedToken.startsWith("--argv0=") || normalizedToken.startsWith("--chdir=") || normalizedToken.startsWith("--unset=");
}

export function isEnvSplitStringOption(token: string): boolean {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	return ENV_SHORT_SPLIT_STRING_OPTIONS.has(token) || ENV_LONG_SPLIT_STRING_OPTIONS.has(normalizedToken);
}

export function getAttachedEnvSplitStringCommand(token: string): string | undefined {
	const normalizedToken = normalizeCaseInsensitiveLongOptionToken(token);
	if (normalizedToken.startsWith("--split-string=")) {
		return token.slice(token.indexOf("=") + 1);
	}
	if (token.startsWith("-S") && token.length > 2) {
		return token.slice(2);
	}
	return undefined;
}

export function stripLeadingOptionTerminator(tokens: string[]): string[] {
	return tokens[0] === "--" ? tokens.slice(1) : tokens;
}

export function buildEnvSplitStringEffectiveTokens(payload: string, remainingTokens: string[]): string[] {
	return stripLeadingOptionTerminator([...tokenizeShellWords(payload), ...remainingTokens]);
}

export function getEnvSplitStringEffectiveTokens(tokens: string[], splitStringIndex: number): string[] | undefined {
	const attachedPayload = getAttachedEnvSplitStringCommand(tokens[splitStringIndex] ?? "");
	const payload = attachedPayload ?? tokens[splitStringIndex + 1];
	if (payload === undefined) {
		return undefined;
	}
	const remainingTokens = attachedPayload !== undefined ? tokens.slice(splitStringIndex + 1) : tokens.slice(splitStringIndex + 2);
	return buildEnvSplitStringEffectiveTokens(payload, remainingTokens);
}

export function getShortEnvLeadingOptionParseResult(tokens: string[], index: number): EnvLeadingOptionParseResult | undefined {
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

export function getEnvLeadingOptionParseResult(tokens: string[], index: number): EnvLeadingOptionParseResult {
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

export function unwrapLeadingEnvCommandTokens(tokens: string[]): string[] | undefined {
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

export function normalizeShellCommandTokensFromTokens(tokens: string[]): string[] {
	let normalizedTokens = stripLeadingShellCommandPrefixes(tokens);
	while (true) {
		const unwrappedTokens = unwrapLeadingEnvCommandTokens(normalizedTokens);
		if (!unwrappedTokens) {
			return normalizedTokens;
		}
		normalizedTokens = stripLeadingShellCommandPrefixes(unwrappedTokens);
	}
}

export function normalizeShellCommandTokens(segment: string): string[] {
	return normalizeShellCommandTokensFromTokens(tokenizeShellWords(segment));
}

export function getShellCommandPrefix(command: string): string {
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

export function renderPrintfEscape(format: string, index: number): { output: string; nextIndex: number } | undefined {
	const specifier = format[index + 1];
	if (specifier === undefined) {
		return undefined;
	}
	if (specifier === "n") {
		return { output: "\n", nextIndex: index + 1 };
	}
	return undefined;
}

export function renderPrintfCycle(format: string, args: string[], startIndex: number): { output: string; nextIndex: number } | undefined {
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

export function renderPrintfOutput(args: string[]): string | undefined {
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

export function renderEchoOutput(args: string[]): string {
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

export function getObviousShellSegmentOutput(segment: string): string | undefined {
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

export function getProcessSubstitutionOutput(command: string): string | undefined {
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

export function isSupportedShellCommandWrapper(command: string): boolean {
	return SHELL_COMMAND_WRAPPERS.has(commandBasename(command));
}

export function getWrappedShellCommandFromTokens(tokens: string[]): string | undefined {
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

export function getWrappedShellCommand(segment: string): string | undefined {
	return getWrappedShellCommandFromTokens(tokenizeShellWords(segment));
}
