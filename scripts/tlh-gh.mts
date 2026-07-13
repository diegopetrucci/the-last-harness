#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_PER_PAGE = 100;
const DEFAULT_LIMIT = 100;
const GITHUB_REMOTE_HOSTS = new Set(["github.com", "ssh.github.com"]);
const GRAPHQL_ONLY_OPERATIONS = new Map([
	["pr review-threads", "GitHub review threads require GraphQL-only APIs."],
	["pr status-check-rollup", "GitHub statusCheckRollup requires GraphQL-only APIs."],
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface RepoRef {
	owner: string;
	repo: string;
	source: "explicit" | "git-remote";
	remoteName?: string;
	remoteUrl?: string;
}

interface CliArgs {
	commandPath: string[];
	repo?: string;
	owner?: string;
	repoName?: string;
	state?: string;
	limit: number;
	perPage: number;
	page?: number;
	base?: string;
	head?: string;
	labels?: string;
	creator?: string;
	assignee?: string;
	since?: string;
	title?: string;
	body?: string;
	bodyFile?: string;
	draft: boolean;
	help: boolean;
	positionals: string[];
}

interface GhResponse {
	statusCode: number;
	headers: Map<string, string>;
	body: string;
}

interface CommandContext {
	args: CliArgs;
	repo: RepoRef;
}

interface GhApiOptions {
	method?: "GET" | "POST";
	extraArgs?: string[];
	input?: string;
}

function usage(): string {
	return `Usage: tlh github <command> [options]

REST-first GitHub helper for The Last Harness.

Commands:
  rate-limit
  repo view
  issue view <number>
  issue list [--state <open|closed|all>] [--labels <csv>] [--creator <login>] [--assignee <login>] [--since <timestamp>] [--limit <n>] [--per-page <n>] [--page <n>]
  issue comments <number> [--limit <n>] [--per-page <n>] [--page <n>]
  issue create --title <title> [--body <text> | --body-file <path>]
  issue comment <number> (--body <text> | --body-file <path>)
  pr view <number>
  pr list [--state <open|closed|all>] [--base <branch>] [--head <owner:branch>] [--limit <n>] [--per-page <n>] [--page <n>]
  pr diff <number>
  pr reviews <number> [--limit <n>] [--per-page <n>]
  pr comments <number> [--limit <n>] [--per-page <n>]
  pr create --title <title> --base <branch> --head <owner:branch> [--body <text> | --body-file <path>] [--draft]
  pr comment <number> (--body <text> | --body-file <path>)
  pr review-threads <number>          Unsupported: GraphQL-only
  pr status-check-rollup <number>     Unsupported: GraphQL-only
  checks <ref> [--limit <n>] [--per-page <n>]
  statuses <ref>

Repo selection:
  --repo <owner/repo>                 Explicit repository
  --owner <owner> --name <repo>       Explicit repository parts
  Otherwise infer from local GitHub git remotes (origin/upstream first)
`;
}

function parseIntegerOption(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer.`);
	}
	return parsed;
}

function optionValue(argv: readonly string[], index: number, flag: string, { allowEmpty = false } = {}): string {
	if (index + 1 >= argv.length) {
		throw new Error(`${flag} requires a value.`);
	}
	const value = argv[index + 1] as string;
	if (!allowEmpty && value.length === 0) {
		throw new Error(`${flag} requires a value.`);
	}
	return value;
}

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
		commandPath: [],
		limit: DEFAULT_LIMIT,
		perPage: DEFAULT_PER_PAGE,
		draft: false,
		help: false,
		positionals: [],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--repo") {
			args.repo = optionValue(argv, index, "--repo");
			index += 1;
			continue;
		}
		if (arg === "--owner") {
			args.owner = optionValue(argv, index, "--owner");
			index += 1;
			continue;
		}
		if (arg === "--name") {
			args.repoName = optionValue(argv, index, "--name");
			index += 1;
			continue;
		}
		if (arg === "--state") {
			args.state = optionValue(argv, index, "--state");
			index += 1;
			continue;
		}
		if (arg === "--limit") {
			args.limit = parseIntegerOption(optionValue(argv, index, "--limit"), "--limit");
			index += 1;
			continue;
		}
		if (arg === "--per-page") {
			args.perPage = parseIntegerOption(optionValue(argv, index, "--per-page"), "--per-page");
			index += 1;
			continue;
		}
		if (arg === "--page") {
			args.page = parseIntegerOption(optionValue(argv, index, "--page"), "--page");
			index += 1;
			continue;
		}
		if (arg === "--base") {
			args.base = optionValue(argv, index, "--base");
			index += 1;
			continue;
		}
		if (arg === "--head") {
			args.head = optionValue(argv, index, "--head");
			index += 1;
			continue;
		}
		if (arg === "--labels") {
			args.labels = optionValue(argv, index, "--labels");
			index += 1;
			continue;
		}
		if (arg === "--creator") {
			args.creator = optionValue(argv, index, "--creator");
			index += 1;
			continue;
		}
		if (arg === "--assignee") {
			args.assignee = optionValue(argv, index, "--assignee");
			index += 1;
			continue;
		}
		if (arg === "--since") {
			args.since = optionValue(argv, index, "--since");
			index += 1;
			continue;
		}
		if (arg === "--title") {
			args.title = optionValue(argv, index, "--title", { allowEmpty: true });
			index += 1;
			continue;
		}
		if (arg === "--body") {
			args.body = optionValue(argv, index, "--body", { allowEmpty: true });
			index += 1;
			continue;
		}
		if (arg === "--body-file") {
			args.bodyFile = optionValue(argv, index, "--body-file");
			index += 1;
			continue;
		}
		if (arg === "--draft") {
			args.draft = true;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (args.commandPath.length < 2 && !["checks", "statuses", "rate-limit"].includes(args.commandPath[0] ?? "")) {
			args.commandPath.push(arg);
			continue;
		}
		if (args.commandPath.length === 0) {
			args.commandPath.push(arg);
			continue;
		}
		args.positionals.push(arg);
	}

	if (args.commandPath.length === 0 && args.positionals.length > 0) {
		args.commandPath.push(args.positionals.shift() as string);
	}
	if (args.commandPath[0] === "checks" || args.commandPath[0] === "statuses" || args.commandPath[0] === "rate-limit") {
		args.positionals = args.commandPath.length > 1
			? [...args.commandPath.slice(1), ...args.positionals]
			: args.positionals;
		args.commandPath = [args.commandPath[0]];
	}
	return args;
}

function sanitizeSecretText(value: string): string {
	return value
		.replace(/(Authorization:\s*(?:token|bearer)\s+)([^\s]+)/giu, "$1[REDACTED]")
		.replace(/(Bearer\s+)([^\s]+)/gu, "$1[REDACTED]")
		.replace(/(access_token=)([^&\s]+)/giu, "$1[REDACTED]")
		.replace(/github_pat_[A-Za-z0-9_]+/gu, "[REDACTED]")
		.replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "[REDACTED]");
}

function commandKey(commandPath: readonly string[]): string {
	return commandPath.join(" ");
}

function validateRepoParts(owner: string, repo: string, source: string): Pick<RepoRef, "owner" | "repo"> {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
		throw new Error(`Invalid GitHub repository owner from ${source}: ${JSON.stringify(owner)}`);
	}
	if (!/^[A-Za-z0-9._-]+$/u.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) {
		throw new Error(`Invalid GitHub repository name from ${source}: ${JSON.stringify(repo)}`);
	}
	return { owner, repo };
}

function parseRepoSpec(spec: string): Pick<RepoRef, "owner" | "repo"> {
	const trimmed = spec.trim();
	const parts = trimmed.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Repository must be in owner/repo form, got: ${JSON.stringify(spec)}`);
	}
	return validateRepoParts(parts[0], parts[1], "--repo");
}

