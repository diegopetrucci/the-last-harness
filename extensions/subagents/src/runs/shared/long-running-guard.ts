import type { ResolvedControlConfig } from "../../shared/types.ts";

interface LongRunningNoticeMetrics {
	startedAt: number;
	now: number;
	turns: number;
	tokens: number;
}

type LongRunningTriggerReason = "time_threshold" | "turn_threshold" | "token_threshold";

interface FailedMutatingAttempt {
	tool: string;
	path?: string;
	error: string;
	ts: number;
}

interface MutatingFailureState {
	consecutiveFailures: number;
	lastFailureAt?: number;
	recentFailures: FailedMutatingAttempt[];
	lastMutatingPath?: string;
	repeatedPathFailures: number;
}

const EMBEDDED_FILE_WRITE_PATTERNS = [
	/\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
	/\bwrite_text\s*\(/,
	/\bopen\s*\([^)]*,\s*["'][wa]/,
];

const MUTATING_BASH_PATTERNS = [
	/(^|[;&|()\s])rm\s+/,
	/(^|[;&|()\s])mv\s+/,
	/(^|[;&|()\s])cp\s+/,
	/(^|[;&|()\s])mkdir\s+/,
	/(^|[;&|()\s])touch\s+/,
	/(^|[;&|()\s])git\s+apply\b/,
	/(^|[;&|()\s])patch\s+/,
	/(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b/,
	/(^|[;&|()\s])perl\s+[^\n;&|]*\s-pi\b/,
	/(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
	...EMBEDDED_FILE_WRITE_PATTERNS,
];

const SHELL_COMMAND_BOUNDARIES = new Set([";", "|", "&", "(", ")", "\n"]);
const EXECUTABLE_HEREDOC_INTERPRETER_PATTERN = /^(node|nodejs|python(?:[23](?:\.\d+)?)?)$/;
const GIT_MUTATING_SUBCOMMANDS = new Set(["add", "cherry-pick", "commit", "merge", "mv", "push", "rebase", "revert", "rm"]);
const GIT_GLOBAL_OPTION_VALUE_FLAGS = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);
const GIT_GLOBAL_BOOLEAN_FLAGS = new Set(["--bare", "--help", "--literal-pathspecs", "--no-lazy-fetch", "--no-optional-locks", "--no-pager", "--paginate", "--version", "-h", "-p", "-P"]);
const GIT_TERMINAL_READ_ONLY_FLAGS = new Set(["--help", "--version", "-h"]);
const GIT_MUTATING_TAG_FLAGS = new Set(["-a", "-d", "-f", "-F", "-m", "-s", "-u", "--annotate", "--delete", "--file", "--force", "--local-user", "--message", "--sign"]);
const GIT_READ_ONLY_TAG_FLAGS = new Set(["-l", "-n", "-v", "--column", "--color", "--contains", "--format", "--help", "--ignore-case", "--list", "--merged", "--no-contains", "--no-merged", "--omit-empty", "--points-at", "--sort", "--verify"]);
const GIT_MUTATING_BRANCH_FLAGS = new Set(["-c", "-C", "-d", "-D", "-f", "-m", "-M", "-u", "--copy", "--delete", "--edit-description", "--force", "--move", "--set-upstream-to", "--unset-upstream"]);
const GIT_READ_ONLY_BRANCH_FLAGS = new Set(["-a", "-l", "-r", "--all", "--color", "--column", "--contains", "--format", "--ignore-case", "--list", "--merged", "--no-color", "--no-column", "--no-contains", "--no-merged", "--omit-empty", "--points-at", "--remotes", "--show-current", "--sort", "--verbose", "-v"]);
const GIT_MUTATING_STASH_SUBCOMMANDS = new Set(["apply", "branch", "clear", "create", "drop", "pop", "push", "save", "store"]);
const GIT_READ_ONLY_STASH_SUBCOMMANDS = new Set(["list", "show"]);
const GH_GLOBAL_OPTION_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);
const GH_GLOBAL_BOOLEAN_FLAGS = new Set(["--help", "--version", "-h"]);
const GH_TERMINAL_READ_ONLY_FLAGS = new Set(["--help", "--version", "-h"]);
const GH_MUTATING_PR_SUBCOMMANDS = new Set(["close", "comment", "create", "edit", "merge", "ready", "reopen", "review"]);
const GH_MUTATING_RELEASE_SUBCOMMANDS = new Set(["create", "delete", "delete-asset", "edit", "upload"]);
const GH_API_WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const GH_API_FIELD_FLAGS = new Set(["-F", "-f", "--field", "--raw-field"]);

const MUTATING_FAILURE_HINTS = [
	"failed",
	"error",
	"no exact match",
	"did not match",
	"malformed",
	"rejected",
	"unable",
	"cannot",
	"could not",
];

export function resolveCurrentPath(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
	if (!toolName || !args) return undefined;
	const direct = ["path", "file", "filename", "target", "cwd"];
	for (const key of direct) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : undefined;
		if (!command) return undefined;
		const redirect = command.match(/(?:>|>>|tee\s+)(\S+)/);
		if (redirect?.[1]) return redirect[1];
	}
	return undefined;
}

function hasUnquotedFileRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (char !== ">") continue;
		if (command[i - 1] === "-") continue;
		const isDouble = command[i + 1] === ">";
		let cursor = i + (isDouble ? 2 : 1);
		while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
		if (cursor >= command.length) continue;
		const targetStart = command[cursor]!;
		if (targetStart === "&" || targetStart === "|" || targetStart === ";") continue;
		if (targetStart === "(" || targetStart === ")") continue;
		return true;
	}
	return false;
}

