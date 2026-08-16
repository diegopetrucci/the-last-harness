import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
export function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return undefined;
    }
}
export function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export const isRecord = isPlainObject;
export function realpathForCompare(path) {
    const resolved = resolve(path);
    if (existsSync(resolved)) {
        return realpathSync(resolved);
    }
    const parent = dirname(resolved);
    if (parent === resolved) {
        return resolved;
    }
    return join(realpathForCompare(parent), basename(resolved));
}
export function isTruthyEnvFlag(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}
export function isFalseyEnvFlag(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "0" || normalized === "false" || normalized === "no";
}
export function stripTrailingPathSeparators(path) {
    let stripped = path;
    while (stripped.length > sep.length && stripped.endsWith(sep)) {
        stripped = stripped.slice(0, -sep.length);
    }
    return stripped;
}
export function pathWithinOrEqual(root, child) {
    const normalizedRoot = stripTrailingPathSeparators(root);
    const normalizedChild = stripTrailingPathSeparators(child);
    if (normalizedRoot === sep) {
        return normalizedChild.startsWith(sep);
    }
    return (normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`));
}
export function expandHomePath(path) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && path === "~") {
        return home;
    }
    if (home && path.startsWith("~/")) {
        return join(home, path.slice(2));
    }
    return path;
}
export function readMarkdownFilesRecursive(dir) {
    if (!existsSync(dir)) {
        return [];
    }
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        const filePath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...readMarkdownFilesRecursive(filePath));
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) {
            continue;
        }
        if (entry.name.endsWith(".md")) {
            files.push(filePath);
        }
    }
    return files;
}
export function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
export function sanitizeStatusText(text) {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}
export function formatHomePath(path) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && (path === home || path.startsWith(`${home}/`))) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}
export function formatPathFromCwd(cwd, filePath) {
    const absolutePath = resolve(filePath);
    const rel = relative(cwd, absolutePath);
    if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
        return rel;
    }
    const home = process.env.HOME;
    if (home && (absolutePath === home || absolutePath.startsWith(`${home}/`))) {
        return `~${absolutePath.slice(home.length)}`;
    }
    return absolutePath;
}
export function formatCompactTokenCount(count) {
    if (count < 1000) {
        return count.toString();
    }
    if (count < 10000) {
        return `${(count / 1000).toFixed(1)}k`;
    }
    if (count < 1000000) {
        return `${Math.round(count / 1000)}k`;
    }
    if (count < 10000000) {
        return `${(count / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(count / 1000000)}M`;
}
