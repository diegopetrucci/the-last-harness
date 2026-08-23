import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandTildePath, getLegacyGlobalAgentsDir, isGlobalAgentsDir } from "../shared/profile.js";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.js";
import { KNOWN_FIELDS } from "./agent-serializer.js";
import { mergeAgentsForScope } from "./agent-selection.js";
import { parseFrontmatter } from "./frontmatter.js";
import { buildRuntimeName, parsePackageName } from "./identity.js";
import { parseModelScopeConfig } from "../runs/shared/model-scope.js";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.js";
import { isPositiveSafeInteger } from "./execution-ceiling.js";
export function defaultSystemPromptMode(name) {
    return name === "delegate" ? "append" : "replace";
}
export function defaultInheritProjectContext(name) {
    return name === "delegate";
}
export function defaultInheritSkills() {
    return false;
}
const EMPTY_SUBAGENT_SETTINGS = { overrides: {} };
const agentFrontmatterFields = new WeakMap();
function getUserChainDir() {
    return path.join(getAgentDir(), "chains");
}
let cachedGlobalNpmRoot = null;
function readJsonFileBestEffort(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
function readOptionalJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT")
            return null;
        throw error;
    }
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
    if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
        return path.resolve(baseDir, normalized);
    }
    return undefined;
}
function getGlobalNpmRoot() {
    if (cachedGlobalNpmRoot !== null)
        return cachedGlobalNpmRoot;
    try {
        cachedGlobalNpmRoot = fs.realpathSync(execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim());
        return cachedGlobalNpmRoot;
    }
    catch {
        cachedGlobalNpmRoot = "";
        return null;
    }
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function getPackageSubagentConfigRoots(packageRoot) {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const pkg = readJsonFileBestEffort(packageJsonPath);
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
        return [];
    const roots = [];
    const piSubagents = pkg["pi-subagents"];
    if (piSubagents && typeof piSubagents === "object" && !Array.isArray(piSubagents)) {
        roots.push(piSubagents);
    }
    const pi = pkg.pi;
    if (pi && typeof pi === "object" && !Array.isArray(pi)) {
        const subagents = pi.subagents;
        if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) {
            roots.push(subagents);
        }
    }
    return roots;
}
function hasPackageSubagentConfig(packageRoot) {
    return getPackageSubagentConfigRoots(packageRoot).some((root) => stringArray(root.agents).length > 0);
}
function extractSubagentPathsFromPackageRoot(packageRoot) {
    const roots = getPackageSubagentConfigRoots(packageRoot);
    const agents = [];
    for (const root of roots) {
        for (const entry of stringArray(root.agents))
            agents.push(path.resolve(packageRoot, entry));
    }
    return { agents };
}
function collectPackageRootsFromNodeModules(nodeModulesDir) {
    const roots = [];
    if (!fs.existsSync(nodeModulesDir))
        return roots;
    let entries;
    try {
        entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
    }
    catch {
        return roots;
    }
    for (const entry of entries) {
        if (entry.name.startsWith("."))
            continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        if (entry.name.startsWith("@")) {
            const scopeDir = path.join(nodeModulesDir, entry.name);
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
                roots.push(path.join(scopeDir, scopeEntry.name));
            }
            continue;
        }
        roots.push(path.join(nodeModulesDir, entry.name));
    }
    return roots;
}
function collectSettingsPackageRoots(settingsFile, baseDir) {
    const settings = readOptionalJsonFile(settingsFile);
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
        return [];
    const packages = settings.packages;
    if (!Array.isArray(packages))
        return [];
    const roots = [];
    for (const entry of packages) {
        const packageSource = typeof entry === "string"
            ? entry
            : typeof entry === "object" && entry !== null && typeof entry.source === "string"
                ? entry.source
                : undefined;
        if (!packageSource)
            continue;
        const packageRoot = resolveSettingsPackageRoot(packageSource, baseDir);
        if (packageRoot)
            roots.push(packageRoot);
    }
    return roots;
}
function findNearestPackageSubagentRoot(cwd) {
    let currentDir = cwd;
    while (true) {
        if (hasPackageSubagentConfig(currentDir))
            return currentDir;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            return null;
        currentDir = parentDir;
    }
}
function collectPackageSubagentPaths(cwd, options = { includeUser: true, includeProject: true }) {
    const agentDir = getAgentDir();
    const projectRoot = findNearestProjectRoot(cwd) ?? findNearestPackageSubagentRoot(cwd) ?? cwd;
    const packageRoots = [projectRoot];
    if (options.includeProject) {
        const projectConfigDir = getProjectConfigDir(projectRoot);
        packageRoots.push(...collectPackageRootsFromNodeModules(path.join(projectConfigDir, "npm", "node_modules")), ...collectSettingsPackageRoots(path.join(projectConfigDir, "settings.json"), projectConfigDir));
    }
    if (options.includeUser) {
        packageRoots.push(...collectPackageRootsFromNodeModules(path.join(agentDir, "npm", "node_modules")), ...collectSettingsPackageRoots(path.join(agentDir, "settings.json"), agentDir));
    }
    if (options.includeUser) {
        const globalRoot = getGlobalNpmRoot();
        if (globalRoot)
            packageRoots.push(...collectPackageRootsFromNodeModules(globalRoot));
    }
    const seenRoots = new Set();
    const seenAgents = new Set();
    const agents = [];
    for (const packageRoot of packageRoots) {
        const resolvedRoot = path.resolve(packageRoot);
        if (seenRoots.has(resolvedRoot))
            continue;
        seenRoots.add(resolvedRoot);
        const paths = extractSubagentPathsFromPackageRoot(resolvedRoot);
        for (const agentDir of paths.agents) {
            if (seenAgents.has(agentDir))
                continue;
            seenAgents.add(agentDir);
            agents.push(agentDir);
        }
    }
    return { agents };
}
function splitToolList(rawTools) {
    const tools = (rawTools ?? []).filter((tool) => !tool.startsWith("mcp:"));
    return tools.length > 0 ? { tools } : {};
}
function joinToolList(config) {
    return config.tools && config.tools.length > 0 ? [...config.tools] : undefined;
}
function arraysEqual(a, b) {
    if (!a && !b)
        return true;
    if (!a || !b)
        return false;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
function parsePositiveIntegerFrontmatter(value, field, label) {
    if (value === undefined || !value.trim())
        return undefined;
    const parsed = Number(value);
    if (!isPositiveSafeInteger(parsed)) {
        throw new Error(`${label} has invalid ${field} frontmatter; expected a positive safe integer.`);
    }
    return parsed;
}
function parseBooleanFrontmatter(value, field, label) {
    if (value === undefined || !value.trim())
        return undefined;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new Error(`${label} has invalid ${field} frontmatter; expected 'true' or 'false'.`);
}
function cloneOverrideBase(agent) {
    return {
        model: agent.model,
        fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
        thinking: agent.thinking,
        systemPromptMode: agent.systemPromptMode,
        inheritProjectContext: agent.inheritProjectContext,
        inheritSkills: agent.inheritSkills,
        defaultContext: agent.defaultContext,
        acceptanceRole: agent.acceptanceRole,
        disabled: agent.disabled,
        systemPrompt: agent.systemPrompt,
        skills: agent.skills ? [...agent.skills] : undefined,
        tools: agent.tools ? [...agent.tools] : undefined,
        subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
        completionGuard: agent.completionGuard,
        toolBudget: agent.toolBudget,
        maxExecutionTimeMs: agent.maxExecutionTimeMs,
    };
}
function cloneOverrideValue(override) {
    return {
        ...(override.model !== undefined ? { model: override.model } : {}),
        ...(override.fallbackModels !== undefined
            ? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
            : {}),
        ...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
        ...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
        ...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
        ...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
        ...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
        ...(override.acceptanceRole !== undefined ? { acceptanceRole: override.acceptanceRole } : {}),
        ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
        ...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
        ...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
        ...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
        ...(override.subagentOnlyExtensions !== undefined
            ? {
                subagentOnlyExtensions: override.subagentOnlyExtensions === false ? false : [...override.subagentOnlyExtensions],
            }
            : {}),
        ...(override.completionGuard !== undefined ? { completionGuard: override.completionGuard } : {}),
        ...(override.toolBudget !== undefined
            ? {
                toolBudget: override.toolBudget === false
                    ? false
                    : {
                        ...override.toolBudget,
                        ...(Array.isArray(override.toolBudget.block) ? { block: [...override.toolBudget.block] } : {}),
                    },
            }
            : {}),
        ...(override.maxExecutionTimeMs !== undefined ? { maxExecutionTimeMs: override.maxExecutionTimeMs } : {}),
    };
}
export function findNearestProjectRoot(cwd) {
    const ignoredProjectConfigDirs = new Set([
        path.resolve(path.dirname(getAgentDir())),
        path.resolve(getProjectConfigDir(os.homedir())),
    ]);
    let currentDir = cwd;
    while (true) {
        const legacyProjectDir = path.join(currentDir, ".agents");
        const hasLegacyProjectDir = isDirectory(legacyProjectDir) && !isGlobalAgentsDir(legacyProjectDir);
        const projectConfigDir = getProjectConfigDir(currentDir);
        const hasProjectConfigDir = isDirectory(projectConfigDir) && !ignoredProjectConfigDirs.has(path.resolve(projectConfigDir));
        if (hasProjectConfigDir || hasLegacyProjectDir) {
            return currentDir;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            return null;
        currentDir = parentDir;
    }
}
function getUserAgentSettingsPath() {
    return path.join(getAgentDir(), "settings.json");
}
function getProjectAgentSettingsPath(cwd) {
    const projectRoot = findNearestProjectRoot(cwd);
    return projectRoot ? path.join(getProjectConfigDir(projectRoot), "settings.json") : null;
}
function readSettingsFileStrict(filePath) {
    if (!fs.existsSync(filePath))
        return {};
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
    }
    return parsed;
}
function writeSettingsFile(filePath, settings) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
function parseOverrideStringArrayOrFalse(value, meta) {
    if (value === undefined)
        return undefined;
    if (value === false)
        return false;
    if (!Array.isArray(value)) {
        throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
    }
    const items = [];
    for (const item of value) {
        if (typeof item !== "string") {
            throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
        }
        const trimmed = item.trim();
        if (trimmed)
            items.push(trimmed);
    }
    return items;
}
function parseBuiltinOverrideEntry(name, value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
    }
    const input = value;
    const override = {};
    if ("model" in input) {
        if (typeof input.model === "string" || input.model === false)
            override.model = input.model;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
    }
    if ("thinking" in input) {
        if (typeof input.thinking === "string" || input.thinking === false)
            override.thinking = input.thinking;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
    }
    if ("systemPromptMode" in input) {
        if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
            override.systemPromptMode = input.systemPromptMode;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
        }
    }
    if ("inheritProjectContext" in input) {
        if (typeof input.inheritProjectContext === "boolean") {
            override.inheritProjectContext = input.inheritProjectContext;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
        }
    }
    if ("inheritSkills" in input) {
        if (typeof input.inheritSkills === "boolean") {
            override.inheritSkills = input.inheritSkills;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
        }
    }
    if ("defaultContext" in input) {
        if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === false) {
            override.defaultContext = input.defaultContext;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`);
        }
    }
    if ("acceptanceRole" in input) {
        if (input.acceptanceRole === "read-only" || input.acceptanceRole === "writer" || input.acceptanceRole === false) {
            override.acceptanceRole = input.acceptanceRole;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'acceptanceRole'; expected 'read-only', 'writer', or false.`);
        }
    }
    if ("disabled" in input) {
        if (typeof input.disabled === "boolean") {
            override.disabled = input.disabled;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
        }
    }
    if ("completionGuard" in input) {
        if (typeof input.completionGuard === "boolean") {
            override.completionGuard = input.completionGuard;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`);
        }
    }
    if ("toolBudget" in input) {
        if (input.toolBudget === false) {
            override.toolBudget = false;
        }
        else if (input.toolBudget && typeof input.toolBudget === "object" && !Array.isArray(input.toolBudget)) {
            override.toolBudget = input.toolBudget;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`);
        }
    }
    if ("maxExecutionTimeMs" in input) {
        if (input.maxExecutionTimeMs === false) {
            override.maxExecutionTimeMs = false;
        }
        else {
            const parsed = input.maxExecutionTimeMs;
            if (!isPositiveSafeInteger(parsed))
                throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'maxExecutionTimeMs'; expected a positive safe integer or false.`);
            override.maxExecutionTimeMs = parsed;
        }
    }
    if ("systemPrompt" in input) {
        if (typeof input.systemPrompt === "string")
            override.systemPrompt = input.systemPrompt;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
    }
    const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, {
        filePath,
        name,
        field: "fallbackModels",
    });
    if (fallbackModels !== undefined)
        override.fallbackModels = fallbackModels;
    const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
    if (skills !== undefined)
        override.skills = skills;
    const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
    if (tools !== undefined)
        override.tools = tools;
    const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(input.subagentOnlyExtensions, {
        filePath,
        name,
        field: "subagentOnlyExtensions",
    });
    if (subagentOnlyExtensions !== undefined)
        override.subagentOnlyExtensions = subagentOnlyExtensions;
    return Object.keys(override).length > 0 ? override : undefined;
}
function parseSettingsStringArray(value, meta) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${meta.field}'; expected an array of strings.`);
    }
    const items = [];
    for (const item of value) {
        if (typeof item !== "string") {
            throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${meta.field}'; expected an array of strings.`);
        }
        const trimmed = item.trim();
        if (trimmed)
            items.push(trimmed);
    }
    return items;
}
function readSubagentSettings(filePath) {
    if (!filePath)
        return EMPTY_SUBAGENT_SETTINGS;
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return EMPTY_SUBAGENT_SETTINGS;
    const subagentsObject = subagents;
    const agentDirs = parseSettingsStringArray(subagentsObject.agentDirs, { filePath, field: "agentDirs" });
    let defaultModel;
    if ("defaultModel" in subagentsObject) {
        if (typeof subagentsObject.defaultModel === "string" && subagentsObject.defaultModel.trim()) {
            defaultModel = subagentsObject.defaultModel.trim();
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`);
        }
    }
    const modelScope = parseModelScopeConfig(subagentsObject.modelScope, { filePath });
    const parsed = {};
    const agentOverrides = subagentsObject.agentOverrides;
    if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
        return { overrides: parsed, defaultModel, agentDirs, modelScope };
    }
    for (const [name, value] of Object.entries(agentOverrides)) {
        const override = parseBuiltinOverrideEntry(name, value, filePath);
        if (override)
            parsed[name] = override;
    }
    return { overrides: parsed, defaultModel, agentDirs, modelScope };
}
function resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
        return {
            type: "subagents.defaultModel",
            scope: "project",
            path: projectSettingsPath,
            model: projectSettings.defaultModel,
        };
    }
    return userSettings.defaultModel !== undefined
        ? { type: "subagents.defaultModel", scope: "user", path: userSettingsPath, model: userSettings.defaultModel }
        : undefined;
}
function applySubagentDefaultModel(agents, defaultModel) {
    if (!defaultModel)
        return agents;
    return agents.map((agent) => {
        if (agent.model !== undefined)
            return agent;
        const next = { ...agent, model: defaultModel.model, modelSource: defaultModel };
        const frontmatterFields = agentFrontmatterFields.get(agent);
        if (frontmatterFields)
            agentFrontmatterFields.set(next, frontmatterFields);
        return next;
    });
}
function projectScopeUserBuiltinSettings(filePath) {
    if (!filePath)
        return EMPTY_SUBAGENT_SETTINGS;
    let settings;
    try {
        settings = readSettingsFileStrict(filePath);
    }
    catch {
        return EMPTY_SUBAGENT_SETTINGS;
    }
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return EMPTY_SUBAGENT_SETTINGS;
    return EMPTY_SUBAGENT_SETTINGS;
}
function customAgentHasFrontmatterField(agent, ...fields) {
    const frontmatterFields = agentFrontmatterFields.get(agent);
    return frontmatterFields ? fields.some((field) => frontmatterFields.has(field)) : false;
}
function applyCustomAgentOverride(agent, override, meta) {
    let next;
    let anyFilled = false;
    const mutable = () => {
        next ??= { ...agent };
        return next;
    };
    const fill = (field, frontmatterFields, value) => {
        if (customAgentHasFrontmatterField(agent, ...frontmatterFields))
            return;
        mutable()[field] = value;
        anyFilled = true;
    };
    if (override.model !== undefined) {
        fill("model", ["model"], override.model === false ? undefined : override.model);
    }
    if (override.fallbackModels !== undefined) {
        fill("fallbackModels", ["fallbackModels"], override.fallbackModels === false ? undefined : [...override.fallbackModels]);
    }
    if (override.thinking !== undefined) {
        fill("thinking", ["thinking"], override.thinking === false ? undefined : override.thinking);
    }
    if (override.systemPromptMode !== undefined) {
        fill("systemPromptMode", ["systemPromptMode"], override.systemPromptMode);
    }
    if (override.inheritProjectContext !== undefined) {
        fill("inheritProjectContext", ["inheritProjectContext"], override.inheritProjectContext);
    }
    if (override.inheritSkills !== undefined) {
        fill("inheritSkills", ["inheritSkills"], override.inheritSkills);
    }
    if (override.defaultContext !== undefined) {
        fill("defaultContext", ["defaultContext"], override.defaultContext === false ? undefined : override.defaultContext);
    }
    if (override.acceptanceRole !== undefined) {
        fill("acceptanceRole", ["acceptanceRole"], override.acceptanceRole === false ? undefined : override.acceptanceRole);
    }
    if (override.disabled !== undefined && agent.disabled === undefined) {
        mutable().disabled = override.disabled;
        anyFilled = true;
    }
    if (override.skills !== undefined) {
        fill("skills", ["skill", "skills"], override.skills === false ? undefined : [...override.skills]);
    }
    if (override.tools !== undefined && !customAgentHasFrontmatterField(agent, "tools")) {
        const { tools } = splitToolList(override.tools === false ? [] : override.tools);
        const target = mutable();
        target.tools = tools;
        anyFilled = true;
    }
    if (override.subagentOnlyExtensions !== undefined) {
        fill("subagentOnlyExtensions", ["subagentOnlyExtensions"], override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions]);
    }
    if (override.completionGuard !== undefined) {
        fill("completionGuard", ["completionGuard"], override.completionGuard);
    }
    if (override.toolBudget !== undefined) {
        fill("toolBudget", ["toolBudget"], override.toolBudget === false ? undefined : override.toolBudget);
    }
    if (override.maxExecutionTimeMs !== undefined) {
        fill("maxExecutionTimeMs", ["maxExecutionTimeMs"], override.maxExecutionTimeMs === false ? undefined : override.maxExecutionTimeMs);
    }
    if (!anyFilled || !next)
        return agent;
    next.override = { ...meta, base: cloneOverrideBase(agent) };
    return next;
}
function applyCustomAgentOverrides(agents, userSettings, projectSettings, userSettingsPath, projectSettingsPath) {
    return agents.map((agent) => {
        const projectOverride = projectSettings.overrides[agent.name];
        if (projectOverride && projectSettingsPath) {
            return applyCustomAgentOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
        }
        const userOverride = userSettings.overrides[agent.name];
        if (userOverride) {
            return applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
        }
        return agent;
    });
}
export function buildBuiltinOverrideConfig(base, draft) {
    const override = {};
    if (draft.model !== base.model)
        override.model = draft.model ?? false;
    if (!arraysEqual(draft.fallbackModels, base.fallbackModels))
        override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
    if (draft.thinking !== base.thinking)
        override.thinking = draft.thinking ?? false;
    if (draft.systemPromptMode !== base.systemPromptMode)
        override.systemPromptMode = draft.systemPromptMode;
    if (draft.inheritProjectContext !== base.inheritProjectContext)
        override.inheritProjectContext = draft.inheritProjectContext;
    if (draft.inheritSkills !== base.inheritSkills)
        override.inheritSkills = draft.inheritSkills;
    if (draft.defaultContext !== base.defaultContext)
        override.defaultContext = draft.defaultContext ?? false;
    if (draft.acceptanceRole !== base.acceptanceRole)
        override.acceptanceRole = draft.acceptanceRole ?? false;
    if (draft.disabled !== base.disabled)
        override.disabled = draft.disabled ?? false;
    if (draft.systemPrompt !== base.systemPrompt)
        override.systemPrompt = draft.systemPrompt;
    if (!arraysEqual(draft.skills, base.skills))
        override.skills = draft.skills ? [...draft.skills] : false;
    const baseTools = joinToolList(base);
    const draftTools = joinToolList(draft);
    if (!arraysEqual(draftTools, baseTools))
        override.tools = draftTools ? [...draftTools] : false;
    if (!arraysEqual(draft.subagentOnlyExtensions, base.subagentOnlyExtensions)) {
        override.subagentOnlyExtensions = draft.subagentOnlyExtensions ? [...draft.subagentOnlyExtensions] : false;
    }
    if ((draft.completionGuard !== false) !== (base.completionGuard !== false)) {
        override.completionGuard = draft.completionGuard !== false;
    }
    if (JSON.stringify(draft.toolBudget) !== JSON.stringify(base.toolBudget))
        override.toolBudget = draft.toolBudget ?? false;
    if (draft.maxExecutionTimeMs !== base.maxExecutionTimeMs)
        override.maxExecutionTimeMs = draft.maxExecutionTimeMs ?? false;
    return Object.keys(override).length > 0 ? override : undefined;
}
export function saveBuiltinAgentOverride(cwd, name, scope, override) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...settings.subagents }
        : {};
    const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
        ? { ...subagents.agentOverrides }
        : {};
    agentOverrides[name] = cloneOverrideValue(override);
    subagents.agentOverrides = agentOverrides;
    settings.subagents = subagents;
    writeSettingsFile(filePath, settings);
    return filePath;
}
export function removeBuiltinAgentOverride(cwd, name, scope) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    if (!fs.existsSync(filePath))
        return { path: filePath, removed: false };
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return { path: filePath, removed: false };
    const nextSubagents = { ...subagents };
    const agentOverrides = nextSubagents.agentOverrides;
    if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides))
        return { path: filePath, removed: false };
    const nextOverrides = { ...agentOverrides };
    if (!Object.hasOwn(nextOverrides, name))
        return { path: filePath, removed: false };
    delete nextOverrides[name];
    if (Object.keys(nextOverrides).length > 0)
        nextSubagents.agentOverrides = nextOverrides;
    else
        delete nextSubagents.agentOverrides;
    if (Object.keys(nextSubagents).length > 0)
        settings.subagents = nextSubagents;
    else
        delete settings.subagents;
    writeSettingsFile(filePath, settings);
    return { path: filePath, removed: true };
}
export function mergeBuiltinAgentOverride(cwd, name, scope, fields) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...settings.subagents }
        : {};
    const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
        ? { ...subagents.agentOverrides }
        : {};
    const existing = agentOverrides[name];
    const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    agentOverrides[name] = { ...base, ...cloneOverrideValue(fields) };
    subagents.agentOverrides = agentOverrides;
    settings.subagents = subagents;
    writeSettingsFile(filePath, settings);
    return filePath;
}
export function removeBuiltinAgentOverrideFields(cwd, name, scope, fields) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    if (!fs.existsSync(filePath))
        return { path: filePath, removed: false };
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return { path: filePath, removed: false };
    const agentOverrides = subagents.agentOverrides;
    if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides))
        return { path: filePath, removed: false };
    const entry = agentOverrides[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return { path: filePath, removed: false };
    const nextEntry = { ...entry };
    let removed = false;
    for (const field of fields) {
        if (Object.hasOwn(nextEntry, field)) {
            delete nextEntry[field];
            removed = true;
        }
    }
    if (!removed)
        return { path: filePath, removed: false };
    const nextSubagents = { ...subagents };
    if (Object.keys(nextEntry).length > 0) {
        nextSubagents.agentOverrides[name] = nextEntry;
    }
    else {
        const nextOverrides = { ...agentOverrides };
        delete nextOverrides[name];
        if (Object.keys(nextOverrides).length > 0)
            nextSubagents.agentOverrides = nextOverrides;
        else
            delete nextSubagents.agentOverrides;
    }
    if (Object.keys(nextSubagents).length > 0)
        settings.subagents = nextSubagents;
    else
        delete settings.subagents;
    writeSettingsFile(filePath, settings);
    return { path: filePath, removed: true };
}
function listFilesRecursive(dir, predicate) {
    const files = [];
    if (!fs.existsSync(dir))
        return files;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return files;
    }
    for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(filePath, predicate));
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink())
            continue;
        if (!predicate(entry.name))
            continue;
        files.push(filePath);
    }
    return files;
}
function isLegacyAgentSkillPath(rootDir, filePath) {
    const relative = path.relative(rootDir, filePath);
    const parts = relative.split(path.sep).map((part) => part.toLowerCase());
    if (path.basename(rootDir).toLowerCase() === ".agents") {
        parts.unshift(".agents");
    }
    return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}
function loadAgentsFromDir(dir, source) {
    const agents = [];
    for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md"))) {
        if (isLegacyAgentSkillPath(dir, filePath)) {
            continue;
        }
        let content;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        }
        catch {
            continue;
        }
        const { frontmatter, body } = parseFrontmatter(content);
        if (!frontmatter.name || !frontmatter.description) {
            continue;
        }
        const localName = frontmatter.name;
        const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
        if (parsedPackage.error)
            continue;
        const packageName = parsedPackage.packageName;
        const runtimeName = buildRuntimeName(localName, packageName);
        const tools = frontmatter.tools
            ?.split(",")
            .map((t) => t.trim())
            .filter((t) => Boolean(t) && !t.startsWith("mcp:")) ?? [];
        const defaultReads = frontmatter.defaultReads
            ?.split(",")
            .map((f) => f.trim())
            .filter(Boolean);
        const skillStr = frontmatter.skill || frontmatter.skills;
        const skills = skillStr
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const fallbackModels = frontmatter.fallbackModels
            ?.split(",")
            .map((model) => model.trim())
            .filter(Boolean);
        const systemPromptMode = frontmatter.systemPromptMode === "replace"
            ? "replace"
            : frontmatter.systemPromptMode === "append"
                ? "append"
                : defaultSystemPromptMode(localName);
        const inheritProjectContext = frontmatter.inheritProjectContext === "true"
            ? true
            : frontmatter.inheritProjectContext === "false"
                ? false
                : defaultInheritProjectContext(localName);
        const inheritSkills = frontmatter.inheritSkills === "true"
            ? true
            : frontmatter.inheritSkills === "false"
                ? false
                : defaultInheritSkills();
        const defaultContext = frontmatter.defaultContext === "fork"
            ? "fork"
            : frontmatter.defaultContext === "fresh"
                ? "fresh"
                : undefined;
        let acceptanceRole;
        if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim()) {
            if (frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer")
                acceptanceRole = frontmatter.acceptanceRole;
            else
                throw new Error(`Agent '${localName}' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'.`);
        }
        let extensions;
        if (frontmatter.extensions !== undefined) {
            extensions = frontmatter.extensions
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean);
        }
        let subagentOnlyExtensions;
        if (frontmatter.subagentOnlyExtensions !== undefined) {
            subagentOnlyExtensions = frontmatter.subagentOnlyExtensions
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean);
        }
        const extraFields = {};
        for (const [key, value] of Object.entries(frontmatter)) {
            if (!KNOWN_FIELDS.has(key))
                extraFields[key] = value;
        }
        const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
        const maxExecutionTimeMs = parsePositiveIntegerFrontmatter(frontmatter.maxExecutionTimeMs, "maxExecutionTimeMs", `Agent '${localName}'`);
        let toolBudget;
        if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
            const parsed = JSON.parse(frontmatter.toolBudget);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error(`Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`);
            }
            toolBudget = parsed;
        }
        const completionGuard = frontmatter.completionGuard === "false" ? false : frontmatter.completionGuard === "true" ? true : undefined;
        const tkTicketRequired = parseBooleanFrontmatter(frontmatter.tkTicketRequired, "tkTicketRequired", `Agent '${localName}'`);
        const agent = {
            name: runtimeName,
            localName,
            packageName,
            description: frontmatter.description,
            tools: tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
            thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
            systemPromptMode,
            inheritProjectContext,
            inheritSkills,
            defaultContext,
            acceptanceRole,
            systemPrompt: body,
            source,
            filePath,
            skills: skills && skills.length > 0 ? skills : undefined,
            extensions,
            subagentOnlyExtensions,
            output: frontmatter.output,
            defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
            defaultProgress: frontmatter.defaultProgress === "true",
            interactive: frontmatter.interactive === "true",
            maxSubagentDepth: Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0 ? parsedMaxSubagentDepth : undefined,
            completionGuard,
            toolBudget,
            maxExecutionTimeMs,
            tkTicketRequired,
            extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
        };
        agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
        agents.push(agent);
    }
    return agents;
}
function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
function resolveNearestProjectAgentDirs(cwd) {
    const projectRoot = findNearestProjectRoot(cwd);
    if (!projectRoot)
        return { readDirs: [], preferredDir: null };
    const legacyDir = path.join(projectRoot, ".agents");
    const preferredDir = path.join(getProjectConfigDir(projectRoot), "agents");
    const readDirs = [];
    if (isDirectory(legacyDir) && !isGlobalAgentsDir(legacyDir))
        readDirs.push(legacyDir);
    if (isDirectory(preferredDir))
        readDirs.push(preferredDir);
    return {
        readDirs,
        preferredDir,
    };
}
function resolveNearestProjectChainDirs(cwd) {
    const projectRoot = findNearestProjectRoot(cwd);
    if (!projectRoot)
        return { readDirs: [], preferredDir: null };
    const preferredDir = path.join(getProjectConfigDir(projectRoot), "chains");
    return {
        readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
        preferredDir,
    };
}
function uniqueResolvedDirs(dirs) {
    const seen = new Set();
    const result = [];
    for (const dir of dirs) {
        const resolved = path.resolve(dir);
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        result.push(resolved);
    }
    return result;
}
function resolveConfiguredAgentDirs(settings, baseDir) {
    return uniqueResolvedDirs((settings.agentDirs ?? []).map((dir) => {
        const expanded = expandTildePath(dir);
        return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
    }));
}
function loadAgentsFromDirs(dirs, source) {
    const agentMap = new Map();
    for (const dir of uniqueResolvedDirs(dirs)) {
        for (const agent of loadAgentsFromDir(dir, source)) {
            agentMap.set(agent.name, agent);
        }
    }
    return Array.from(agentMap.values());
}
function projectSettingsBaseDir(projectSettingsPath) {
    return projectSettingsPath ? path.dirname(path.dirname(projectSettingsPath)) : null;
}
export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
function extraUserAgentDirs() {
    const raw = process.env[EXTRA_AGENT_DIRS_ENV];
    if (!raw)
        return [];
    return raw
        .split(path.delimiter)
        .map((dir) => dir.trim())
        .filter((dir) => dir.length > 0);
}
export function discoverAgents(cwd, scope) {
    const userDirOld = path.join(getAgentDir(), "agents");
    const userDirNew = getLegacyGlobalAgentsDir();
    const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
    const userSettingsPath = getUserAgentSettingsPath();
    const projectSettingsPath = getProjectAgentSettingsPath(cwd);
    const userSettings = scope === "project" ? projectScopeUserBuiltinSettings(userSettingsPath) : readSubagentSettings(userSettingsPath);
    const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);
    const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const customUserSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : userSettings;
    const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
    const packageSubagentPaths = collectPackageSubagentPaths(cwd, {
        includeUser: scope !== "project",
        includeProject: scope !== "user",
    });
    const builtinAgents = [];
    const userConfiguredAgentDirs = scope === "project" ? [] : resolveConfiguredAgentDirs(customUserSettings, getAgentDir());
    const projectBaseDir = projectSettingsBaseDir(projectSettingsPath);
    const projectConfiguredAgentDirs = scope === "user" || !projectBaseDir ? [] : resolveConfiguredAgentDirs(projectSettings, projectBaseDir);
    const userAgents = applyCustomAgentOverrides(applySubagentDefaultModel(scope === "project"
        ? []
        : loadAgentsFromDirs([...extraUserAgentDirs(), ...userConfiguredAgentDirs, userDirOld, ...(userDirNew ? [userDirNew] : [])], "user"), defaultModel), customUserSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const projectAgents = applyCustomAgentOverrides(applySubagentDefaultModel(scope === "user" ? [] : loadAgentsFromDirs([...projectConfiguredAgentDirs, ...projectAgentDirs], "project"), defaultModel), customUserSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const packageAgents = applyCustomAgentOverrides(applySubagentDefaultModel(packageSubagentPaths.agents.flatMap((dir) => loadAgentsFromDir(dir, "package")), defaultModel), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents, packageAgents).filter((agent) => agent.disabled !== true);
    return { agents, projectAgentsDir, modelScope };
}
export function discoverAgentsAll(cwd) {
    const userDirOld = path.join(getAgentDir(), "agents");
    const userDirNew = getLegacyGlobalAgentsDir();
    const userChainDir = getUserChainDir();
    const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
    const { preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
    const userSettingsPath = getUserAgentSettingsPath();
    const projectSettingsPath = getProjectAgentSettingsPath(cwd);
    const userSettings = readSubagentSettings(userSettingsPath);
    const projectSettings = readSubagentSettings(projectSettingsPath);
    const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const packageSubagentPaths = collectPackageSubagentPaths(cwd);
    const builtin = [];
    const userConfiguredAgentDirs = resolveConfiguredAgentDirs(userSettings, getAgentDir());
    const projectBaseDir = projectSettingsBaseDir(projectSettingsPath);
    const projectConfiguredAgentDirs = projectBaseDir ? resolveConfiguredAgentDirs(projectSettings, projectBaseDir) : [];
    const user = applyCustomAgentOverrides(applySubagentDefaultModel(loadAgentsFromDirs([...extraUserAgentDirs(), ...userConfiguredAgentDirs, userDirOld, ...(userDirNew ? [userDirNew] : [])], "user"), defaultModel), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const packageMap = new Map();
    for (const dir of packageSubagentPaths.agents) {
        for (const agent of loadAgentsFromDir(dir, "package")) {
            if (!packageMap.has(agent.name))
                packageMap.set(agent.name, agent);
        }
    }
    const packageAgents = applyCustomAgentOverrides(applySubagentDefaultModel(Array.from(packageMap.values()), defaultModel), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const project = applyCustomAgentOverrides(applySubagentDefaultModel(loadAgentsFromDirs([...projectConfiguredAgentDirs, ...projectDirs], "project"), defaultModel), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const chains = [];
    const chainDiagnostics = [];
    const userDir = userDirNew && fs.existsSync(userDirNew) ? userDirNew : userDirOld;
    return {
        builtin,
        package: packageAgents,
        user,
        project,
        chains,
        chainDiagnostics,
        userDir,
        projectDir,
        userChainDir,
        projectChainDir,
        userSettingsPath,
        projectSettingsPath,
    };
}
