export const SESSION_MIRROR_PROJECTION_REASONS = Object.freeze([
    "invalid-metadata",
    "session-unavailable",
    "unsafe-session-data",
    "bounds-exceeded",
]);
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_TREE_ENTRIES = 1024;
const MAX_TREE_DEPTH = 128;
const MAX_ENTRY_PAYLOAD_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_IDENTITY_CHARACTERS = 128;
const MAX_CURSOR_CHARACTERS = 256;
const MAX_CONTENT_BLOCKS = 1024;
const MAX_MANAGER_PROTOTYPE_DEPTH = 16;
const STATUS_VALUES = new Set([
    "idle",
    "active",
    "waiting",
    "error",
    "unknown",
]);
const MISSING = Symbol("missing");
function failure(reason) {
    return Object.freeze({ ok: false, reason });
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }
    catch {
        return false;
    }
}
function readDataField(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return { present: false };
    }
    return { present: true, value: descriptor.value };
}
function readRequiredDataField(value, key) {
    const field = readDataField(value, key);
    return field.present ? field.value : MISSING;
}
function readSessionManagerMethod(sessionManager, key) {
    let current = sessionManager;
    for (let depth = 0; current !== null && depth <= MAX_MANAGER_PROTOTYPE_DEPTH; depth += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
            return "value" in descriptor && typeof descriptor.value === "function"
                ? descriptor.value
                : undefined;
        }
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}
function characterLength(value) {
    let count = 0;
    for (const _character of value)
        count += 1;
    return count;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function exceedsCharacterBound(value, maximum) {
    if (value.length <= maximum)
        return false;
    if (value.length > maximum * 2)
        return true;
    return characterLength(value) > maximum;
}
function sourceIdentityFailure(value) {
    if (!isNonEmptyString(value))
        return "unsafe-session-data";
    return exceedsCharacterBound(value, MAX_IDENTITY_CHARACTERS) ? "bounds-exceeded" : undefined;
}
function isBoundedUtf8String(value, maximum) {
    return (typeof value === "string" &&
        value.length <= maximum &&
        Buffer.byteLength(value, "utf8") <= maximum);
}
function isBoundedText(value) {
    return isBoundedUtf8String(value, MAX_TEXT_BYTES);
}
function isNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validateMetadata(metadata) {
    if (!isPlainObject(metadata))
        return { ok: false, reason: "invalid-metadata" };
    const eventId = readRequiredDataField(metadata, "eventId");
    const revision = readRequiredDataField(metadata, "revision");
    const cursor = readRequiredDataField(metadata, "cursor");
    const snapshotId = readRequiredDataField(metadata, "snapshotId");
    const runtimeVersion = readRequiredDataField(metadata, "runtimeVersion");
    const sessionSchemaVersion = readRequiredDataField(metadata, "sessionSchemaVersion");
    const status = readRequiredDataField(metadata, "status");
    if (eventId === MISSING ||
        revision === MISSING ||
        cursor === MISSING ||
        snapshotId === MISSING ||
        runtimeVersion === MISSING ||
        sessionSchemaVersion === MISSING ||
        status === MISSING) {
        return { ok: false, reason: "invalid-metadata" };
    }
    if (typeof eventId !== "string" ||
        typeof cursor !== "string" ||
        typeof snapshotId !== "string" ||
        typeof runtimeVersion !== "string" ||
        typeof sessionSchemaVersion !== "string" ||
        !isNonNegativeSafeInteger(revision) ||
        typeof status !== "string" ||
        !STATUS_VALUES.has(status)) {
        return { ok: false, reason: "invalid-metadata" };
    }
    if (!isNonEmptyString(eventId) ||
        !isNonEmptyString(cursor) ||
        !isNonEmptyString(snapshotId) ||
        runtimeVersion.length === 0 ||
        sessionSchemaVersion.length === 0) {
        return { ok: false, reason: "invalid-metadata" };
    }
    if (exceedsCharacterBound(eventId, MAX_IDENTITY_CHARACTERS) ||
        exceedsCharacterBound(cursor, MAX_CURSOR_CHARACTERS) ||
        exceedsCharacterBound(snapshotId, MAX_IDENTITY_CHARACTERS) ||
        !isBoundedUtf8String(runtimeVersion, MAX_ENVELOPE_BYTES) ||
        !isBoundedUtf8String(sessionSchemaVersion, MAX_ENVELOPE_BYTES)) {
        return { ok: false, reason: "bounds-exceeded" };
    }
    return {
        ok: true,
        value: {
            eventId,
            revision,
            cursor,
            snapshotId,
            runtimeVersion,
            sessionSchemaVersion,
            status: status,
        },
    };
}
function sourceEntryBase(entry) {
    const id = readRequiredDataField(entry, "id");
    const parentId = readRequiredDataField(entry, "parentId");
    const type = readRequiredDataField(entry, "type");
    if (id === MISSING ||
        parentId === MISSING ||
        type === MISSING ||
        typeof type !== "string" ||
        type.length === 0 ||
        !(parentId === null || typeof parentId === "string")) {
        return { ok: false, reason: "unsafe-session-data" };
    }
    if (typeof id !== "string" || !(parentId === null || typeof parentId === "string")) {
        return { ok: false, reason: "unsafe-session-data" };
    }
    const idFailure = sourceIdentityFailure(id);
    const parentFailure = parentId === null ? undefined : sourceIdentityFailure(parentId);
    if (idFailure)
        return { ok: false, reason: idFailure };
    if (parentFailure)
        return { ok: false, reason: parentFailure };
    return { ok: true, id, parentId, type };
}
function sourcePlaceholder(id, parentId, sourceType) {
    return {
        id,
        parentId,
        kind: "source-placeholder",
        status: "completed",
        payload: { sourceType },
    };
}
function textEntry(id, parentId, kind, text, fromId) {
    const entry = {
        id,
        parentId,
        kind,
        status: "completed",
        payload: { content: { format: "text", text } },
    };
    if (fromId !== undefined) {
        return { ...entry, fromId };
    }
    return entry;
}
function sourceContentBlocks(value) {
    if (!Array.isArray(value))
        return { ok: false, reason: "unsafe-session-data" };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        !isNonNegativeSafeInteger(lengthDescriptor.value)) {
        return { ok: false, reason: "unsafe-session-data" };
    }
    const length = lengthDescriptor.value;
    if (length > MAX_CONTENT_BLOCKS)
        return { ok: false, reason: "bounds-exceeded" };
    const blocks = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            return { ok: false, reason: "unsafe-session-data" };
        }
        if (!isPlainObject(descriptor.value))
            return { ok: false, reason: "unsafe-session-data" };
        blocks.push(descriptor.value);
    }
    return { ok: true, blocks };
}
function collectTextBlocks(blocks) {
    const textParts = [];
    let utf16Length = 0;
    let utf8Length = 0;
    let previousEndsWithHighSurrogate = false;
    for (const block of blocks) {
        const blockText = readRequiredDataField(block, "text");
        if (typeof blockText !== "string") {
            return { ok: false, reason: "unsafe-session-data" };
        }
        if (blockText.length > MAX_TEXT_BYTES || utf16Length > MAX_TEXT_BYTES - blockText.length) {
            return { ok: false, reason: "bounds-exceeded" };
        }
        const blockBytes = Buffer.byteLength(blockText, "utf8");
        const joinsSurrogatePair = previousEndsWithHighSurrogate &&
            blockText.length > 0 &&
            blockText.charCodeAt(0) >= 0xdc00 &&
            blockText.charCodeAt(0) <= 0xdfff;
        const nextUtf8Length = utf8Length + blockBytes - (joinsSurrogatePair ? 2 : 0);
        if (nextUtf8Length > MAX_TEXT_BYTES) {
            return { ok: false, reason: "bounds-exceeded" };
        }
        textParts.push(blockText);
        utf16Length += blockText.length;
        utf8Length = nextUtf8Length;
        if (blockText.length > 0) {
            const lastCodeUnit = blockText.charCodeAt(blockText.length - 1);
            previousEndsWithHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
        }
    }
    const text = textParts.join("");
    return isBoundedText(text) ? { ok: true, text } : { ok: false, reason: "bounds-exceeded" };
}
function projectMessage(value) {
    if (!isPlainObject(value))
        return { kind: "placeholder", sourceType: "unsupported" };
    const role = readRequiredDataField(value, "role");
    if (typeof role !== "string")
        return { kind: "placeholder", sourceType: "unsupported" };
    if (role === "toolResult" || role === "bashExecution") {
        return { kind: "placeholder", sourceType: "tool" };
    }
    if (role === "custom")
        return { kind: "placeholder", sourceType: "custom" };
    if (role !== "user" && role !== "assistant") {
        return { kind: "placeholder", sourceType: "unsupported" };
    }
    const content = readRequiredDataField(value, "content");
    if (content === MISSING)
        return { kind: "placeholder", sourceType: "unsupported" };
    const blocksResult = role === "user" && typeof content === "string"
        ? { ok: true, blocks: [] }
        : sourceContentBlocks(content);
    if (!blocksResult.ok)
        return { kind: "failure", reason: blocksResult.reason };
    if (role === "assistant") {
        const stopReason = readRequiredDataField(value, "stopReason");
        let hasImage = false;
        let hasUnknown = false;
        let hasToolCall = false;
        const textBlocks = [];
        for (const block of blocksResult.blocks) {
            const blockType = readRequiredDataField(block, "type");
            if (blockType === "toolCall") {
                hasToolCall = true;
            }
            else if (blockType === "image") {
                hasImage = true;
            }
            else if (blockType === "thinking") {
            }
            else if (blockType === "text") {
                textBlocks.push(block);
            }
            else {
                hasUnknown = true;
            }
        }
        if (hasToolCall || stopReason === "toolUse") {
            return { kind: "placeholder", sourceType: "tool" };
        }
        if (stopReason !== "stop")
            return { kind: "placeholder", sourceType: "unsupported" };
        if (hasImage)
            return { kind: "placeholder", sourceType: "image" };
        if (hasUnknown)
            return { kind: "placeholder", sourceType: "unsupported" };
        if (textBlocks.length === 0)
            return { kind: "placeholder", sourceType: "unsupported" };
        const textResult = collectTextBlocks(textBlocks);
        if (!textResult.ok) {
            return textResult.reason === "unsafe-session-data"
                ? { kind: "placeholder", sourceType: "unsupported" }
                : { kind: "failure", reason: textResult.reason };
        }
        return { kind: "text", text: textResult.text };
    }
    if (typeof content === "string") {
        return isBoundedText(content)
            ? { kind: "text", text: content }
            : { kind: "failure", reason: "bounds-exceeded" };
    }
    let hasImage = false;
    let hasUnknown = false;
    let hasToolCall = false;
    const textBlocks = [];
    for (const block of blocksResult.blocks) {
        const blockType = readRequiredDataField(block, "type");
        if (blockType === "image") {
            hasImage = true;
        }
        else if (blockType === "toolCall") {
            hasToolCall = true;
        }
        else if (blockType === "text") {
            textBlocks.push(block);
        }
        else {
            hasUnknown = true;
        }
    }
    if (hasToolCall)
        return { kind: "placeholder", sourceType: "tool" };
    if (hasImage)
        return { kind: "placeholder", sourceType: "image" };
    if (hasUnknown)
        return { kind: "placeholder", sourceType: "unsupported" };
    if (textBlocks.length === 0)
        return { kind: "placeholder", sourceType: "unsupported" };
    const textResult = collectTextBlocks(textBlocks);
    if (!textResult.ok) {
        return textResult.reason === "unsafe-session-data"
            ? { kind: "placeholder", sourceType: "unsupported" }
            : { kind: "failure", reason: textResult.reason };
    }
    return { kind: "text", text: textResult.text };
}
function projectSourceEntry(value) {
    if (!isPlainObject(value))
        return { ok: false, reason: "unsafe-session-data" };
    const base = sourceEntryBase(value);
    if (!base.ok)
        return base;
    if (base.type === "message") {
        const message = readRequiredDataField(value, "message");
        if (message === MISSING) {
            return { ok: true, entry: sourcePlaceholder(base.id, base.parentId, "unsupported") };
        }
        const projection = projectMessage(message);
        if (projection.kind === "failure")
            return { ok: false, reason: projection.reason };
        if (projection.kind === "placeholder") {
            return {
                ok: true,
                entry: sourcePlaceholder(base.id, base.parentId, projection.sourceType),
            };
        }
        if (!isBoundedText(projection.text))
            return { ok: false, reason: "bounds-exceeded" };
        const messageRecord = isPlainObject(message) ? message : undefined;
        const role = messageRecord ? readRequiredDataField(messageRecord, "role") : MISSING;
        return {
            ok: true,
            entry: textEntry(base.id, base.parentId, role === "user" ? "user-turn" : "assistant-turn", projection.text),
        };
    }
    if (base.type === "branch_summary") {
        const summary = readRequiredDataField(value, "summary");
        const fromId = readRequiredDataField(value, "fromId");
        const fromIdFailure = sourceIdentityFailure(fromId);
        if (typeof summary !== "string" ||
            !isNonEmptyString(fromId) ||
            fromIdFailure === "unsafe-session-data") {
            return { ok: false, reason: "unsafe-session-data" };
        }
        if (fromIdFailure === "bounds-exceeded")
            return { ok: false, reason: "bounds-exceeded" };
        if (!isBoundedText(summary))
            return { ok: false, reason: "bounds-exceeded" };
        return {
            ok: true,
            entry: textEntry(base.id, base.parentId, "summary", summary, fromId),
        };
    }
    if (base.type === "compaction") {
        const summary = readRequiredDataField(value, "summary");
        const firstKeptEntryId = readRequiredDataField(value, "firstKeptEntryId");
        const firstKeptEntryIdFailure = sourceIdentityFailure(firstKeptEntryId);
        if (typeof summary !== "string" || firstKeptEntryIdFailure === "unsafe-session-data") {
            return { ok: false, reason: "unsafe-session-data" };
        }
        if (firstKeptEntryIdFailure === "bounds-exceeded") {
            return { ok: false, reason: "bounds-exceeded" };
        }
        if (!isBoundedText(summary))
            return { ok: false, reason: "bounds-exceeded" };
        return {
            ok: true,
            entry: {
                id: base.id,
                parentId: base.parentId,
                kind: "compaction",
                status: "completed",
                payload: { summary, firstKeptEntryId },
            },
        };
    }
    if (base.type === "model_change" || base.type === "thinking_level_change") {
        return { ok: true, entry: sourcePlaceholder(base.id, base.parentId, "provider") };
    }
    if (base.type === "custom" ||
        base.type === "custom_message" ||
        base.type === "label" ||
        base.type === "session_info") {
        return { ok: true, entry: sourcePlaceholder(base.id, base.parentId, "custom") };
    }
    return { ok: true, entry: sourcePlaceholder(base.id, base.parentId, "unsupported") };
}
function checkTreeStructure(entries) {
    if (entries.length > MAX_TREE_ENTRIES)
        return "bounds-exceeded";
    const parents = new Map();
    for (const entry of entries) {
        if (parents.has(entry.id))
            return "unsafe-session-data";
        parents.set(entry.id, entry.parentId);
    }
    for (const entry of entries) {
        const seen = new Set();
        let current = entry.id;
        let depth = 0;
        while (current !== null) {
            if (seen.has(current))
                return "unsafe-session-data";
            seen.add(current);
            const parent = parents.get(current);
            if (parent === undefined)
                return "unsafe-session-data";
            depth += 1;
            if (depth > MAX_TREE_DEPTH)
                return "bounds-exceeded";
            current = parent;
        }
    }
    for (const entry of entries) {
        if (entry.kind === "compaction") {
            const firstKeptEntryId = entry.payload.firstKeptEntryId;
            if (typeof firstKeptEntryId !== "string" || !parents.has(firstKeptEntryId)) {
                return "unsafe-session-data";
            }
        }
    }
    return "ok";
}
function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value))
        return value;
    Object.freeze(value);
    for (const child of Object.values(value))
        deepFreeze(child);
    return value;
}
function envelopeByteLength(envelope) {
    return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}