function parseGitHubRemoteUrl(remoteUrl: string): Pick<RepoRef, "owner" | "repo"> | undefined {
	const scpLikeMatch = remoteUrl.match(/^(?:git@|ssh:\/\/git@)([^:/]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?$/u);
	if (scpLikeMatch) {
		const [, host, owner, repo] = scpLikeMatch;
		if (!GITHUB_REMOTE_HOSTS.has(host.toLowerCase())) return undefined;
		try {
			return validateRepoParts(owner, repo, "git remote");
		} catch {
			return undefined;
		}
	}

	let parsed: URL;
	try {
		parsed = new URL(remoteUrl);
	} catch {
		return undefined;
	}
	if (!GITHUB_REMOTE_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
	const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
	if (segments.length !== 2 || !segments[0] || !segments[1]) return undefined;
	const repo = segments[1].endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
	if (!repo) return undefined;
	try {
		return validateRepoParts(segments[0], repo, "git remote");
	} catch {
		return undefined;
	}
}

function runCommand(command: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
	return spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		input,
		env: {
			...process.env,
			GH_PAGER: "cat",
			PAGER: "cat",
			NO_COLOR: process.env.NO_COLOR ?? "1",
		},
	});
}

function requireSuccess(command: string, args: readonly string[], failureHint: string): string {
	const result = runCommand(command, args);
	if (result.error) throw result.error;
	if ((result.status ?? 1) !== 0) {
		const detail = sanitizeSecretText(`${result.stderr || result.stdout || "command failed"}`.trim());
		throw new Error(`${failureHint} ${detail}`.trim());
	}
	return result.stdout.trim();
}

