import { lstat, open, readFile } from "node:fs/promises";
import { relative } from "node:path";
const REVIEW_UNTRACKED_BEGIN_DELIMITER = "--- begin untracked files ---";
const REVIEW_UNTRACKED_END_DELIMITER = "--- end untracked files ---";
export function buildReviewEnvelope(parsed, ctx) {
    const { mode, extra } = parsed;
    const lines = [];
    lines.push("[/review]");
    lines.push(`mode: ${mode}`);
    if (parsed.mode === "branch" && parsed.base) {
        lines.push(`base: ${parsed.base}`);
    }
    else if (parsed.mode === "commit" && parsed.sha) {
        lines.push(`sha: ${parsed.sha}`);
    }
    else if (parsed.mode === "pr" && parsed.nOrUrl) {
        lines.push(`pr: ${parsed.nOrUrl}`);
    }
    else if (parsed.mode === "folder" && parsed.paths.length > 0) {
        lines.push(`paths: ${parsed.paths.join(" ")}`);
    }
    if (ctx?.currentBranch !== undefined) {
        lines.push(`current-branch: ${ctx.currentBranch}`);
    }
    if (ctx?.checkout?.performed) {
        lines.push(`checkout: switched-from ${ctx.checkout.priorBranch}`);
        lines.push(`note: previously on ${ctx.checkout.priorBranch}; run \`git checkout -\` to return.`);
    }
    if (extra === undefined) {
        lines.push("extra: (none)");
    }
    else {
        lines.push("extra:");
        lines.push(extra);
    }
    const hasBody = ctx?.body !== undefined;
    const fenceKind = hasBody ? (ctx?.bodyKind ?? "diff") : "(pending)";
    const bodyText = hasBody
        ? escapeEnvelopeFenceLines(ctx?.body, fenceKind)
        : "(no body gathered)";
    lines.push(`--- begin ${fenceKind} ---`);
    lines.push(bodyText);
    lines.push(`--- end ${fenceKind} ---`);
    return lines.join("\n");
}
export function parseNullDelimitedGitPaths(stdout) {
    return stdout.split("\0").filter((filePath) => filePath.length > 0);
}
function escapeDelimitedContentLine(line) {
    return `\\${line}`;
}
function escapeContentDelimiters(content) {
    return content
        .split("\n")
        .map((line) => {
        if (line === "--- begin snapshot ---" ||
            line === "--- end snapshot ---" ||
            line === REVIEW_UNTRACKED_BEGIN_DELIMITER ||
            line === REVIEW_UNTRACKED_END_DELIMITER ||
            /^--- (?:file|untracked file): .* ---$/.test(line)) {
            return escapeDelimitedContentLine(line);
        }
        return line;
    })
        .join("\n");
}
function escapeEnvelopeFenceLines(body, fenceKind) {
    const beginFence = `--- begin ${fenceKind} ---`;
    const endFence = `--- end ${fenceKind} ---`;
    return body
        .split("\n")
        .map((line) => line === beginFence || line === endFence ? escapeDelimitedContentLine(line) : line)
        .join("\n");
}
function renderDelimitedPath(relPath) {
    return JSON.stringify(relPath)
        .replace(/[\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .replace(/\[/g, "\\u005b")
        .replace(/\]/g, "\\u005d");
}
function getNonRegularSnapshotMarker(relPath, pathStat) {
    const renderedPath = renderDelimitedPath(relPath);
    if (pathStat.isSymbolicLink()) {
        return `[skipped symlink: ${renderedPath}]`;
    }
    if (pathStat.isDirectory()) {
        return `[skipped directory: ${renderedPath}]`;
    }
    if (!pathStat.isFile()) {
        return `[skipped non-regular entry: ${renderedPath}]`;
    }
    return undefined;
}
async function isBinaryFile(filePath) {
    let handle;
    try {
        handle = await open(filePath, "r");
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buf, 0, 8192, 0);
        return buf.subarray(0, bytesRead).includes(0);
    }
    finally {
        await handle?.close();
    }
}
export async function buildSnapshotParts(cwd, filePaths, label) {
    const parts = [];
    for (const filePath of filePaths) {
        const relPath = relative(cwd, filePath);
        const renderedPath = renderDelimitedPath(relPath);
        let pathStat;
        try {
            pathStat = await lstat(filePath);
        }
        catch {
            parts.push(`[skipped lstat failure: ${renderedPath}]`);
            continue;
        }
        const nonRegularMarker = getNonRegularSnapshotMarker(relPath, pathStat);
        if (nonRegularMarker) {
            parts.push(nonRegularMarker);
            continue;
        }
        let bin;
        try {
            bin = await isBinaryFile(filePath);
        }
        catch {
            parts.push(`[skipped binary detection failure: ${renderedPath}]`);
            continue;
        }
        if (bin) {
            parts.push(`[skipped binary: ${renderedPath}]`);
            continue;
        }
        try {
            const content = escapeContentDelimiters(await readFile(filePath, "utf8"));
            parts.push(`--- ${label}: ${renderedPath} ---\n${content}`);
        }
        catch {
            parts.push(`[skipped read failure: ${renderedPath}]`);
        }
    }
    return parts;
}
export function appendUntrackedSnapshot(diffBody, untrackedParts) {
    if (untrackedParts.length === 0) {
        return diffBody;
    }
    const untrackedBody = [
        REVIEW_UNTRACKED_BEGIN_DELIMITER,
        ...untrackedParts,
        REVIEW_UNTRACKED_END_DELIMITER,
    ].join("\n");
    return diffBody.trim().length > 0 ? `${diffBody}\n\n${untrackedBody}` : untrackedBody;
}
