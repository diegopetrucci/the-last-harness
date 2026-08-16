import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLegacyGlobalAgentsDir, hasCustomPiAgentDir, isGlobalAgentsDir, } from "../shared/profile.js";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.js";
const skillCache = new Map();
const MAX_CACHE_SIZE = 50;
let loadSkillsCache = null;
const LOAD_SKILLS_CACHE_TTL_MS = 5000;
const SUBAGENT_ORCHESTRATION_SKILL = "pi-subagents";
const SOURCE_PRIORITY = {
    project: 700,
    "project-settings": 650,
    "project-package": 600,
    user: 300,
    "user-settings": 250,
    "user-package": 200,
    extension: 150,
    builtin: 100,
    unknown: 0,
};
function stripSkillFrontmatter(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---"))
        return normalized;
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1)
        return normalized;
    return normalized.slice(endIndex + 4).trim();
}
function isWithinPath(filePath, dir) {
    const relative = path.relative(dir, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function readOptionalJsonFile(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read ${label} '${filePath}': ${message}`, {
            cause: error,
        });
    }
}
function readJsonFileBestEffort(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
function extractSkillPathsFromPackageRoot(packageRoot, source, bestEffort = false) {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const pkg = bestEffort
        ? readJsonFileBestEffort(packageJsonPath)
        : readOptionalJsonFile(packageJsonPath, "package manifest");
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
        return [];
    const pi = pkg.pi;
    if (!pi || typeof pi !== "object" || Array.isArray(pi))
        return [];
    const skills = pi.skills;
    if (!Array.isArray(skills))
        return [];
    return skills
        .filter((entry) => typeof entry === "string")
        .map((entry) => ({ path: path.resolve(packageRoot, entry), source }));
}
let cachedGlobalNpmRoot = null;
function getGlobalNpmRoot() {
    if (cachedGlobalNpmRoot !== null)
        return cachedGlobalNpmRoot;
    try {
        cachedGlobalNpmRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
        return cachedGlobalNpmRoot;
    }
    catch {
        cachedGlobalNpmRoot = "";
        return null;
    }
}
function collectInstalledPackageSkillPaths(cwd, agentDir) {
    const projectConfigDir = getProjectConfigDir(cwd);
    const dirs = [
        { path: path.join(projectConfigDir, "npm", "node_modules"), source: "project-package" },
        { path: path.join(agentDir, "npm", "node_modules"), source: "user-package" },
    ];
    const globalRoot = getGlobalNpmRoot();
    if (globalRoot) {
        dirs.push({ path: globalRoot, source: "user-package" });
    }
    const results = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir.path))
            continue;
        let entries;
        try {
            entries = fs.readdirSync(dir.path, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith("."))
                continue;
            if (!entry.isDirectory() && !entry.isSymbolicLink())
                continue;
            if (entry.name.startsWith("@")) {
                const scopeDir = path.join(dir.path, entry.name);
                let scopeEntries;
                try {
                    scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
                }
                catch {
                    continue;
                }
                for (const scopeEntry of scopeEntries) {
                    if (scopeEntry.name.startsWith("."))
                        continue;
                    if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink())
                        continue;
                    const pkgRoot = path.join(scopeDir, scopeEntry.name);
                    results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
                }
                continue;
            }
            const pkgRoot = path.join(dir.path, entry.name);
            results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
        }
    }
    return results;
}
function collectSettingsSkillPaths(cwd, agentDir) {
    const results = [];
    const projectConfigDir = getProjectConfigDir(cwd);
    const settingsFiles = [
        {
            file: path.join(projectConfigDir, "settings.json"),
            base: projectConfigDir,
            source: "project-settings",
        },
        {
            file: path.join(agentDir, "settings.json"),
            base: agentDir,
            source: "user-settings",
        },
    ];
    for (const { file, base, source } of settingsFiles) {
        const settings = readOptionalJsonFile(file, "skills settings file");
        if (!settings || typeof settings !== "object" || Array.isArray(settings))
            continue;
        const skills = settings.skills;
        if (!Array.isArray(skills))
            continue;
        for (const entry of skills) {
            if (typeof entry !== "string")
                continue;
            let resolved = entry;
            if (resolved.startsWith("~/")) {
                resolved = path.join(os.homedir(), resolved.slice(2));
            }
            else if (!path.isAbsolute(resolved)) {
                resolved = path.resolve(base, resolved);
            }
            results.push({ path: resolved, source });
        }
    }
    return results;
}
function isSafePackagePath(value) {
    return (value.length > 0 &&
        !path.isAbsolute(value) &&
        value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== ".."));
}
function parseNpmPackageName(source) {
    const spec = source.slice(4).trim();
    if (!spec)
        return undefined;
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    const packageName = match?.[1] ?? spec;
    return isSafePackagePath(packageName) ? packageName : undefined;
}
function stripGitRef(repoPath) {
    const atIndex = repoPath.indexOf("@");
    const hashIndex = repoPath.indexOf("#");
    const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}
function parseGitPackagePath(source) {
    const spec = source.slice(4).trim();
    if (!spec)
        return undefined;
    let host;
    let repoPath;
    const scpLike = spec.match(/^git@([^:]+):(.+)$/);
    if (scpLike) {
        host = scpLike[1] ?? "";
        repoPath = scpLike[2] ?? "";
    }
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
        try {
            const url = new URL(spec);
            host = url.hostname;
            repoPath = url.pathname.replace(/^\/+/, "");
        }
        catch {
            return undefined;
        }
    }
    else {
        const slashIndex = spec.indexOf("/");
        if (slashIndex < 0)
            return undefined;
        host = spec.slice(0, slashIndex);
        repoPath = spec.slice(slashIndex + 1);
    }
    const normalizedPath = stripGitRef(repoPath)
        .replace(/\.git$/, "")
        .replace(/^\/+/, "");
    if (!host ||
        !isSafePackagePath(host) ||
        !isSafePackagePath(normalizedPath) ||
        normalizedPath.split(/[\\/]/).length < 2) {
        return undefined;
    }
    return { host, repoPath: normalizedPath };
}
function resolveSettingsPackageRoot(source, baseDir) {
    const trimmed = source.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.startsWith("git:")) {
        const parsed = parseGitPackagePath(trimmed);
        return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
    }
    if (trimmed.startsWith("npm:")) {
        const packageName = parseNpmPackageName(trimmed);
        return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
    }
    const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
    if (normalized === "~")
        return os.homedir();
    if (normalized.startsWith("~/"))
        return path.join(os.homedir(), normalized.slice(2));
    if (path.isAbsolute(normalized))
        return normalized;
    if (normalized === "." ||
        normalized === ".." ||
        normalized.startsWith("./") ||
        normalized.startsWith("../")) {
        return path.resolve(baseDir, normalized);
    }
    return undefined;
}
function collectSettingsPackageSkillPaths(cwd, agentDir) {
    const projectConfigDir = getProjectConfigDir(cwd);
    const settingsFiles = [
        {
            file: path.join(projectConfigDir, "settings.json"),
            base: projectConfigDir,
            source: "project-package",
        },
        { file: path.join(agentDir, "settings.json"), base: agentDir, source: "user-package" },
    ];
    const results = [];
    for (const { file, base, source } of settingsFiles) {
        const settings = readOptionalJsonFile(file, "skills settings file");
        if (!settings || typeof settings !== "object" || Array.isArray(settings))
            continue;
        const packages = settings.packages;
        if (!Array.isArray(packages))
            continue;
        for (const entry of packages) {
            const packageSource = typeof entry === "string"
                ? entry
                : typeof entry === "object" &&
                    entry !== null &&
                    typeof entry.source === "string"
                    ? entry.source
                    : undefined;
            if (!packageSource)
                continue;
            const packageRoot = resolveSettingsPackageRoot(packageSource, base);
            if (!packageRoot)
                continue;
            results.push(...extractSkillPathsFromPackageRoot(packageRoot, source));
        }
    }
    return results;
}
function buildSkillPaths(cwd, agentDir) {
    const projectConfigDir = getProjectConfigDir(cwd);
    const legacyGlobalAgentsDir = getLegacyGlobalAgentsDir();
    const projectLegacyAgentsDir = path.join(cwd, ".agents");
    const skillPaths = [
        { path: path.join(projectConfigDir, "skills"), source: "project" },
        ...(hasCustomPiAgentDir() && isGlobalAgentsDir(projectLegacyAgentsDir)
            ? []
            : [{ path: path.join(projectLegacyAgentsDir, "skills"), source: "project" }]),
        { path: path.join(agentDir, "skills"), source: "user" },
        ...(legacyGlobalAgentsDir
            ? [{ path: path.join(legacyGlobalAgentsDir, "skills"), source: "user" }]
            : []),
        ...collectInstalledPackageSkillPaths(cwd, agentDir),
        ...collectSettingsPackageSkillPaths(cwd, agentDir),
        ...extractSkillPathsFromPackageRoot(cwd, "project-package"),
        ...collectSettingsSkillPaths(cwd, agentDir),
    ];
    const deduped = new Map();
    for (const entry of skillPaths) {
        const resolvedPath = path.resolve(entry.path);
        const existing = deduped.get(resolvedPath);
        if (!existing ||
            (SOURCE_PRIORITY[entry.source] ?? 0) > (SOURCE_PRIORITY[existing.source] ?? 0)) {
            deduped.set(resolvedPath, { path: resolvedPath, source: entry.source });
        }
    }
    return [...deduped.values()];
}
function inferSkillSource(filePath, cwd, agentDir, sourceHint) {
    if (sourceHint)
        return sourceHint;
    const projectConfigRoot = path.resolve(getProjectConfigDir(cwd));
    const projectSkillsRoot = path.resolve(projectConfigRoot, "skills");
    const projectPackagesRoot = path.resolve(projectConfigRoot, "npm", "node_modules");
    const rawProjectAgentsRoot = path.resolve(cwd, ".agents");
    const projectAgentsRoot = hasCustomPiAgentDir() && isGlobalAgentsDir(rawProjectAgentsRoot)
        ? undefined
        : rawProjectAgentsRoot;
    const userSkillsRoot = path.resolve(agentDir, "skills");
    const userPackagesRoot = path.resolve(agentDir, "npm", "node_modules");
    const userAgentRoot = path.resolve(agentDir);
    const legacyGlobalAgentsDir = getLegacyGlobalAgentsDir();
    const userAgentsRoot = legacyGlobalAgentsDir ? path.resolve(legacyGlobalAgentsDir) : undefined;
    if (isWithinPath(filePath, projectPackagesRoot))
        return "project-package";
    if (isWithinPath(filePath, projectSkillsRoot) ||
        (projectAgentsRoot && isWithinPath(filePath, projectAgentsRoot)))
        return "project";
    if (isWithinPath(filePath, projectConfigRoot))
        return "project-settings";
    if (isWithinPath(filePath, userPackagesRoot))
        return "user-package";
    if (isWithinPath(filePath, userSkillsRoot) ||
        (userAgentsRoot && isWithinPath(filePath, userAgentsRoot)))
        return "user";
    if (isWithinPath(filePath, userAgentRoot))
        return "user-settings";
    const globalRoot = getGlobalNpmRoot();
    if (globalRoot && isWithinPath(filePath, globalRoot))
        return "user-package";
    return "unknown";
}
function chooseHigherPrioritySkill(existing, candidate) {
    if (!existing)
        return candidate;
    const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
    const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 0;
    if (candidatePriority > existingPriority)
        return candidate;
    if (candidatePriority < existingPriority)
        return existing;
    return candidate.order < existing.order ? candidate : existing;
}
function maybeReadSkillDescription(filePath) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const normalized = content.replace(/\r\n/g, "\n");
        if (!normalized.startsWith("---"))
            return undefined;
        const endIndex = normalized.indexOf("\n---", 3);
        if (endIndex === -1)
            return undefined;
        const frontmatter = normalized.slice(3, endIndex).trim();
        const match = frontmatter.match(/^description:\s*(.+)$/m);
        if (!match)
            return undefined;
        return match[1]?.trim().replace(/^['"]|['"]$/g, "");
    }
    catch {
        return undefined;
    }
}
function collectFilesystemSkills(cwd, agentDir, skillPaths) {
    const entries = [];
    const seen = new Map();
    const visitedDirectories = new Map();
    let order = 0;
    const pushEntry = (name, filePath, sourceHint) => {
        const resolvedFile = path.resolve(filePath);
        if (!fs.existsSync(resolvedFile))
            return;
        const source = inferSkillSource(resolvedFile, cwd, agentDir, sourceHint);
        const existingIndex = seen.get(resolvedFile);
        if (existingIndex !== undefined) {
            const existing = entries[existingIndex];
            if (existing && (SOURCE_PRIORITY[source] ?? 0) > (SOURCE_PRIORITY[existing.source] ?? 0)) {
                entries[existingIndex] = {
                    ...existing,
                    name,
                    source,
                    description: maybeReadSkillDescription(resolvedFile),
                };
            }
            return;
        }
        seen.set(resolvedFile, entries.length);
        entries.push({
            name,
            filePath: resolvedFile,
            source,
            description: maybeReadSkillDescription(resolvedFile),
            order: order++,
        });
    };
    const shouldSkipDirectory = (name) => name.startsWith(".") || name === "node_modules";
    const markDirectoryVisited = (dirPath, sourceHint) => {
        let resolvedDir;
        try {
            resolvedDir = fs.realpathSync(dirPath);
        }
        catch {
            resolvedDir = path.resolve(dirPath);
        }
        const priority = sourceHint ? (SOURCE_PRIORITY[sourceHint] ?? 0) : SOURCE_PRIORITY.unknown;
        const previousPriority = visitedDirectories.get(resolvedDir);
        if (previousPriority !== undefined && previousPriority >= priority)
            return false;
        visitedDirectories.set(resolvedDir, priority);
        return true;
    };
    const walkSkillDirectories = (dirPath, sourceHint) => {
        if (!markDirectoryVisited(dirPath, sourceHint))
            return;
        const skillFile = path.join(dirPath, "SKILL.md");
        if (fs.existsSync(skillFile)) {
            pushEntry(path.basename(dirPath), skillFile, sourceHint);
            return;
        }
        let entriesInDir;
        try {
            entriesInDir = fs.readdirSync(dirPath, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entriesInDir) {
            if (shouldSkipDirectory(entry.name))
                continue;
            if (!entry.isDirectory() && !entry.isSymbolicLink())
                continue;
            const entryPath = path.join(dirPath, entry.name);
            let stat;
            try {
                stat = fs.statSync(entryPath);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                walkSkillDirectories(entryPath, sourceHint);
            }
        }
    };
    for (const skillPath of skillPaths) {
        if (!fs.existsSync(skillPath.path))
            continue;
        let stat;
        try {
            stat = fs.statSync(skillPath.path);
        }
        catch {
            continue;
        }
        if (stat.isFile()) {
            const fileName = path.basename(skillPath.path);
            if (!fileName.toLowerCase().endsWith(".md"))
                continue;
            const skillName = fileName.toLowerCase() === "skill.md"
                ? path.basename(path.dirname(skillPath.path))
                : path.basename(fileName, path.extname(fileName));
            pushEntry(skillName, skillPath.path, skillPath.source);
            continue;
        }
        if (!stat.isDirectory())
            continue;
        const rootSkillFile = path.join(skillPath.path, "SKILL.md");
        if (fs.existsSync(rootSkillFile)) {
            pushEntry(path.basename(skillPath.path), rootSkillFile, skillPath.source);
            continue;
        }
        markDirectoryVisited(skillPath.path, skillPath.source);
        let childEntries;
        try {
            childEntries = fs.readdirSync(skillPath.path, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const child of childEntries) {
            if (child.name.startsWith("."))
                continue;
            const childPath = path.join(skillPath.path, child.name);
            if (child.isDirectory() || child.isSymbolicLink()) {
                if (shouldSkipDirectory(child.name))
                    continue;
                let childStat;
                try {
                    childStat = fs.statSync(childPath);
                }
                catch {
                    continue;
                }
                if (childStat.isDirectory())
                    walkSkillDirectories(childPath, skillPath.source);
                continue;
            }
            if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
                pushEntry(path.basename(child.name, path.extname(child.name)), childPath, skillPath.source);
            }
        }
    }
    return entries;
}
function getCachedSkills(cwd) {
    const now = Date.now();
    const agentDir = getAgentDir();
    if (loadSkillsCache &&
        loadSkillsCache.cwd === cwd &&
        loadSkillsCache.agentDir === agentDir &&
        now - loadSkillsCache.timestamp < LOAD_SKILLS_CACHE_TTL_MS) {
        return loadSkillsCache.skills;
    }
    const skillPaths = buildSkillPaths(cwd, agentDir);
    const loaded = collectFilesystemSkills(cwd, agentDir, skillPaths);
    const dedupedByName = new Map();
    for (const entry of loaded) {
        const current = dedupedByName.get(entry.name);
        dedupedByName.set(entry.name, chooseHigherPrioritySkill(current, entry));
    }
    const skills = [...dedupedByName.values()].sort((a, b) => a.order - b.order);
    loadSkillsCache = { cwd, agentDir, skills, timestamp: now };
    return skills;
}
export function resolveSkillPath(skillName, cwd) {
    const skills = getCachedSkills(cwd);
    const skill = skills.find((s) => s.name === skillName);
    if (!skill)
        return undefined;
    return { path: skill.filePath, source: skill.source };
}
function readSkill(skillName, skillPath, source) {
    try {
        const stat = fs.statSync(skillPath);
        const cached = skillCache.get(skillPath);
        if (cached && cached.mtime === stat.mtimeMs) {
            return cached.skill;
        }
        const raw = fs.readFileSync(skillPath, "utf-8");
        const content = stripSkillFrontmatter(raw);
        const description = maybeReadSkillDescription(skillPath);
        const skill = {
            name: skillName,
            path: skillPath,
            content,
            description,
            source,
        };
        skillCache.set(skillPath, { mtime: stat.mtimeMs, skill });
        if (skillCache.size > MAX_CACHE_SIZE) {
            const firstKey = skillCache.keys().next().value;
            if (firstKey)
                skillCache.delete(firstKey);
        }
        return skill;
    }
    catch {
        return undefined;
    }
}
export function resolveSkills(skillNames, cwd) {
    const resolved = [];
    const missing = [];
    for (const name of skillNames) {
        const trimmed = name.trim();
        if (!trimmed)
            continue;
        if (trimmed === SUBAGENT_ORCHESTRATION_SKILL) {
            missing.push(trimmed);
            continue;
        }
        const location = resolveSkillPath(trimmed, cwd);
        if (!location) {
            missing.push(trimmed);
            continue;
        }
        const skill = readSkill(trimmed, location.path, location.source);
        if (skill) {
            resolved.push(skill);
        }
        else {
            missing.push(trimmed);
        }
    }
    return { resolved, missing };
}
export function resolveSkillsWithFallback(skillNames, primaryCwd, fallbackCwd) {
    const primary = resolveSkills(skillNames, primaryCwd);
    if (!fallbackCwd || primary.missing.length === 0)
        return primary;
    if (path.resolve(primaryCwd) === path.resolve(fallbackCwd))
        return primary;
    const fallback = resolveSkills(primary.missing, fallbackCwd);
    return {
        resolved: [...primary.resolved, ...fallback.resolved],
        missing: fallback.missing,
    };
}
export function buildSkillInjection(skills) {
    if (skills.length === 0)
        return "";
    const lines = [
        "The following configured skills are available to this subagent.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ];
    for (const skill of skills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXmlText(skill.name)}</name>`);
        lines.push(`    <description>${escapeXmlText(skill.description ?? "")}</description>`);
        lines.push(`    <location>${escapeXmlText(skill.path)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
function escapeXmlText(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function normalizeSkillInput(input) {
    if (input === false)
        return false;
    if (input === true || input === undefined)
        return undefined;
    if (Array.isArray(input)) {
        return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
    }
    const trimmed = input.trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return normalizeSkillInput(parsed);
            }
        }
        catch {
        }
    }
    return [
        ...new Set(input
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)),
    ];
}
export function discoverAvailableSkills(cwd) {
    const skills = getCachedSkills(cwd);
    return (skills
        .filter((s) => s.name !== SUBAGENT_ORCHESTRATION_SKILL)
        .map((s) => ({
        name: s.name,
        source: s.source,
        description: s.description,
    }))
        .sort((a, b) => a.name.localeCompare(b.name)));
}
export function clearSkillCache() {
    skillCache.clear();
    loadSkillsCache = null;
}