function inferRepoFromGit(): RepoRef {
	const remoteList = requireSuccess(
		"git",
		["remote"],
		"Failed to inspect git remotes. Use --repo owner/repo outside a GitHub checkout.",
	);
	const remotes = remoteList.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
	const orderedRemotes = ["origin", "upstream", ...remotes.filter((remote) => remote !== "origin" && remote !== "upstream")];
	for (const remoteName of orderedRemotes) {
		if (!remotes.includes(remoteName)) continue;
		const remoteUrl = requireSuccess(
			"git",
			["remote", "get-url", remoteName],
			`Failed to inspect git remote ${JSON.stringify(remoteName)}.`,
		);
		const parsed = parseGitHubRemoteUrl(remoteUrl);
		if (parsed) {
			return { ...parsed, source: "git-remote", remoteName, remoteUrl };
		}
	}
	throw new Error("Could not infer a GitHub owner/repo from local git remotes. Use --repo owner/repo.");
}

function resolveRepo(args: CliArgs): RepoRef {
	if (args.repo && (args.owner || args.repoName)) {
		throw new Error("Use either --repo owner/repo or --owner/--name, not both.");
	}
	if (args.repo) {
		return { ...parseRepoSpec(args.repo), source: "explicit" };
	}
	if (args.owner || args.repoName) {
		if (!args.owner || !args.repoName) {
			throw new Error("--owner and --name must be provided together.");
		}
		return { ...validateRepoParts(args.owner, args.repoName, "--owner/--name"), source: "explicit" };
	}
	return inferRepoFromGit();
}

function encodeQuery(params: Record<string, string | number | undefined>): string {
	const entries = Object.entries(params).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return "";
	const query = new URLSearchParams();
	for (const [key, value] of entries) {
		query.set(key, String(value));
	}
	return `?${query.toString()}`;
}

function normalizeEndpoint(endpoint: string): string {
	if (endpoint.startsWith("https://api.github.com/")) {
		const parsed = new URL(endpoint);
		return `${parsed.pathname}${parsed.search}`;
	}
	return endpoint;
}

function parseGhResponse(output: string): GhResponse {
	const normalized = output.replace(/\r\n/gu, "\n");
	const separator = normalized.indexOf("\n\n");
	if (separator === -1) {
		throw new Error("gh api returned an unexpected response without HTTP headers.");
	}
	const headerBlock = normalized.slice(0, separator);
	const body = normalized.slice(separator + 2);
	const headerLines = headerBlock.split("\n");
	const statusLine = headerLines.shift();
	if (!statusLine) {
		throw new Error("gh api returned an empty HTTP status line.");
	}
	const statusMatch = statusLine.match(/\s(\d{3})(?:\s|$)/u);
	if (!statusMatch) {
		throw new Error(`gh api returned an unparseable HTTP status line: ${JSON.stringify(statusLine)}`);
	}
	const headers = new Map<string, string>();
	for (const line of headerLines) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) continue;
		headers.set(line.slice(0, separatorIndex).trim().toLowerCase(), line.slice(separatorIndex + 1).trim());
	}
	return {
		statusCode: Number.parseInt(statusMatch[1], 10),
		headers,
		body,
	};
}

function parseJsonBody<T extends JsonValue>(response: GhResponse, expected: string): T {
	try {
		return JSON.parse(response.body) as T;
	} catch {
		const snippet = sanitizeSecretText(response.body.slice(0, 200));
		throw new Error(`Expected ${expected} JSON from GitHub but received malformed data: ${JSON.stringify(snippet)}`);
	}
}

function ghApiFailure(method: string, endpoint: string, detailValue: string): Error {
	const detail = sanitizeSecretText(detailValue.trim() || "gh api failed");
	const rateLimitHint = /rate limit|quota/iu.test(detail)
		? " GitHub rate limits blocked the request. Run `tlh github rate-limit` or wait for quota to recover."
		: "";
	return new Error(`gh api ${method} ${endpoint} failed: ${detail} Run 'gh auth status' to confirm GitHub authentication.${rateLimitHint}`);
}