function isExecutableHereDocInterpreter(executable: string | undefined): boolean {
	return executable !== undefined && EXECUTABLE_HEREDOC_INTERPRETER_PATTERN.test(executable);
}

function shouldScanHereDocBody(prelude: string): boolean {
	const segments = splitShellCommandSegments(prelude);
	const segment = segments.at(-1);
	if (!segment) return false;
	const tokens = tokenizeShellSegment(segment);
	const commandIndex = skipShellPrefixes(tokens);
	return isExecutableHereDocInterpreter(tokens[commandIndex]);
}

function collectHereDocDescriptors(line: string): Array<{ delimiter: string; scanBody: boolean }> {
	const descriptors: Array<{ delimiter: string; scanBody: boolean }> = [];
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (char === "\\" && !inSingle) {
			if (i + 1 < line.length) i++;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || char !== "<" || line[i + 1] !== "<") continue;
		const scanBody = shouldScanHereDocBody(line.slice(0, i));
		i += 2;
		if (line[i] === "-") i += 1;
		while (i < line.length && /\s/.test(line[i]!)) i++;
		if (i >= line.length) break;
		const quote = line[i];
		if (quote === "'" || quote === '"') {
			i += 1;
			const start = i;
			while (i < line.length && line[i] !== quote) i++;
			const delimiter = line.slice(start, i);
			if (delimiter) descriptors.push({ delimiter, scanBody });
			continue;
		}
		const start = i;
		while (i < line.length && !/\s/.test(line[i]!) && !";|&()<>".includes(line[i]!)) i++;
		const delimiter = line.slice(start, i);
		if (delimiter) descriptors.push({ delimiter, scanBody });
		if (i < line.length) i -= 1;
	}
	return descriptors;
}

function stripHereDocBodies(command: string): string {
	const lines = command.split("\n");
	if (lines.length === 1) return command;
	const stripped: string[] = [];
	const pendingDelimiters: string[] = [];
	for (const line of lines) {
		if (pendingDelimiters.length > 0) {
			if (line.trim() === pendingDelimiters[0]) pendingDelimiters.shift();
			continue;
		}
		stripped.push(line);
		pendingDelimiters.push(...collectHereDocDescriptors(line).map(({ delimiter }) => delimiter));
	}
	return stripped.join("\n");
}

