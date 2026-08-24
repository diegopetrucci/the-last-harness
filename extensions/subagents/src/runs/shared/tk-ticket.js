import * as fs from "node:fs";
import * as path from "node:path";
const TK_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
export const BUNDLED_DEVELOPER_AGENT_NAME = "developer";
export function resolveDispatchTkTicketMetadata(agent, ticket, options = {}) {
    const requiresTkTicket = agent.name === BUNDLED_DEVELOPER_AGENT_NAME && agent.tkTicketRequired === true;
    if (!requiresTkTicket) {
        return ticket === undefined
            ? {}
            : { error: "Explicit ticket fields are only supported for the marked TLH developer agent." };
    }
    if (ticket === undefined) {
        return { error: "The TLH developer agent requires an explicit ticket ID." };
    }
    return resolveExplicitTkTicketMetadata(ticket, options);
}
export function parseTkTicketTitle(output) {
    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# "))
            return trimmed.slice(2).trim() || undefined;
    }
    return undefined;
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
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const id = "id" in raw ? raw.id : undefined;
    const title = "title" in raw ? raw.title : undefined;
    if (typeof id !== "string" || !TK_TICKET_ID_PATTERN.test(id))
        return undefined;
    if (typeof title !== "string")
        return undefined;
    const sanitizedTitle = sanitizeTkTicketTitle(title);
    if (!sanitizedTitle)
        return undefined;
    return { id, title: sanitizedTitle };
}
export function resolveExplicitTkTicketMetadata(ticket, options = {}) {
    if (typeof ticket !== "string" || ticket.trim().length === 0) {
        return { error: "ticket must be a non-empty ticket ID." };
    }
    const requestedId = ticket.trim();
    if (!TK_TICKET_ID_PATTERN.test(requestedId)) {
        return { error: "ticket must contain only letters, numbers, and hyphens." };
    }
    try {
        const ticketMatch = (options.findTicketFile ?? findTkTicketFile)(requestedId, options.cwd);
        if (!ticketMatch) {
            return {
                error: `ticket '${requestedId}' was not found from '${options.cwd ?? process.cwd()}'. Check TICKETS_DIR and the task cwd.`,
            };
        }
        const content = (options.readFileSync ?? fs.readFileSync)(ticketMatch.path, "utf-8");
        const metadata = normalizeTkTicketMetadata({
            id: ticketMatch.id,
            title: parseTkTicketTitle(content) ?? "",
        });
        if (!metadata)
            return { error: `ticket '${requestedId}' has no readable title.` };
        return { metadata };
    }
    catch {
        return {
            error: `ticket '${requestedId}' could not be resolved. Check TICKETS_DIR and the ticket file.`,
        };
    }
}
function findTkTicketFile(id, cwd) {
    const ticketsDir = findTicketsDir(cwd);
    if (!ticketsDir || !fs.existsSync(ticketsDir) || !fs.statSync(ticketsDir).isDirectory()) {
        return undefined;
    }
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