function runGhApi(endpoint: string, options: GhApiOptions = {}): GhResponse {
	const method = options.method ?? "GET";
	const normalizedEndpoint = normalizeEndpoint(endpoint);
	const args = ["api", "--method", method, "--include", ...(options.extraArgs ?? [])];
	if (options.input !== undefined) {
		args.push("--input", "-");
	}
	args.push(normalizedEndpoint);
	const result = runCommand("gh", args, options.input);
	if (result.error) throw result.error;
	if ((result.status ?? 1) !== 0) {
		throw ghApiFailure(method, normalizedEndpoint, result.stderr || result.stdout || "gh api failed");
	}
	const response = parseGhResponse(result.stdout);
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw ghApiFailure(method, normalizedEndpoint, `GitHub returned HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`);
	}
	return response;
}

function nextLink(headers: Map<string, string>): string | undefined {
	const linkHeader = headers.get("link");
	if (!linkHeader) return undefined;
	for (const part of linkHeader.split(",")) {
		const match = part.match(/<([^>]+)>;\s*rel="next"/u);
		if (match) return match[1];
	}
	return undefined;
}

function listRestCollection(
	endpoint: string,
	limit: number,
	collectionKey?: string,
	includeItem: (item: JsonValue) => boolean = () => true,
): JsonValue[] | { [key: string]: JsonValue } {
	let nextEndpoint: string | undefined = endpoint;
	let remaining = limit;
	let page = 0;
	/** @type {JsonValue[]} */
	const collected: JsonValue[] = [];
	let envelope: { [key: string]: JsonValue } | undefined;

	while (nextEndpoint && remaining > 0) {
		page += 1;
		if (page > 100) {
			throw new Error("Pagination guard triggered after 100 GitHub API pages.");
		}
		const response = runGhApi(nextEndpoint);
		if (collectionKey) {
			const parsed = parseJsonBody<{ [key: string]: JsonValue }>(response, "an object");
			const items = parsed[collectionKey];
			if (!Array.isArray(items)) {
				throw new Error(`Expected GitHub response field ${JSON.stringify(collectionKey)} to be an array.`);
			}
			if (!envelope) envelope = { ...parsed, [collectionKey]: [] };
			const slice = items.filter(includeItem).slice(0, remaining);
			collected.push(...slice);
			remaining -= slice.length;
			nextEndpoint = remaining > 0 ? nextLink(response.headers) : undefined;
			continue;
		}
		const parsed = parseJsonBody<JsonValue[]>(response, "an array");
		if (!Array.isArray(parsed)) {
			throw new Error("Expected GitHub response to be an array.");
		}
		const slice = parsed.filter(includeItem).slice(0, remaining);
		collected.push(...slice);
		remaining -= slice.length;
		nextEndpoint = remaining > 0 ? nextLink(response.headers) : undefined;
	}

	if (collectionKey) {
		return { ...(envelope ?? {}), [collectionKey]: collected };
	}
	return collected;
}

function requireNoPositionals(args: CliArgs): void {
	if (args.positionals.length !== 0) {
		throw new Error(`Unexpected positional argument: ${JSON.stringify(args.positionals[0])}`);
	}
}

function requireSinglePositional(args: CliArgs, label: string): string {
	if (args.positionals.length !== 1) {
		throw new Error(`Expected exactly one ${label}.`);
	}
	return args.positionals[0];
}

function requirePositiveIntegerIdentifier(args: CliArgs, label: string): string {
	const value = requireSinglePositional(args, label);
	if (!/^[1-9][0-9]*$/u.test(value)) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return value;
}

function requireOption(value: string | undefined, flag: string): string {
	if (value === undefined) {
		throw new Error(`${flag} is required for this command.`);
	}
	return value;
}

