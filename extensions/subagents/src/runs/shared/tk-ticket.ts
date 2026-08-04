import * as fs from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { TkTicketMetadata } from "../../shared/types.ts";

const TK_SHOW_PATTERN = /\btk\s+show\s+([A-Za-z0-9][A-Za-z0-9-]*)\b/;
const TK_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\))/g;
const UNSAFE_TERMINAL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const MAX_TK_TICKET_TITLE_WIDTH = 72;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface ResolveTkTicketMetadataOptions {
	cwd?: string;
	findTicketFile?: (id: string, cwd?: string) => TkTicketMatch | undefined;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
}

export interface TkTicketTaskContextInput {
	task?: string;
	cwd?: string;
}

export interface TkTicketTaskContext {
	task: string;
	cwd: string;
	taskIndex?: number;
}

interface TkTicketMatch {
	id: string;
	path: string;
}

export function detectTkTicketId(task: string | undefined): string | undefined {
	if (!task) return undefined;
	const match = task.match(TK_SHOW_PATTERN);
	return match?.[1];
}

export function parseTkTicketTitle(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) return trimmed.slice(2).trim() || undefined;
	}
	return undefined;
}

/**
 * Find the one explicitly ticketed task in a run without resolving ticket
 * files. Multiple ticket references are intentionally ambiguous and fail
 * open, matching the async run metadata behavior.
 */
export function resolveTkTicketTaskContext(input: {
	topLevelTask?: string;
	runnerCwd: string;
	tasks?: readonly TkTicketTaskContextInput[];
}): TkTicketTaskContext | undefined {
	const matches: TkTicketTaskContext[] = [];
	if (input.topLevelTask && detectTkTicketId(input.topLevelTask)) {
		matches.push({ task: input.topLevelTask, cwd: input.runnerCwd });
	}
	for (const [taskIndex, task] of (input.tasks ?? []).entries()) {
		if (!task.task || !detectTkTicketId(task.task)) continue;
		matches.push({ task: task.task, cwd: resolveTkTicketTaskCwd(input.runnerCwd, task.cwd), taskIndex });
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function sanitizeTkTicketTitle(raw: string, maxWidth = MAX_TK_TICKET_TITLE_WIDTH): string | undefined {
	const cleaned = raw
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(UNSAFE_TERMINAL_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return truncatePlainTextToWidth(cleaned, maxWidth);
}

export function normalizeTkTicketMetadata(raw: unknown, maxWidth = MAX_TK_TICKET_TITLE_WIDTH): TkTicketMetadata | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { id, title } = raw as Partial<TkTicketMetadata>;
	if (typeof id !== "string" || !TK_TICKET_ID_PATTERN.test(id)) return undefined;
	if (typeof title !== "string") return undefined;
	const sanitizedTitle = sanitizeTkTicketTitle(title, maxWidth);
	if (!sanitizedTitle) return undefined;
	return { id, title: sanitizedTitle };
}

export function resolveTkTicketMetadata(task: string | undefined, options: ResolveTkTicketMetadataOptions = {}): TkTicketMetadata | undefined {
	const requestedId = detectTkTicketId(task);
	if (!requestedId) return undefined;
	try {
		const ticketMatch = (options.findTicketFile ?? findTkTicketFile)(requestedId, options.cwd);
		if (!ticketMatch) return undefined;
		const content = (options.readFileSync ?? fs.readFileSync)(ticketMatch.path, "utf-8");
		return normalizeTkTicketMetadata({ id: ticketMatch.id, title: parseTkTicketTitle(content) ?? "" });
	} catch {
		return undefined;
	}
}

function findTkTicketFile(id: string, cwd?: string): TkTicketMatch | undefined {
	const ticketsDir = findTicketsDir(cwd);
	if (!ticketsDir || !fs.existsSync(ticketsDir) || !fs.statSync(ticketsDir).isDirectory()) return undefined;

	const exactPath = path.join(ticketsDir, `${id}.md`);
	if (fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
		return { id, path: exactPath };
	}

	let matchedFile: string | undefined;
	for (const entry of fs.readdirSync(ticketsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md") || !entry.name.includes(id)) continue;
		if (matchedFile) return undefined;
		matchedFile = entry.name;
	}
	if (!matchedFile) return undefined;
	return { id: matchedFile.slice(0, -3), path: path.join(ticketsDir, matchedFile) };
}

function resolveTkTicketTaskCwd(runnerCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return runnerCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(runnerCwd, childCwd);
}

function findTicketsDir(cwd?: string): string | undefined {
	const configuredDir = process.env.TICKETS_DIR;
	if (configuredDir) return path.resolve(cwd ?? process.cwd(), configuredDir);

	let dir = path.resolve(cwd ?? process.cwd());
	while (true) {
		const candidate = path.join(dir, ".tickets");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function truncatePlainTextToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0 || visibleWidth(text) <= maxWidth) return text;
	const targetWidth = Math.max(1, maxWidth - 1);
	let width = 0;
	let result = "";
	for (const { segment } of segmenter.segment(text)) {
		const nextWidth = visibleWidth(segment);
		if (width + nextWidth > targetWidth) return `${result}…`;
		result += segment;
		width += nextWidth;
	}
	return text;
}