function extractExecutableHereDocBodies(command: string): string[] {
	const lines = command.split("\n");
	if (lines.length === 1) return [];
	const bodies: string[] = [];
	const pending: Array<{ delimiter: string; scanBody: boolean; lines: string[] }> = [];
	for (const line of lines) {
		if (pending.length > 0) {
			const current = pending[0]!;
			if (line.trim() === current.delimiter) {
				if (current.scanBody) bodies.push(current.lines.join("\n"));
				pending.shift();
				continue;
			}
			if (current.scanBody) current.lines.push(line);
			continue;
		}
		pending.push(...collectHereDocDescriptors(line).map(({ delimiter, scanBody }) => ({ delimiter, scanBody, lines: [] })));
	}
	return bodies;
}

function splitShellCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "\\" && !inSingle) {
			current += char;
			if (i + 1 < command.length) current += command[++i]!;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			current += char;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			current += char;
			continue;
		}
		if (!inSingle && !inDouble && SHELL_COMMAND_BOUNDARIES.has(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if ((char === "&" || char === "|") && command[i + 1] === char) i++;
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function tokenizeShellSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i]!;
		if (char === "\\" && !inSingle) {
			if (i + 1 < segment.length) {
				current += segment[++i]!;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function skipShellPrefixes(tokens: string[]): number {
	let index = 0;
	if (tokens[index] === "env") index += 1;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)) index += 1;
	return index;
}

function skipLeadingCliOptions(
	tokens: string[],
	start: number,
	valueFlags: ReadonlySet<string>,
	booleanFlags: ReadonlySet<string>,
): number {
	let index = start;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "--") return index + 1;
		if (!token.startsWith("-")) return index;
		if ([...valueFlags].some((flag) => flag.startsWith("--") && token.startsWith(`${flag}=`))) {
			index += 1;
			continue;
		}
		if (valueFlags.has(token)) {
			index += 2;
			continue;
		}
		if (booleanFlags.has(token)) {
			index += 1;
			continue;
		}
		index += 1;
	}
	return index;
}

function isMutatingGitTagInvocation(args: string[]): boolean {
	if (args.length === 0) return false;
	if (args.some((arg) => GIT_MUTATING_TAG_FLAGS.has(arg))) return true;
	if (args.some((arg) => GIT_READ_ONLY_TAG_FLAGS.has(arg))) return false;
	return args.some((arg) => !arg.startsWith("-"));
}

function isMutatingGitResetInvocation(args: string[]): boolean {
	if (args.length === 0) return false;
	const mutatingModes = new Set(["--hard", "--mixed", "--soft", "--merge", "--keep"]);
	if (args.some((arg) => mutatingModes.has(arg))) return true;
	return args.some((arg) => !arg.startsWith("-"));
}

function isMutatingGitCleanInvocation(args: string[]): boolean {
	let hasForce = false;
	for (const arg of args) {
		if (arg === "--dry-run") return false;
		if (arg === "--force") {
			hasForce = true;
			continue;
		}
		if (!arg.startsWith("-")) continue;
		if (arg.includes("n")) return false;
		if (arg.includes("f")) hasForce = true;
	}
	return hasForce;
}

function isMutatingGitBranchInvocation(args: string[]): boolean {
	if (args.length === 0) return false;
	if (args.some((arg) => GIT_MUTATING_BRANCH_FLAGS.has(arg) || arg.startsWith("--set-upstream-to="))) return true;
	if (args.some((arg) => GIT_READ_ONLY_BRANCH_FLAGS.has(arg) || /^-v+$/.test(arg))) return false;
	if (args.some((arg) => /^--(?:contains|format|merged|no-contains|no-merged|points-at|sort)=/.test(arg))) return false;
	return args.some((arg) => !arg.startsWith("-"));
}

