import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { boundChildError, MAX_CHILD_ERROR_BYTES } from "./child-protocol.js";
import { classifyTaskMutationIntent, taskMayMutate } from "./task-intent.js";
const LEVEL_RANK = {
    none: 0,
    attested: 1,
    checked: 2,
    verified: 3,
    reviewed: 4,
};
const VALID_LEVELS = new Set([
    "auto",
    "none",
    "attested",
    "checked",
    "verified",
    "reviewed",
]);
const VALID_EVIDENCE = new Set([
    "changed-files",
    "tests-added",
    "commands-run",
    "validation-output",
    "residual-risks",
    "no-staged-files",
    "diff-summary",
    "review-findings",
    "manual-notes",
]);
const ACCEPTANCE_CONFIG_KEYS = new Set([
    "level",
    "criteria",
    "evidence",
    "verify",
    "review",
    "stopRules",
    "reason",
]);
const ACCEPTANCE_GATE_KEYS = new Set(["id", "must", "evidence", "severity"]);
const ACCEPTANCE_VERIFY_KEYS = new Set([
    "id",
    "command",
    "timeoutMs",
    "cwd",
    "env",
    "allowFailure",
]);
const ACCEPTANCE_REVIEW_KEYS = new Set(["agent", "focus", "required"]);
function normalizeLevel(level) {
    return level ?? "auto";
}
function unique(items) {
    return [...new Set(items)];
}
function requiredEvidenceForLevel(level) {
    switch (level) {
        case "none":
            return [];
        case "attested":
            return ["manual-notes", "residual-risks"];
        case "checked":
            return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
        case "verified":
        case "reviewed":
            return [
                "changed-files",
                "tests-added",
                "commands-run",
                "validation-output",
                "residual-risks",
                "no-staged-files",
            ];
    }
}
function neutralizeLegacyFixCompounds(task) {
    return task.replace(/\b(?:must|no)-fix\b/g, "compound");
}
function inferLegacyLevel(input) {
    const agent = input.agentName.toLowerCase();
    const task = input.task?.toLowerCase() ?? "";
    const reasons = [];
    const readOnlyAgent = /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent);
    const readOnlyTask = /\b(?:read[- ]only|review[- ]only|do not edit|don't edit|no edits|without edits|inspect|summari[sz]e)\b/.test(task);
    const writeTaskText = neutralizeLegacyFixCompounds(task);
    const writeTask = /\b(?:fix|implement|update|write|edit|modify|migrate|release|security|delete|remove|refactor|commit)\b/.test(writeTaskText) || /\bworker\b/.test(agent);
    const risky = Boolean(input.async && writeTask) ||
        /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task);
    if (readOnlyAgent || readOnlyTask) {
        reasons.push(readOnlyAgent ? "read-only/reviewer-style agent" : "read-only task wording");
        return {
            level: "attested",
            reasons,
            criteria: ["Return concrete findings with file paths and severity when applicable"],
            evidence: ["review-findings", "residual-risks"],
        };
    }
    if (risky) {
        reasons.push(input.async ? "async write-capable or risky run" : "risky write-capable run");
        return {
            level: "checked",
            reasons,
            criteria: ["Implement the requested change without widening scope"],
            evidence: requiredEvidenceForLevel("checked"),
        };
    }
    if (writeTask && !readOnlyTask) {
        reasons.push("write-capable worker/task");
        return {
            level: "checked",
            reasons,
            criteria: ["Implement the requested change without widening scope"],
            evidence: requiredEvidenceForLevel("checked"),
        };
    }
    reasons.push("default lightweight attestation");
    return {
        level: "attested",
        reasons,
        criteria: ["Return a concise result and residual risks when applicable"],
        evidence: ["manual-notes", "residual-risks"],
    };
}
function inferRoleAwareLevel(input) {
    const task = input.task?.toLowerCase() ?? "";
    const reasons = [];
    const intent = classifyTaskMutationIntent("worker", input.task ?? "");
    const readOnlyTask = intent.kind === "read-only" ||
        (intent.kind === "unknown" &&
            /\b(?:read[- ]only|review[- ]only|no edits|without edits|inspect|summari[sz]e)\b/.test(task));
    const rolePatchTask = intent.kind !== "read-only" &&
        !/\b(?:do not|don't|must not)\s+patch\b/.test(task) &&
        /\bpatch\s+(?:(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+|[\w.-]+\.[a-z0-9]+\b|(?:the\s+)?parser\b)/.test(task);
    const taskWrites = taskMayMutate(input.task ?? "") || intent.kind === "implementation" || rolePatchTask;
    const readOnlyAgent = input.acceptanceRole === "read-only";
    const writeTask = taskWrites || (input.acceptanceRole === "writer" && !readOnlyTask);
    const inferredReadOnly = readOnlyTask || (input.acceptanceRole === "read-only" && !taskWrites);
    const risky = Boolean(input.async && writeTask) ||
        (!inferredReadOnly &&
            /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task));
    if (risky) {
        reasons.push(input.async ? "async write-capable or risky run" : "risky write-capable run");
        return {
            level: "checked",
            reasons,
            criteria: ["Implement the requested change without widening scope"],
            evidence: requiredEvidenceForLevel("checked"),
        };
    }
    if (writeTask && !readOnlyTask) {
        reasons.push(input.acceptanceRole === "writer" && !taskWrites
            ? "declared writer acceptance role"
            : "write-capable worker/task");
        return {
            level: "checked",
            reasons,
            criteria: ["Implement the requested change without widening scope"],
            evidence: requiredEvidenceForLevel("checked"),
        };
    }
    if (readOnlyAgent || readOnlyTask) {
        reasons.push(input.acceptanceRole === "read-only" && !readOnlyTask
            ? "declared read-only acceptance role"
            : "read-only task wording");
        return {
            level: "attested",
            reasons,
            criteria: ["Return concrete findings with file paths and severity when applicable"],
            evidence: ["review-findings", "residual-risks"],
        };
    }
    reasons.push("default lightweight attestation");
    return {
        level: "attested",
        reasons,
        criteria: ["Return a concise result and residual risks when applicable"],
        evidence: ["manual-notes", "residual-risks"],
    };
}
function inferLevel(input) {
    return input.acceptanceRole === undefined
        ? inferLegacyLevel(input)
        : inferRoleAwareLevel({
            agentName: input.agentName,
            acceptanceRole: input.acceptanceRole,
            task: input.task,
            mode: input.mode,
            async: input.async,
        });
}
function normalizeAcceptanceInput(input) {
    if (input === undefined || input === "auto")
        return { level: "auto" };
    if (input === false)
        return { level: "none", reason: "disabled by deprecated false shorthand" };
    if (typeof input === "string")
        return { level: input };
    return { ...input };
}
function explicitAcceptanceCanDisable(explicit) {
    return (explicit.level === "none" &&
        typeof explicit.reason === "string" &&
        explicit.reason.trim().length > 0);
}
export function validateAcceptanceInput(input, pathLabel = "acceptance") {
    const errors = [];
    if (input === undefined)
        return errors;
    if (input === false)
        return errors;
    if (typeof input === "string") {
        if (!VALID_LEVELS.has(input))
            errors.push(`${pathLabel} has invalid level '${input}'.`);
        return errors;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        errors.push(`${pathLabel} must be a string level, false, or an object.`);
        return errors;
    }
    const value = input;
    for (const key of Object.keys(value)) {
        if (!ACCEPTANCE_CONFIG_KEYS.has(key))
            errors.push(`${pathLabel}.${key} is not supported.`);
    }
    if (value.level !== undefined &&
        (typeof value.level !== "string" || !VALID_LEVELS.has(value.level))) {
        errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
    }
    if (value.level === "none" && (typeof value.reason !== "string" || !value.reason.trim())) {
        errors.push(`${pathLabel}.reason is required when level is none.`);
    }
    if (value.reason !== undefined && typeof value.reason !== "string")
        errors.push(`${pathLabel}.reason must be a string.`);
    if (value.criteria !== undefined && !Array.isArray(value.criteria))
        errors.push(`${pathLabel}.criteria must be an array.`);
    if (Array.isArray(value.criteria)) {
        for (const [index, criterion] of value.criteria.entries()) {
            if (typeof criterion === "string")
                continue;
            const criterionPath = `${pathLabel}.criteria[${index}]`;
            if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
                errors.push(`${criterionPath} must be a string or an object.`);
                continue;
            }
            const gate = criterion;
            for (const key of Object.keys(gate)) {
                if (!ACCEPTANCE_GATE_KEYS.has(key))
                    errors.push(`${criterionPath}.${key} is not supported.`);
            }
            if (typeof gate.id !== "string" || !gate.id.trim())
                errors.push(`${criterionPath}.id is required.`);
            if (typeof gate.must !== "string" || !gate.must.trim())
                errors.push(`${criterionPath}.must is required.`);
            if (gate.evidence !== undefined && !Array.isArray(gate.evidence))
                errors.push(`${criterionPath}.evidence must be an array.`);
            if (Array.isArray(gate.evidence)) {
                for (const [evidenceIndex, item] of gate.evidence.entries()) {
                    if (typeof item !== "string" || !VALID_EVIDENCE.has(item)) {
                        errors.push(`${criterionPath}.evidence[${evidenceIndex}] is not a supported evidence kind.`);
                    }
                }
            }
            if (gate.severity !== undefined &&
                gate.severity !== "required" &&
                gate.severity !== "recommended") {
                errors.push(`${criterionPath}.severity must be required or recommended.`);
            }
        }
    }
    if (Array.isArray(value.evidence)) {
        for (const [index, item] of value.evidence.entries()) {
            if (typeof item !== "string" || !VALID_EVIDENCE.has(item)) {
                errors.push(`${pathLabel}.evidence[${index}] is not a supported evidence kind.`);
            }
        }
    }
    else if (value.evidence !== undefined) {
        errors.push(`${pathLabel}.evidence must be an array.`);
    }
    if (value.verify !== undefined && !Array.isArray(value.verify))
        errors.push(`${pathLabel}.verify must be an array.`);
    if (Array.isArray(value.verify)) {
        for (const [index, command] of value.verify.entries()) {
            if (!command || typeof command !== "object" || Array.isArray(command)) {
                errors.push(`${pathLabel}.verify[${index}] must be an object.`);
                continue;
            }
            const cmd = command;
            for (const key of Object.keys(cmd)) {
                if (!ACCEPTANCE_VERIFY_KEYS.has(key))
                    errors.push(`${pathLabel}.verify[${index}].${key} is not supported.`);
            }
            if (typeof cmd.id !== "string" || !cmd.id.trim())
                errors.push(`${pathLabel}.verify[${index}].id is required.`);
            if (typeof cmd.command !== "string" || !cmd.command.trim())
                errors.push(`${pathLabel}.verify[${index}].command is required.`);
            if (cmd.timeoutMs !== undefined &&
                (typeof cmd.timeoutMs !== "number" || !Number.isInteger(cmd.timeoutMs) || cmd.timeoutMs < 1)) {
                errors.push(`${pathLabel}.verify[${index}].timeoutMs must be an integer >= 1.`);
            }
            if (cmd.cwd !== undefined && typeof cmd.cwd !== "string")
                errors.push(`${pathLabel}.verify[${index}].cwd must be a string.`);
            if (cmd.env !== undefined) {
                if (!cmd.env || typeof cmd.env !== "object" || Array.isArray(cmd.env)) {
                    errors.push(`${pathLabel}.verify[${index}].env must be an object.`);
                }
                else {
                    for (const [envKey, envValue] of Object.entries(cmd.env)) {
                        if (typeof envValue !== "string")
                            errors.push(`${pathLabel}.verify[${index}].env.${envKey} must be a string.`);
                    }
                }
            }
            if (cmd.allowFailure !== undefined && typeof cmd.allowFailure !== "boolean") {
                errors.push(`${pathLabel}.verify[${index}].allowFailure must be a boolean.`);
            }
        }
    }
    if (value.review !== undefined && value.review !== false) {
        if (!value.review || typeof value.review !== "object" || Array.isArray(value.review)) {
            errors.push(`${pathLabel}.review must be false or an object.`);
        }
        else {
            const review = value.review;
            for (const key of Object.keys(review)) {
                if (!ACCEPTANCE_REVIEW_KEYS.has(key))
                    errors.push(`${pathLabel}.review.${key} is not supported.`);
            }
            if (review.agent !== undefined && typeof review.agent !== "string")
                errors.push(`${pathLabel}.review.agent must be a string.`);
            if (review.focus !== undefined && typeof review.focus !== "string")
                errors.push(`${pathLabel}.review.focus must be a string.`);
            if (review.required !== undefined && typeof review.required !== "boolean")
                errors.push(`${pathLabel}.review.required must be a boolean.`);
        }
    }
    if (value.stopRules !== undefined && !Array.isArray(value.stopRules))
        errors.push(`${pathLabel}.stopRules must be an array.`);
    if (Array.isArray(value.stopRules)) {
        for (const [index, item] of value.stopRules.entries()) {
            if (typeof item !== "string")
                errors.push(`${pathLabel}.stopRules[${index}] must be a string.`);
        }
    }
    return errors;
}
export function validateDispatchAcceptanceInput(input, pathLabel = "acceptance") {
    if (input === undefined || input === false)
        return [];
    const normalized = normalizeAcceptanceInput(input);
    if (normalizeLevel(normalized.level) !== "reviewed")
        return [];
    return [
        `${pathLabel}.level 'reviewed' is not supported at dispatch in this first-party TLH runtime because no independent reviewer result can be supplied. Use 'verified' with verify commands instead, or 'checked' for a self-contained acceptance contract.`,
    ];
}
function normalizeCriteria(criteria, evidence) {
    return (criteria ?? [])
        .map((criterion, index) => {
        if (typeof criterion === "string") {
            return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" };
        }
        const severity = criterion.severity ?? "required";
        return {
            id: criterion.id?.trim() || `criterion-${index + 1}`,
            must: criterion.must ?? "",
            evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
            severity,
        };
    })
        .filter((criterion) => criterion.must.trim());
}
export function resolveEffectiveAcceptance(input) {
    const explicit = normalizeAcceptanceInput(input.explicit);
    const inferred = inferLevel(input);
    const explicitLevel = normalizeLevel(explicit.level);
    const level = explicitAcceptanceCanDisable(explicit)
        ? "none"
        : explicitLevel === "auto"
            ? inferred.level
            : LEVEL_RANK[explicitLevel] >= LEVEL_RANK[inferred.level]
                ? explicitLevel
                : inferred.level;
    const evidence = unique([
        ...(level === inferred.level ? inferred.evidence : requiredEvidenceForLevel(level)),
        ...(explicit.evidence ?? []),
    ]);
    const criteria = normalizeCriteria((explicit.criteria?.length ? explicit.criteria : inferred.criteria), evidence);
    let review = explicit.review !== undefined ? explicit.review : inferred.review;
    if (level === "reviewed" &&
        explicitLevel !== "auto" &&
        explicitLevel !== "reviewed" &&
        explicit.review === undefined &&
        review) {
        review = { ...review, required: false };
    }
    return {
        level,
        explicit: input.explicit !== undefined,
        inferredReason: inferred.reasons,
        criteria,
        evidence,
        verify: explicit.verify ?? [],
        review,
        stopRules: explicit.stopRules ?? [],
        reason: explicit.reason,
    };
}
function mergeAcceptanceCriteria(base, extra) {
    const merged = [...base];
    for (const criterion of extra) {
        const index = merged.findIndex((candidate) => candidate.id === criterion.id);
        if (index === -1) {
            merged.push(criterion);
            continue;
        }
        merged[index] = {
            ...merged[index],
            must: merged[index]?.must || criterion.must,
            evidence: unique([...(merged[index]?.evidence ?? []), ...criterion.evidence]),
            severity: merged[index]?.severity === "required" || criterion.severity === "required"
                ? "required"
                : "recommended",
        };
    }
    return merged;
}
export function mergeContinuationAcceptance(base, override) {
    if (!base)
        return undefined;
    if (override === undefined)
        return base;
    const explicit = normalizeAcceptanceInput(override);
    if (explicitAcceptanceCanDisable(explicit))
        return base;
    const overrideLevel = normalizeLevel(explicit.level);
    const level = overrideLevel === "auto"
        ? base.level
        : LEVEL_RANK[overrideLevel] >= LEVEL_RANK[base.level]
            ? overrideLevel
            : base.level;
    const evidence = unique([
        ...requiredEvidenceForLevel(level),
        ...base.evidence,
        ...(explicit.evidence ?? []),
    ]);
    const overrideCriteria = normalizeCriteria(explicit.criteria, evidence);
    const criteria = mergeAcceptanceCriteria(base.criteria, overrideCriteria);
    const verify = mergeVerifyCommands(base.verify, explicit.verify ?? []);
    const review = mergeReviewGate(base.review, explicit.review);
    const strengthensAcceptance = overrideLevel !== "auto" ||
        overrideCriteria.length > 0 ||
        (explicit.evidence?.length ?? 0) > 0 ||
        (explicit.verify?.length ?? 0) > 0 ||
        explicit.review !== undefined ||
        (explicit.stopRules?.length ?? 0) > 0 ||
        explicit.reason !== undefined;
    return {
        level,
        explicit: strengthensAcceptance ? true : base.explicit,
        inferredReason: base.inferredReason,
        criteria,
        evidence,
        verify,
        review,
        stopRules: unique([...base.stopRules, ...(explicit.stopRules ?? [])]),
        reason: explicit.reason ?? base.reason,
    };
}
function verifyCommandIdentity(command) {
    const envEntries = Object.entries(command.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify({ command: command.command, cwd: command.cwd ?? "", env: envEntries });
}
function mergeVerifyCommands(base, extra) {
    const merged = [...base];
    const seen = new Set(merged.map((command) => verifyCommandIdentity(command)));
    for (const command of extra) {
        const identity = verifyCommandIdentity(command);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        merged.push(command);
    }
    return merged;
}
function mergeReviewGate(base, extra) {
    if (extra === undefined)
        return base;
    if (base === false)
        return extra;
    if (extra === false)
        return base;
    if (!base)
        return extra;
    if (!extra)
        return base;
    return {
        agent: extra.agent ?? base.agent,
        focus: uniqueStrings([base.focus, extra.focus]).join("; ") || undefined,
        required: base.required === true || extra.required === true ? true : (extra.required ?? base.required),
    };
}
export function formatAcceptancePrompt(acceptance) {
    if (acceptance.level === "none")
        return "";
    const lines = [
        "",
        "## Acceptance Contract",
        `Acceptance level: ${acceptance.level}`,
        "Completion is not accepted from prose alone. End with a structured acceptance report.",
        "",
        "Criteria:",
        ...(acceptance.criteria.length
            ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`)
            : ["- Return the requested result."]),
        "",
        `Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
    ];
    if (acceptance.verify.length > 0) {
        lines.push("", "Runtime verification commands configured by parent:");
        for (const command of acceptance.verify)
            lines.push(`- ${command.id}: ${command.command}`);
    }
    if (acceptance.review) {
        lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
        if (acceptance.review.focus)
            lines.push(`Review focus: ${acceptance.review.focus}`);
    }
    if (acceptance.stopRules.length > 0) {
        lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
    }
    lines.push("", "Write a one-line prose summary of what you completed immediately before the fenced block.", 'For commandsRun[].result, "passed" or "failed" are preferred, but honest annotations such as "failed as expected" are also accepted.', "Finish with a fenced JSON block tagged `acceptance-report` in this shape:", "Use empty arrays when no items apply; array fields contain strings unless object entries are shown.", "```acceptance-report", JSON.stringify({
        criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
        changedFiles: ["src/file.ts"],
        testsAddedOrUpdated: ["test/file.test.ts"],
        commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
        validationOutput: ["validation output or concise summary"],
        residualRisks: ["none"],
        noStagedFiles: true,
        diffSummary: "short description of the diff",
        reviewFindings: ["blocker: file.ts:12 - issue found, or no blockers"],
        manualNotes: "anything else the parent should know",
    }, null, 2), "```");
    return lines.join("\n");
}
function extractBalancedJson(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{")
            depth++;
        if (char === "}") {
            depth--;
            if (depth === 0)
                return text.slice(start, i + 1);
        }
    }
    return undefined;
}
function unwrapAcceptanceReport(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { value, wrapper: "" };
    }
    if ("acceptance" in value)
        return { value: value.acceptance, wrapper: "acceptance" };
    if ("acceptance-report" in value) {
        return { value: value["acceptance-report"], wrapper: "acceptance-report" };
    }
    return { value, wrapper: "" };
}
function isCommandsRunArray(value) {
    return (Array.isArray(value) &&
        value.every((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return false;
            const command = item;
            return (typeof command.command === "string" &&
                (command.result === "passed" ||
                    command.result === "failed" ||
                    command.result === "not-run") &&
                typeof command.summary === "string");
        }));
}
function hasGenericAcceptanceReportSignal(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return ("criteriaSatisfied" in record &&
        (isStringArray(record.changedFiles) ||
            isStringArray(record.testsAddedOrUpdated) ||
            isCommandsRunArray(record.commandsRun) ||
            isStringArray(record.validationOutput) ||
            isStringArray(record.residualRisks) ||
            typeof record.noStagedFiles === "boolean" ||
            typeof record.diffSummary === "string" ||
            isStringArray(record.reviewFindings) ||
            typeof record.manualNotes === "string"));
}
function isJsonValue(value) {
    if (value === null)
        return true;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        return true;
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (typeof value !== "object")
        return false;
    return Object.values(value).every(isJsonValue);
}
function parseReportJson(body) {
    const trimmed = body.trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (isJsonValue(parsed))
            return parsed;
    }
    catch (error) {
        const jsonStart = trimmed.indexOf("{");
        if (jsonStart > 0) {
            const json = extractBalancedJson(trimmed, jsonStart);
            if (json) {
                const parsed = JSON.parse(json);
                if (isJsonValue(parsed))
                    return parsed;
            }
        }
        throw error;
    }
    throw new Error("Acceptance report JSON must contain a JSON value.");
}
function fencedBlocks(output, tag) {
    return [...output.matchAll(new RegExp(`\`\`\`${tag}\\s*\\n([\\s\\S]*?)\`\`\``, "gi"))]
        .map((match) => match[1]?.trim())
        .filter((value) => Boolean(value));
}
function parseAcceptanceReportBody(body) {
    const parsed = unwrapAcceptanceReport(parseReportJson(body));
    return validateAcceptanceReport(parsed.value, parsed.wrapper);
}
function parseGenericJsonAcceptanceReportBody(body) {
    const parsed = unwrapAcceptanceReport(parseReportJson(body));
    const validation = validateAcceptanceReport(parsed.value);
    if (!validation.report)
        return undefined;
    return hasGenericAcceptanceReportSignal(validation.report) ? validation.report : undefined;
}
export function parseAcceptanceReport(output) {
    const fenced = fencedBlocks(output, "acceptance-report");
    const parseErrors = [];
    for (const body of fenced) {
        try {
            const validation = parseAcceptanceReportBody(body);
            if (validation.report)
                return { report: validation.report };
            parseErrors.push(`Invalid acceptance-report: ${validation.errors.join("; ")}`);
        }
        catch (error) {
            parseErrors.push(error instanceof Error ? error.message : String(error));
        }
    }
    if (parseErrors.length > 0)
        return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
    for (const body of fencedBlocks(output, "(?:json|jsonc|json5)")) {
        try {
            const report = parseGenericJsonAcceptanceReportBody(body);
            if (report)
                return { report };
        }
        catch {
        }
    }
    const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
    if (markerIndex !== -1) {
        const jsonStart = output.indexOf("{", markerIndex);
        if (jsonStart !== -1) {
            const json = extractBalancedJson(output, jsonStart);
            if (json) {
                try {
                    const parsed = unwrapAcceptanceReport(parseReportJson(json));
                    const validation = validateAcceptanceReport(parsed.value, parsed.wrapper);
                    if (validation.report)
                        return { report: validation.report };
                    return {
                        error: `Failed to parse acceptance-report: Invalid acceptance-report: ${validation.errors.join("; ")}`,
                    };
                }
                catch (error) {
                    return { error: error instanceof Error ? error.message : String(error) };
                }
            }
        }
    }
    return { error: "Structured acceptance report not found." };
}
export function parseAndStripAcceptanceReport(output) {
    const trailingFencePattern = /\n?```(acceptance-report|json|jsonc|json5)\s*\n([\s\S]*?)```\s*/gi;
    let trailingFence;
    for (const match of output.matchAll(trailingFencePattern)) {
        const end = (match.index ?? 0) + match[0].length;
        if (output.slice(end).trim().length === 0 && match[1] && match[2]) {
            trailingFence = { index: match.index ?? 0, tag: match[1].toLowerCase(), body: match[2] };
        }
    }
    if (trailingFence) {
        const stripped = output.slice(0, trailingFence.index).trimEnd();
        if (trailingFence.tag === "acceptance-report") {
            try {
                const validation = parseAcceptanceReportBody(trailingFence.body);
                if (validation.report)
                    return { stripped, report: validation.report };
                return {
                    stripped: output,
                    error: `Failed to parse acceptance-report: ${validation.errors.join("; ")}`,
                };
            }
            catch (err) {
                return {
                    stripped: output,
                    error: `Failed to parse acceptance-report: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        }
        try {
            const report = parseGenericJsonAcceptanceReportBody(trailingFence.body);
            if (report)
                return { stripped, report };
        }
        catch {
        }
    }
    const markerPattern = /ACCEPTANCE_REPORT\s*:/gi;
    let markerMatch;
    let trailingMarker;
    while ((markerMatch = markerPattern.exec(output)) !== null) {
        const jsonStart = output.indexOf("{", markerMatch.index + markerMatch[0].length);
        if (jsonStart === -1)
            continue;
        const json = extractBalancedJson(output, jsonStart);
        if (!json)
            continue;
        if (output.slice(jsonStart + json.length).trim().length === 0) {
            trailingMarker = { markerStart: markerMatch.index, json };
        }
    }
    if (trailingMarker) {
        try {
            const parsed = unwrapAcceptanceReport(parseReportJson(trailingMarker.json));
            const validation = validateAcceptanceReport(parsed.value, parsed.wrapper);
            if (validation.report) {
                return {
                    stripped: output.slice(0, trailingMarker.markerStart).trimEnd(),
                    report: validation.report,
                };
            }
            return {
                stripped: output,
                error: `Failed to parse acceptance-report: Invalid acceptance-report: ${validation.errors.join("; ")}`,
            };
        }
        catch (err) {
            return {
                stripped: output,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    return { stripped: output, error: "Structured acceptance report not found." };
}
export function isEffectivelyEmpty(s) {
    const trimmed = s.trim();
    if (trimmed.length === 0)
        return true;
    return trimmed.split(/\r?\n/).every((line) => {
        const l = line.trim();
        return l.length === 0 || /^(-{3,}|\*{3,}|_{3,})$/.test(l);
    });
}
export function buildAcceptanceReportDigest(report) {
    const lines = ["---", "Validation evidence (from acceptance report):"];
    if (Array.isArray(report.commandsRun) && report.commandsRun.length > 0) {
        lines.push("");
        for (const entry of report.commandsRun) {
            lines.push(`  [${entry.result}] ${entry.command} — ${entry.summary}`);
        }
    }
    const risks = Array.isArray(report.residualRisks)
        ? report.residualRisks.filter((r) => typeof r === "string" && r.trim().length > 0 && r.toLowerCase() !== "none")
        : [];
    if (risks.length > 0) {
        lines.push("");
        lines.push("Residual risks:");
        for (const risk of risks) {
            lines.push(`  - ${risk}`);
        }
    }
    lines.push("---");
    return lines.join("\n");
}
export function appendAcceptanceReportDigest(output, report) {
    const digest = buildAcceptanceReportDigest(report);
    return output.trim().length > 0 ? `${output}\n\n${digest}` : digest;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function pathFor(base, segment) {
    return base ? `${base}.${segment}` : segment;
}
function describeValidationValue(value) {
    if (value === undefined)
        return "missing";
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "object")
        return "object";
    if (typeof value === "string") {
        const short = value.length > 80 ? `${value.slice(0, 77)}...` : value;
        return JSON.stringify(short);
    }
    return `${typeof value} ${String(value)}`;
}
function pushTypeError(errors, pathLabel, expected, value) {
    errors.push(`${pathLabel}: expected ${expected}; got ${describeValidationValue(value)}`);
}
function validateStringArrayField(errors, value, pathLabel) {
    if (!Array.isArray(value)) {
        pushTypeError(errors, pathLabel, "string[]", value);
        return;
    }
    for (const [index, item] of value.entries()) {
        if (typeof item !== "string")
            pushTypeError(errors, `${pathLabel}[${index}]`, "string", item);
    }
}
function normalizeAcceptanceReportStringArrays(report) {
    const normalizeArray = (items) => {
        if (!Array.isArray(items) || items.length === 0)
            return items;
        const filtered = items.filter((item) => item.trim().length > 0);
        return filtered.length > 0 ? filtered : undefined;
    };
    return {
        ...report,
        changedFiles: normalizeArray(report.changedFiles),
        testsAddedOrUpdated: normalizeArray(report.testsAddedOrUpdated),
        validationOutput: normalizeArray(report.validationOutput),
        residualRisks: normalizeArray(report.residualRisks),
        reviewFindings: normalizeArray(report.reviewFindings),
    };
}
function validateAcceptanceReport(value, pathLabel = "") {
    const errors = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        pushTypeError(errors, pathLabel || "acceptance-report", "object", value);
        return { errors };
    }
    const report = value;
    if (report.criteriaSatisfied !== undefined) {
        if (!Array.isArray(report.criteriaSatisfied)) {
            pushTypeError(errors, pathFor(pathLabel, "criteriaSatisfied"), "array", report.criteriaSatisfied);
        }
        else {
            for (const [index, item] of report.criteriaSatisfied.entries()) {
                const itemPath = `${pathFor(pathLabel, "criteriaSatisfied")}[${index}]`;
                if (!item || typeof item !== "object" || Array.isArray(item)) {
                    pushTypeError(errors, itemPath, "object", item);
                    continue;
                }
                const criterion = item;
                if (criterion.id !== undefined && typeof criterion.id !== "string")
                    pushTypeError(errors, `${itemPath}.id`, "string", criterion.id);
                if (criterion.status !== "satisfied" &&
                    criterion.status !== "not-satisfied" &&
                    criterion.status !== "not-applicable") {
                    pushTypeError(errors, `${itemPath}.status`, 'one of "satisfied", "not-satisfied", "not-applicable"', criterion.status);
                }
                if (typeof criterion.evidence !== "string" || !criterion.evidence.trim())
                    pushTypeError(errors, `${itemPath}.evidence`, "non-empty string", criterion.evidence);
            }
        }
    }
    if (report.changedFiles !== undefined)
        validateStringArrayField(errors, report.changedFiles, pathFor(pathLabel, "changedFiles"));
    if (report.testsAddedOrUpdated !== undefined)
        validateStringArrayField(errors, report.testsAddedOrUpdated, pathFor(pathLabel, "testsAddedOrUpdated"));
    if (report.commandsRun !== undefined) {
        if (!Array.isArray(report.commandsRun)) {
            pushTypeError(errors, pathFor(pathLabel, "commandsRun"), "array", report.commandsRun);
        }
        else {
            for (const [index, item] of report.commandsRun.entries()) {
                const itemPath = `${pathFor(pathLabel, "commandsRun")}[${index}]`;
                if (!item || typeof item !== "object" || Array.isArray(item)) {
                    pushTypeError(errors, itemPath, "object", item);
                    continue;
                }
                const command = item;
                if (typeof command.command !== "string" || !command.command.trim())
                    pushTypeError(errors, `${itemPath}.command`, "non-empty string", command.command);
                if (typeof command.result !== "string")
                    pushTypeError(errors, `${itemPath}.result`, "string", command.result);
                if (typeof command.summary !== "string")
                    pushTypeError(errors, `${itemPath}.summary`, "string", command.summary);
            }
        }
    }
    if (report.validationOutput !== undefined)
        validateStringArrayField(errors, report.validationOutput, pathFor(pathLabel, "validationOutput"));
    if (report.residualRisks !== undefined)
        validateStringArrayField(errors, report.residualRisks, pathFor(pathLabel, "residualRisks"));
    if (report.noStagedFiles !== undefined && typeof report.noStagedFiles !== "boolean")
        pushTypeError(errors, pathFor(pathLabel, "noStagedFiles"), "boolean", report.noStagedFiles);
    if (report.diffSummary !== undefined && typeof report.diffSummary !== "string")
        pushTypeError(errors, pathFor(pathLabel, "diffSummary"), "string", report.diffSummary);
    if (report.reviewFindings !== undefined)
        validateStringArrayField(errors, report.reviewFindings, pathFor(pathLabel, "reviewFindings"));
    if (report.manualNotes !== undefined && typeof report.manualNotes !== "string")
        pushTypeError(errors, pathFor(pathLabel, "manualNotes"), "string", report.manualNotes);
    if (report.notes !== undefined && typeof report.notes !== "string")
        pushTypeError(errors, pathFor(pathLabel, "notes"), "string", report.notes);
    if (errors.length > 0)
        return { errors };
    const normalizedReport = normalizeAcceptanceReportStringArrays(report);
    const hasReportField = normalizedReport.criteriaSatisfied !== undefined ||
        normalizedReport.changedFiles !== undefined ||
        normalizedReport.testsAddedOrUpdated !== undefined ||
        normalizedReport.commandsRun !== undefined ||
        normalizedReport.validationOutput !== undefined ||
        normalizedReport.residualRisks !== undefined ||
        normalizedReport.noStagedFiles !== undefined ||
        normalizedReport.diffSummary !== undefined ||
        normalizedReport.manualNotes !== undefined ||
        normalizedReport.notes !== undefined ||
        normalizedReport.reviewFindings !== undefined;
    return hasReportField
        ? { report: normalizedReport, errors }
        : {
            errors: [
                `${pathLabel || "acceptance-report"}: expected at least one acceptance report field`,
            ],
        };
}
function checkCriteriaSatisfied(criteria, report) {
    const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id, item]));
    return criteria
        .filter((criterion) => criterion.severity !== "recommended")
        .map((criterion) => {
        const item = reports.get(criterion.id);
        if (!item)
            return {
                id: `criterion:${criterion.id}`,
                status: "failed",
                message: `Required criterion '${criterion.id}' was not reported.`,
            };
        if (item.status !== "satisfied")
            return {
                id: `criterion:${criterion.id}`,
                status: "failed",
                message: `Required criterion '${criterion.id}' was reported as ${item.status}.`,
            };
        return {
            id: `criterion:${criterion.id}`,
            status: "passed",
            message: `Required criterion '${criterion.id}' satisfied.`,
        };
    });
}
function reportEvidencePresent(report, kind) {
    switch (kind) {
        case "changed-files":
            return isStringArray(report.changedFiles) && report.changedFiles.length > 0;
        case "tests-added":
            return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0;
        case "commands-run":
            return Array.isArray(report.commandsRun) && report.commandsRun.length > 0;
        case "validation-output":
            return isStringArray(report.validationOutput) && report.validationOutput.length > 0;
        case "residual-risks":
            return isStringArray(report.residualRisks);
        case "no-staged-files":
            return report.noStagedFiles === true;
        case "diff-summary":
            return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0;
        case "review-findings":
            return isStringArray(report.reviewFindings);
        case "manual-notes":
            return Boolean((report.manualNotes ?? report.notes)?.trim());
    }
}
function checkNoStagedFiles(cwd) {
    const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
    if (result.status !== 0) {
        return {
            id: "no-staged-files",
            status: "not-applicable",
            message: "git status unavailable; no staged-files check skipped",
        };
    }
    const staged = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
    return staged.length === 0
        ? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
        : {
            id: "no-staged-files",
            status: "failed",
            message: `Staged files present: ${staged.join(", ")}`,
        };
}
function runStructuralChecks(acceptance, report, cwd) {
    const checks = [];
    for (const kind of acceptance.evidence) {
        const present = reportEvidencePresent(report, kind);
        checks.push({
            id: `evidence:${kind}`,
            status: present ? "passed" : "failed",
            message: present
                ? `${kind} evidence present.`
                : `${kind} evidence missing from child report.`,
        });
    }
    if (acceptance.evidence.includes("no-staged-files"))
        checks.push(checkNoStagedFiles(cwd));
    return checks;
}
function trimOutput(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}
function uniqueStrings(items) {
    return unique(items.map((item) => item?.trim()).filter((item) => Boolean(item)));
}
function runVerifyCommand(command, defaultCwd, options = {}) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let hardKill;
        const child = spawn(command.command, {
            cwd,
            env: { ...process.env, ...command.env },
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (hardKill)
                clearTimeout(hardKill);
            options.signal?.removeEventListener("abort", abortVerification);
            resolve({
                id: command.id,
                command: command.command,
                cwd,
                durationMs: Date.now() - startedAt,
                ...result,
            });
        };
        const abortVerification = () => {
            if (settled || timedOut)
                return;
            timedOut = true;
            child.kill("SIGTERM");
            hardKill = setTimeout(() => {
                child.kill("SIGKILL");
                finish({
                    exitCode: null,
                    status: "timed-out",
                    stdout: trimOutput(stdout),
                    stderr: trimOutput(stderr || options.abortMessage || "Acceptance verification timed out."),
                });
            }, 1000);
            hardKill.unref?.();
        };
        const timeout = setTimeout(abortVerification, command.timeoutMs ?? 120_000);
        timeout.unref?.();
        if (options.signal?.aborted)
            abortVerification();
        else
            options.signal?.addEventListener("abort", abortVerification, { once: true });
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (exitCode) => {
            const passed = exitCode === 0 && !timedOut;
            finish({
                exitCode,
                status: timedOut
                    ? "timed-out"
                    : passed
                        ? "passed"
                        : command.allowFailure
                            ? "allowed-failure"
                            : "failed",
                stdout: trimOutput(stdout),
                stderr: trimOutput(stderr || (timedOut ? (options.abortMessage ?? "") : "")),
            });
        });
        child.on("error", (error) => {
            finish({
                exitCode: timedOut ? null : 1,
                status: timedOut ? "timed-out" : command.allowFailure ? "allowed-failure" : "failed",
                stderr: timedOut
                    ? trimOutput(stderr || options.abortMessage || "Acceptance verification timed out.")
                    : error instanceof Error
                        ? error.message
                        : String(error),
            });
        });
    });
}
export function buildSkippedAcceptanceLedger(input) {
    return {
        status: input.acceptance.level === "none" ? "not-required" : input.ledgerStatus,
        explicit: input.acceptance.explicit,
        effectiveAcceptance: input.acceptance,
        inferredReason: input.acceptance.inferredReason,
        criteria: input.acceptance.criteria,
        runtimeChecks: input.acceptance.level === "none"
            ? []
            : [{ id: input.id, status: input.runtimeCheckStatus, message: input.message }],
        verifyRuns: [],
    };
}
export async function evaluateAcceptance(input) {
    const acceptance = input.acceptance;
    const ledger = {
        status: acceptance.level === "none" ? "not-required" : "claimed",
        explicit: acceptance.explicit,
        effectiveAcceptance: acceptance,
        inferredReason: acceptance.inferredReason,
        criteria: acceptance.criteria,
        runtimeChecks: [],
        verifyRuns: [],
    };
    if (acceptance.level === "none")
        return ledger;
    const parsed = input.report
        ? { report: input.report, error: undefined }
        : parseAndStripAcceptanceReport(input.output);
    if (parsed.report) {
        ledger.childReport = parsed.report;
        ledger.status = "attested";
    }
    else {
        ledger.childReportParseError = parsed.error;
        ledger.runtimeChecks.push({
            id: "attestation",
            status: "failed",
            message: parsed.error ?? "Structured acceptance report missing.",
        });
        ledger.status = "rejected";
        return ledger;
    }
    if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
        ledger.runtimeChecks = [
            ...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
            ...runStructuralChecks(acceptance, parsed.report, input.cwd),
        ];
        if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
            ledger.status = "rejected";
            return ledger;
        }
        ledger.status = "checked";
    }
    if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified &&
        (acceptance.level === "verified" || acceptance.verify.length > 0)) {
        if (acceptance.level === "verified" && acceptance.verify.length === 0) {
            ledger.runtimeChecks.push({
                id: "verification-config",
                status: "failed",
                message: "verified acceptance requires runtime verify commands.",
            });
            ledger.status = "rejected";
            return ledger;
        }
        ledger.verifyRuns = [];
        for (const command of acceptance.verify) {
            ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd, {
                signal: input.signal,
                abortMessage: input.abortMessage,
            }));
            if (input.signal?.aborted)
                break;
        }
        if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
            ledger.status = "rejected";
            return ledger;
        }
        ledger.status = "verified";
    }
    if (acceptance.level === "reviewed") {
        if (input.reviewResult) {
            ledger.reviewResult = input.reviewResult;
            ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
        }
        else {
            const optionalReview = acceptance.review && acceptance.review.required === false;
            ledger.reviewResult = {
                status: "needs-parent-decision",
                findings: [
                    {
                        severity: acceptance.explicit && !optionalReview ? "blocker" : "non-blocking",
                        issue: "Reviewed acceptance requires an independent reviewer result.",
                        rationale: "The run cannot be marked reviewed from child evidence alone.",
                    },
                ],
            };
            if (acceptance.review === false || (acceptance.explicit && !optionalReview))
                ledger.status = "rejected";
        }
    }
    return ledger;
}
export function acceptanceRejectionReason(ledger) {
    if (ledger.status !== "rejected")
        return undefined;
    if (typeof ledger.childReportParseError === "string" && ledger.childReportParseError)
        return ledger.childReportParseError;
    const checks = Array.isArray(ledger.runtimeChecks) ? ledger.runtimeChecks : [];
    for (const check of checks) {
        if (!check || typeof check !== "object")
            continue;
        if (check.status === "failed" && typeof check.message === "string")
            return check.message;
    }
    const verifyRuns = Array.isArray(ledger.verifyRuns) ? ledger.verifyRuns : [];
    for (const run of verifyRuns) {
        if (!run || typeof run !== "object")
            continue;
        if ((run.status === "failed" || run.status === "timed-out") &&
            typeof run.id === "string" &&
            typeof run.status === "string")
            return `Verification '${run.id}' ${run.status}.`;
    }
    return undefined;
}
export function acceptanceFailureMessage(ledger) {
    if (ledger.status !== "rejected")
        return undefined;
    const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
    if (failedCheck)
        return `Acceptance rejected: ${failedCheck.message}`;
    const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
    if (failedVerify)
        return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
    if (ledger.reviewResult?.status === "needs-parent-decision")
        return "Acceptance review required but no automatic reviewer result is available.";
    if (ledger.reviewResult?.status === "blockers")
        return "Acceptance review found blockers.";
    return "Acceptance rejected.";
}
export function composeAcceptanceFailureError(childError, acceptanceFailure) {
    const boundedAcceptance = boundChildError(acceptanceFailure, MAX_CHILD_ERROR_BYTES) ?? "Acceptance rejected.";
    if (!childError)
        return boundedAcceptance;
    const acceptanceSuffix = `\n${boundedAcceptance}`;
    const suffixBytes = Buffer.byteLength(acceptanceSuffix, "utf-8");
    if (suffixBytes >= MAX_CHILD_ERROR_BYTES)
        return boundedAcceptance;
    const boundedChild = boundChildError(childError, MAX_CHILD_ERROR_BYTES - suffixBytes);
    return boundedChild ? `${boundedChild}${acceptanceSuffix}` : boundedAcceptance;
}