export function projectSessionMirrorSnapshot(sessionManager, metadata) {
    let validatedMetadata;
    try {
        const metadataResult = validateMetadata(metadata);
        if (!metadataResult.ok)
            return failure(metadataResult.reason);
        validatedMetadata = metadataResult.value;
    }
    catch {
        return failure("invalid-metadata");
    }
    if (sessionManager === null || typeof sessionManager !== "object") {
        return failure("session-unavailable");
    }
    let sessionFile;
    let sessionId;
    let activeLeafId;
    let sourceEntries;
    try {
        const getSessionFile = readSessionManagerMethod(sessionManager, "getSessionFile");
        const getSessionId = readSessionManagerMethod(sessionManager, "getSessionId");
        const getLeafId = readSessionManagerMethod(sessionManager, "getLeafId");
        const getEntries = readSessionManagerMethod(sessionManager, "getEntries");
        if (!getSessionFile || !getSessionId || !getLeafId || !getEntries) {
            return failure("session-unavailable");
        }
        sessionFile = getSessionFile.call(sessionManager);
        if (typeof sessionFile !== "string" || sessionFile.length === 0) {
            return failure("session-unavailable");
        }
        sessionId = getSessionId.call(sessionManager);
        activeLeafId = getLeafId.call(sessionManager);
        sourceEntries = getEntries.call(sessionManager);
    }
    catch {
        return failure("session-unavailable");
    }
    if (!isNonEmptyString(sessionId))
        return failure("unsafe-session-data");
    const sessionIdFailure = sourceIdentityFailure(sessionId);
    if (sessionIdFailure)
        return failure(sessionIdFailure);
    let sourceEntriesIsArray;
    try {
        sourceEntriesIsArray = Array.isArray(sourceEntries);
    }
    catch {
        return failure("unsafe-session-data");
    }
    if (!sourceEntriesIsArray)
        return failure("unsafe-session-data");
    if (!(activeLeafId === null || typeof activeLeafId === "string")) {
        return failure("unsafe-session-data");
    }
    if (typeof activeLeafId === "string") {
        const activeLeafFailure = sourceIdentityFailure(activeLeafId);
        if (activeLeafFailure)
            return failure(activeLeafFailure);
    }
    let sourceEntryValues;
    try {
        const sourceEntriesArray = sourceEntries;
        const lengthDescriptor = Object.getOwnPropertyDescriptor(sourceEntriesArray, "length");
        if (!lengthDescriptor ||
            !("value" in lengthDescriptor) ||
            !isNonNegativeSafeInteger(lengthDescriptor.value)) {
            return failure("unsafe-session-data");
        }
        const sourceEntryCount = lengthDescriptor.value;
        if (sourceEntryCount > MAX_TREE_ENTRIES)
            return failure("bounds-exceeded");
        const values = [];
        for (let index = 0; index < sourceEntryCount; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(sourceEntriesArray, String(index));
            if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
                return failure("unsafe-session-data");
            }
            values.push(descriptor.value);
        }
        sourceEntryValues = values;
    }
    catch {
        return failure("unsafe-session-data");
    }
    const projectedEntries = [];
    let serializedEntryBytes = 0;
    try {
        for (const sourceEntry of sourceEntryValues) {
            const projected = projectSourceEntry(sourceEntry);
            if (!projected.ok)
                return failure(projected.reason);
            const serializedPayload = JSON.stringify(projected.entry.payload);
            if (serializedPayload === undefined ||
                Buffer.byteLength(serializedPayload, "utf8") > MAX_ENTRY_PAYLOAD_BYTES) {
                return failure("bounds-exceeded");
            }
            const serializedEntry = JSON.stringify(projected.entry);
            if (serializedEntry === undefined)
                return failure("unsafe-session-data");
            serializedEntryBytes += Buffer.byteLength(serializedEntry, "utf8");
            if (serializedEntryBytes > MAX_ENVELOPE_BYTES)
                return failure("bounds-exceeded");
            projectedEntries.push(projected.entry);
        }
    }
    catch {
        return failure("unsafe-session-data");
    }
    const treeCheck = checkTreeStructure(projectedEntries);
    if (treeCheck !== "ok")
        return failure(treeCheck);
    const entryIds = new Set(projectedEntries.map((entry) => entry.id));
    if (projectedEntries.length === 0) {
        if (activeLeafId !== null)
            return failure("unsafe-session-data");
    }
    else if (activeLeafId !== null && !entryIds.has(activeLeafId)) {
        return failure("unsafe-session-data");
    }
    const rootIds = projectedEntries
        .filter((entry) => entry.parentId === null)
        .map((entry) => entry.id);
    const envelope = {
        protocol: { family: "session-mirror", major: 1, minor: 0 },
        source: {
            runtimeVersion: validatedMetadata.runtimeVersion,
            sessionSchemaVersion: validatedMetadata.sessionSchemaVersion,
        },
        sessionId,
        capabilities: [
            "session-tree",
            "completed-turns-only",
            "snapshot",
            "cursor-recovery",
            "custom-entries",
            "coarse-status",
        ],
        message: {
            kind: "snapshot",
            eventId: validatedMetadata.eventId,
            revision: validatedMetadata.revision,
            cursor: validatedMetadata.cursor,
            operation: "replace",
            snapshot: {
                snapshotId: validatedMetadata.snapshotId,
                status: validatedMetadata.status,
                tree: {
                    rootIds,
                    activeLeafId,
                    entries: projectedEntries,
                },
            },
        },
    };
    try {
        if (envelopeByteLength(envelope) > MAX_ENVELOPE_BYTES)
            return failure("bounds-exceeded");
        return deepFreeze({ ok: true, envelope: deepFreeze(envelope) });
    }
    catch {
        return failure("unsafe-session-data");
    }
}