function ensureBodySource(args: CliArgs, { required }: { required: boolean }): string | undefined {
	if (args.body !== undefined && args.bodyFile !== undefined) {
		throw new Error("Use either --body or --body-file, not both.");
	}
	if (args.bodyFile !== undefined) {
		try {
			return readFileSync(args.bodyFile, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read --body-file ${JSON.stringify(args.bodyFile)}: ${sanitizeSecretText(message)}`, { cause: error });
		}
	}
	if (args.body !== undefined) {
		return args.body;
	}
	if (required) {
		throw new Error("Provide exactly one of --body or --body-file for this command.");
	}
	return undefined;
}

function requireBody(args: CliArgs): string {
	const body = ensureBodySource(args, { required: true });
	if (body === undefined) {
		throw new Error("Provide exactly one of --body or --body-file for this command.");
	}
	return body;
}

function formatJson(value: JsonValue | { [key: string]: JsonValue }): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function mutationEnvelope(operation: string, repo: RepoRef, resourceKey: string, resourceValue: JsonValue): { [key: string]: JsonValue } {
	return {
		operation,
		repository: `${repo.owner}/${repo.repo}`,
		[resourceKey]: resourceValue,
	};
}

function postJson(endpoint: string, payload: Record<string, JsonValue>): JsonValue {
	const response = runGhApi(endpoint, {
		method: "POST",
		extraArgs: ["-H", "Content-Type: application/json"],
		input: JSON.stringify(payload),
	});
	const parsed = parseJsonBody<JsonValue>(response, "an object");
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error(`Expected GitHub ${endpoint} response to be an object.`);
	}
	return parsed;
}

function runRateLimit(args: CliArgs): string {
	requireNoPositionals(args);
	const response = runGhApi("/rate_limit");
	const parsed = parseJsonBody<JsonValue>(response, "an object");
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error("Expected /rate_limit to return an object.");
	}
	return formatJson(parsed);
}

function runRepoView(context: CommandContext): string {
	requireNoPositionals(context.args);
	const response = runGhApi(`/repos/${context.repo.owner}/${context.repo.repo}`);
	const parsed = parseJsonBody<JsonValue>(response, "an object");
	return formatJson(parsed);
}

function runIssueView(context: CommandContext): string {
	const issueNumber = requirePositiveIntegerIdentifier(context.args, "issue number");
	const response = runGhApi(`/repos/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}`);
	return formatJson(parseJsonBody<JsonValue>(response, "an object"));
}

function isIssueItem(item: JsonValue): boolean {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		throw new Error("Expected each GitHub issue list item to be an object.");
	}
	return !("pull_request" in item);
}

function runIssueList(context: CommandContext): string {
	requireNoPositionals(context.args);
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/issues${encodeQuery({
		state: context.args.state,
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
		labels: context.args.labels,
		creator: context.args.creator,
		assignee: context.args.assignee,
		since: context.args.since,
	})}`;
	return formatJson(listRestCollection(
		endpoint,
		context.args.limit,
		undefined,
		isIssueItem,
	));
}

function runIssueComments(context: CommandContext): string {
	const issueNumber = requirePositiveIntegerIdentifier(context.args, "issue number");
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}/comments${encodeQuery({
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
	})}`;
	return formatJson(listRestCollection(endpoint, context.args.limit));
}

function runIssueCreate(context: CommandContext): string {
	requireNoPositionals(context.args);
	const title = requireOption(context.args.title, "--title");
	const body = ensureBodySource(context.args, { required: false });
	const payload: Record<string, JsonValue> = { title };
	if (body !== undefined) {
		payload.body = body;
	}
	const issue = postJson(`/repos/${context.repo.owner}/${context.repo.repo}/issues`, payload);
	return formatJson(mutationEnvelope("issue.create", context.repo, "issue", issue));
}

function runIssueComment(context: CommandContext): string {
	const issueNumber = requirePositiveIntegerIdentifier(context.args, "issue number");
	const body = requireBody(context.args);
	const comment = postJson(`/repos/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}/comments`, { body });
	return formatJson(mutationEnvelope("issue.comment", context.repo, "comment", comment));
}

function runPrView(context: CommandContext): string {
	const prNumber = requirePositiveIntegerIdentifier(context.args, "pull request number");
	const response = runGhApi(`/repos/${context.repo.owner}/${context.repo.repo}/pulls/${prNumber}`);
	return formatJson(parseJsonBody<JsonValue>(response, "an object"));
}

function runPrList(context: CommandContext): string {
	requireNoPositionals(context.args);
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/pulls${encodeQuery({
		state: context.args.state,
		base: context.args.base,
		head: context.args.head,
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
	})}`;
	return formatJson(listRestCollection(endpoint, context.args.limit));
}

function runPrDiff(context: CommandContext): string {
	const prNumber = requirePositiveIntegerIdentifier(context.args, "pull request number");
	const response = runGhApi(`/repos/${context.repo.owner}/${context.repo.repo}/pulls/${prNumber}`, {
		extraArgs: ["-H", "Accept: application/vnd.github.v3.diff"],
	});
	return response.body;
}