function isMutatingGitStashInvocation(args: string[]): boolean {
	if (args.length === 0) return true;
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (!subcommand) return true;
	if (GIT_READ_ONLY_STASH_SUBCOMMANDS.has(subcommand) || subcommand === "help") return false;
	return GIT_MUTATING_STASH_SUBCOMMANDS.has(subcommand);
}

function hasTerminalReadOnlyFlag(args: string[], readOnlyFlags: ReadonlySet<string>): boolean {
	return args.some((arg) => readOnlyFlags.has(arg));
}

function parseGhApiInvocation(args: string[]): { explicitMethod?: string; hasFieldParameters: boolean } {
	let explicitMethod: string | undefined;
	let hasFieldParameters = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		const upper = token.toUpperCase();
		if (upper === "-X" || upper === "--METHOD" || upper === "--REQUEST") {
			explicitMethod = args[i + 1]?.toUpperCase() ?? explicitMethod;
			i += 1;
			continue;
		}
		if (upper.startsWith("-X") && upper.length > 2) {
			explicitMethod = upper.slice(2);
			continue;
		}
		if (upper.startsWith("--METHOD=")) {
			explicitMethod = upper.slice("--METHOD=".length);
			continue;
		}
		if (upper.startsWith("--REQUEST=")) {
			explicitMethod = upper.slice("--REQUEST=".length);
			continue;
		}
		if (GH_API_FIELD_FLAGS.has(token)) {
			hasFieldParameters = true;
			i += 1;
			continue;
		}
		if (token.startsWith("--field=") || token.startsWith("--raw-field=")) {
			hasFieldParameters = true;
		}
	}
	return { explicitMethod, hasFieldParameters };
}

function isMutatingGhApiInvocation(args: string[]): boolean {
	const { explicitMethod, hasFieldParameters } = parseGhApiInvocation(args);
	return explicitMethod !== undefined
		? GH_API_WRITE_METHODS.has(explicitMethod)
		: hasFieldParameters;
}

type StructuredShellCommandClassification = "mutating" | "read-only" | "unrecognized";

function classifyStructuredShellSegment(segment: string): StructuredShellCommandClassification {
	const tokens = tokenizeShellSegment(segment);
	const commandIndex = skipShellPrefixes(tokens);
	const executable = tokens[commandIndex];
	if (executable === "git") {
		const invocationArgs = tokens.slice(commandIndex + 1);
		if (hasTerminalReadOnlyFlag(invocationArgs, GIT_TERMINAL_READ_ONLY_FLAGS)) return "read-only";
		const subcommandIndex = skipLeadingCliOptions(tokens, commandIndex + 1, GIT_GLOBAL_OPTION_VALUE_FLAGS, GIT_GLOBAL_BOOLEAN_FLAGS);
		const subcommand = tokens[subcommandIndex];
		const subcommandArgs = tokens.slice(subcommandIndex + 1);
		if (!subcommand) return "read-only";
		if (GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return "mutating";
		if (subcommand === "branch" && isMutatingGitBranchInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "checkout" && (subcommandArgs.includes("-b") || subcommandArgs.includes("-B"))) return "mutating";
		if (subcommand === "switch" && (subcommandArgs.includes("-c") || subcommandArgs.includes("-C"))) return "mutating";
		if (subcommand === "stash" && isMutatingGitStashInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "tag" && isMutatingGitTagInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "apply" && !subcommandArgs.includes("--check")) return "mutating";
		if (subcommand === "reset" && isMutatingGitResetInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "clean" && isMutatingGitCleanInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "restore") return "mutating";
		return "read-only";
	}
	if (executable === "gh") {
		const invocationArgs = tokens.slice(commandIndex + 1);
		if (hasTerminalReadOnlyFlag(invocationArgs, GH_TERMINAL_READ_ONLY_FLAGS)) return "read-only";
		const subcommandIndex = skipLeadingCliOptions(tokens, commandIndex + 1, GH_GLOBAL_OPTION_VALUE_FLAGS, GH_GLOBAL_BOOLEAN_FLAGS);
		const subcommand = tokens[subcommandIndex];
		const subcommandArgs = tokens.slice(subcommandIndex + 1);
		if (!subcommand) return "read-only";
		if (subcommand === "pr" && GH_MUTATING_PR_SUBCOMMANDS.has(subcommandArgs[0] ?? "")) return "mutating";
		if (subcommand === "api" && isMutatingGhApiInvocation(subcommandArgs)) return "mutating";
		if (subcommand === "release" && GH_MUTATING_RELEASE_SUBCOMMANDS.has(subcommandArgs[0] ?? "")) return "mutating";
		return "read-only";
	}
	return "unrecognized";
}

function hasMutatingExecutableHereDocBody(command: string): boolean {
	return extractExecutableHereDocBodies(command)
		.some((body) => EMBEDDED_FILE_WRITE_PATTERNS.some((pattern) => pattern.test(body)));
}

export function isMutatingBashCommand(command: string): boolean {
	const shellSyntax = stripHereDocBodies(command);
	if (hasUnquotedFileRedirection(shellSyntax) || hasMutatingExecutableHereDocBody(command)) return true;
	for (const segment of splitShellCommandSegments(shellSyntax)) {
		const structuredClassification = classifyStructuredShellSegment(segment);
		if (structuredClassification === "mutating") return true;
		if (structuredClassification === "read-only") continue;
		if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(segment))) return true;
	}
	return false;
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
	if (!toolName) return false;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	const command = typeof args?.command === "string" ? args.command : "";
	if (!command.trim()) return false;
	return isMutatingBashCommand(command);
}

