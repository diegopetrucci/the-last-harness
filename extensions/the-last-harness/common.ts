import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const isRecord: (value: unknown) => value is Record<string, unknown> = isPlainObject;

export function realpathForCompare(path: string): string {
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

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isFalseyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

function stripTrailingPathSeparators(path: string): string {
  let stripped = path;
  while (stripped.length > sep.length && stripped.endsWith(sep)) {
    stripped = stripped.slice(0, -sep.length);
  }
  return stripped;
}

export function pathWithinOrEqual(root: string, child: string): boolean {
  const normalizedRoot = stripTrailingPathSeparators(root);
  const normalizedChild = stripTrailingPathSeparators(child);
  if (normalizedRoot === sep) {
    return normalizedChild.startsWith(sep);
  }
  return (
    normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`)
  );
}

export function expandHomePath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && path === "~") {
    return home;
  }
  if (home && path.startsWith("~/")) {
    return join(home, path.slice(2));
  }
  return path;
}

export function readMarkdownFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }

  const files: string[] = [];
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

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatHomePath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function formatPathFromCwd(cwd: string, filePath: string): string {
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

export function formatCompactTokenCount(count: number): string {
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