function runPrReviews(context: CommandContext): string {
	const prNumber = requirePositiveIntegerIdentifier(context.args, "pull request number");
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/pulls/${prNumber}/reviews${encodeQuery({
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
	})}`;
	return formatJson(listRestCollection(endpoint, context.args.limit));
}

function runPrComments(context: CommandContext): string {
	const prNumber = requirePositiveIntegerIdentifier(context.args, "pull request number");
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/pulls/${prNumber}/comments${encodeQuery({
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
	})}`;
	return formatJson(listRestCollection(endpoint, context.args.limit));
}

function runPrCreate(context: CommandContext): string {
	requireNoPositionals(context.args);
	const title = requireOption(context.args.title, "--title");
	const base = requireOption(context.args.base, "--base");
	const head = requireOption(context.args.head, "--head");
	const body = ensureBodySource(context.args, { required: false });
	const payload: Record<string, JsonValue> = { title, base, head };
	if (body !== undefined) {
		payload.body = body;
	}
	if (context.args.draft) {
		payload.draft = true;
	}
	const pullRequest = postJson(`/repos/${context.repo.owner}/${context.repo.repo}/pulls`, payload);
	return formatJson(mutationEnvelope("pr.create", context.repo, "pullRequest", pullRequest));
}

function runPrComment(context: CommandContext): string {
	const prNumber = requirePositiveIntegerIdentifier(context.args, "pull request number");
	const body = requireBody(context.args);
	const comment = postJson(`/repos/${context.repo.owner}/${context.repo.repo}/issues/${prNumber}/comments`, { body });
	return formatJson(mutationEnvelope("pr.comment", context.repo, "comment", comment));
}

function runChecks(context: CommandContext): string {
	const ref = requireSinglePositional(context.args, "commit SHA or ref");
	const endpoint = `/repos/${context.repo.owner}/${context.repo.repo}/commits/${encodeURIComponent(ref)}/check-runs${encodeQuery({
		per_page: context.args.perPage,
		page: context.args.page ?? 1,
	})}`;
	return formatJson(listRestCollection(endpoint, context.args.limit, "check_runs"));
}

function runStatuses(context: CommandContext): string {
	const ref = requireSinglePositional(context.args, "commit SHA or ref");
	const response = runGhApi(`/repos/${context.repo.owner}/${context.repo.repo}/commits/${encodeURIComponent(ref)}/status`);
	return formatJson(parseJsonBody<JsonValue>(response, "an object"));
}

function runCommandPath(args: CliArgs): string {
	const key = commandKey(args.commandPath);
	if (!key || args.help) return usage();
	if (key === "rate-limit") return runRateLimit(args);
	if (GRAPHQL_ONLY_OPERATIONS.has(key)) {
		throw new Error(`${key} is unsupported in this REST-first helper. ${GRAPHQL_ONLY_OPERATIONS.get(key)} This ticket intentionally excludes GraphQL-only operations.`);
	}

	const context: CommandContext = { args, repo: resolveRepo(args) };

	if (key === "repo view") return runRepoView(context);
	if (key === "issue view") return runIssueView(context);
	if (key === "issue list") return runIssueList(context);
	if (key === "issue comments") return runIssueComments(context);
	if (key === "issue create") return runIssueCreate(context);
	if (key === "issue comment") return runIssueComment(context);
	if (key === "pr view") return runPrView(context);
	if (key === "pr list") return runPrList(context);
	if (key === "pr diff") return runPrDiff(context);
	if (key === "pr reviews") return runPrReviews(context);
	if (key === "pr comments") return runPrComments(context);
	if (key === "pr create") return runPrCreate(context);
	if (key === "pr comment") return runPrComment(context);
	if (key === "checks") return runChecks(context);
	if (key === "statuses") return runStatuses(context);
	throw new Error(`Unknown command: ${key}`);
}

export {
	commandKey,
	encodeQuery,
	inferRepoFromGit,
	listRestCollection,
	parseArgs,
	parseGhResponse,
	parseGitHubRemoteUrl,
	parseRepoSpec,
	runCommandPath,
	sanitizeSecretText,
};

function main(): number {
	try {
		const args = parseArgs(process.argv.slice(2));
		process.stdout.write(runCommandPath(args));
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(sanitizeSecretText(message));
		return 1;
	}
}

process.exit(main());
