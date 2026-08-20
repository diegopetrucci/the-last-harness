import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
function getUserClaudeSkills() {
    return join(homedir(), ".claude", "skills");
}
function collectAncestorClaudeSkillDirs(startDir) {
    const dirs = [];
    let dir = resolve(startDir);
    const gitRoot = findGitRoot(dir);
    while (true) {
        dirs.push(join(dir, ".claude", "skills"));
        if (gitRoot !== null && dir === gitRoot) {
            break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return dirs;
}
function findGitRoot(startDir) {
    let dir = startDir;
    while (true) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}
function isClaudeSkillsDisabled(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.claudeSkills?.disabled === true;
    }
    catch {
        return false;
    }
}
function tryRealpath(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return null;
    }
}
function appendIfNew(candidate, seen, skillPaths) {
    let stat;
    try {
        stat = statSync(candidate);
    }
    catch {
        return;
    }
    if (!stat.isDirectory()) {
        return;
    }
    const real = tryRealpath(candidate);
    if (real === null || seen.has(real)) {
        return;
    }
    seen.add(real);
    skillPaths.push(candidate);
}
export function registerClaudeSkillsDiscovery(pi) {
    pi.on("resources_discover", async (event, ctx) => {
        if (isClaudeSkillsDisabled(event.cwd)) {
            return undefined;
        }
        const seen = new Set();
        const skillPaths = [];
        const userClaudeSkills = getUserClaudeSkills();
        appendIfNew(userClaudeSkills, seen, skillPaths);
        if (ctx.isProjectTrusted?.() === true) {
            for (const candidate of collectAncestorClaudeSkillDirs(event.cwd)) {
                appendIfNew(candidate, seen, skillPaths);
            }
        }
        if (skillPaths.length === 0) {
            return undefined;
        }
        return { skillPaths };
    });
}
