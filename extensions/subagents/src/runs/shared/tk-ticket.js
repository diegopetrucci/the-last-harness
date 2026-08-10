import * as fs from "node:fs";
import * as path from "node:path";
const TK_SHOW_PATTERN = /\btk\s+show\s+([A-Za-z0-9][A-Za-z0-9-]*)\b/;
const TK_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
export function detectTkTicketId(task) {
    if (!task)
        return undefined;
    const match = task.match(TK_SHOW_PATTERN);
    return match?.[1];
}
export function parseTkTicketTitle(output) {
    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# "))
            return trimmed.slice(2).trim() || undefined;
    }
    return undefined;
}
export function resolveTkTicketTaskContext(input) {
    const matches = [];
    if (input.topLevelTask && detectTkTicketId(input.topLevelTask)) {
        matches.push({ task: input.topLevelTask, cwd: input.runnerCwd });
    }
    for (const [taskIndex, task] of (input.tasks ?? []).entries()) {
        if (!task.task || !detectTkTicketId(task.task))
            continue;
        matches.push({ task: task.task, cwd: resolveTkTicketTaskCwd(input.runnerCwd, task.cwd), taskIndex });
    }
    return matches.length === 1 ? matches[0] : undefined;
}
function sanitizeTerminalText(raw) {
    let cleaned = "";
    for (let index = 0; index < raw.length; index++) {
        const code = raw.charCodeAt(index);
        if (code === 0x1b) {
            const next = raw.charCodeAt(++index);
            if (next === 0x5b) {
                while (++index < raw.length) {
                    const finalCode = raw.charCodeAt(index);
                    if (finalCode >= 0x40 && finalCode <= 0x7e)
                        break;
                }
            }
            else if (next === 0x5d) {
                while (++index < raw.length) {
                    const sequenceCode = raw.charCodeAt(index);
                    if (sequenceCode === 0x07)
                        break;
                    if (sequenceCode === 0x1b && raw.charCodeAt(index + 1) === 0x5c) {
                        index++;
                        break;
                    }
                }
            }
            continue;
        }
        if (code <= 0x08 ||
            code === 0x0b ||
            code === 0x0c ||
            (code >= 0x0e && code <= 0x1f) ||
            (code >= 0x7f && code <= 0x9f)) {
            cleaned += " ";
            continue;
        }
        cleaned += raw[index];
    }
    return cleaned;
}
export function sanitizeTkTicketTitle(raw) {
    const cleaned = sanitizeTerminalText(raw).replace(/\s+/g, " ").trim();
    return cleaned || undefined;
}
export function normalizeTkTicketMetadata(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const { id, title } = raw;
    if (typeof id !== "string" || !TK_TICKET_ID_PATTERN.test(id))
        return undefined;
    if (typeof title !== "string")
        return undefined;
    const sanitizedTitle = sanitizeTkTicketTitle(title);
    if (!sanitizedTitle)
        return undefined;
    return { id, title: sanitizedTitle };
}
export function resolveTkTicketMetadata(task, options = {}) {
    const requestedId = detectTkTicketId(task);
    if (!requestedId)
        return undefined;
    try {
        const ticketMatch = (options.findTicketFile ?? findTkTicketFile)(requestedId, options.cwd);
        if (!ticketMatch)
            return undefined;
        const content = (options.readFileSync ?? fs.readFileSync)(ticketMatch.path, "utf-8");
        return normalizeTkTicketMetadata({ id: ticketMatch.id, title: parseTkTicketTitle(content) ?? "" });
    }
    catch {
        return undefined;
    }
}
function findTkTicketFile(id, cwd) {
    const ticketsDir = findTicketsDir(cwd);
    if (!ticketsDir || !fs.existsSync(ticketsDir) || !fs.statSync(ticketsDir).isDirectory())
        return undefined;
    const exactPath = path.join(ticketsDir, `${id}.md`);
    if (fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
        return { id, path: exactPath };
    }
    let matchedFile;
    for (const entry of fs.readdirSync(ticketsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md") || !entry.name.includes(id))
            continue;
        if (matchedFile)
            return undefined;
        matchedFile = entry.name;
    }
    if (!matchedFile)
        return undefined;
    return { id: matchedFile.slice(0, -3), path: path.join(ticketsDir, matchedFile) };
}
function resolveTkTicketTaskCwd(runnerCwd, childCwd) {
    if (!childCwd)
        return runnerCwd;
    return path.isAbsolute(childCwd) ? childCwd : path.resolve(runnerCwd, childCwd);
}
function findTicketsDir(cwd) {
    const configuredDir = process.env.TICKETS_DIR;
    if (configuredDir)
        return path.resolve(cwd ?? process.cwd(), configuredDir);
    let dir = path.resolve(cwd ?? process.cwd());
    while (true) {
        const candidate = path.join(dir, ".tickets");
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