export function didMutatingToolFail(text: string): boolean {
	const lowered = text.toLowerCase();
	return MUTATING_FAILURE_HINTS.some((hint) => lowered.includes(hint));
}

export function nextLongRunningTrigger(
	config: ResolvedControlConfig,
	metrics: LongRunningNoticeMetrics,
): LongRunningTriggerReason | undefined {
	if (metrics.now - metrics.startedAt >= config.activeNoticeAfterMs) return "time_threshold";
	if (config.activeNoticeAfterTurns !== undefined && metrics.turns >= config.activeNoticeAfterTurns) return "turn_threshold";
	if (config.activeNoticeAfterTokens !== undefined && metrics.tokens >= config.activeNoticeAfterTokens) return "token_threshold";
	return undefined;
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
	state.consecutiveFailures = 0;
	state.lastFailureAt = undefined;
	state.recentFailures = [];
	state.lastMutatingPath = undefined;
	state.repeatedPathFailures = 0;
}

export function createMutatingFailureState(): MutatingFailureState {
	return {
		consecutiveFailures: 0,
		recentFailures: [],
		repeatedPathFailures: 0,
	};
}

export function recordMutatingFailure(
	state: MutatingFailureState,
	input: FailedMutatingAttempt,
	windowMs: number,
): void {
	if (state.lastFailureAt === undefined || input.ts - state.lastFailureAt > windowMs) {
		state.consecutiveFailures = 0;
		state.recentFailures = [];
		state.repeatedPathFailures = 0;
		state.lastMutatingPath = undefined;
	}
	state.lastFailureAt = input.ts;
	state.consecutiveFailures += 1;
	if (input.path && state.lastMutatingPath === input.path) {
		state.repeatedPathFailures += 1;
	} else if (input.path) {
		state.lastMutatingPath = input.path;
		state.repeatedPathFailures = 1;
	}
	state.recentFailures.push(input);
	if (state.recentFailures.length > 3) state.recentFailures.shift();
}

export function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold || state.repeatedPathFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
	if (state.recentFailures.length === 0) return undefined;
	return state.recentFailures
		.map((entry) => `${entry.tool}${entry.path ? `(${entry.path})` : ""}: ${entry.error}`)
		.join(" | ");
}
