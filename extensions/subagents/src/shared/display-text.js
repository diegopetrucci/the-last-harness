export const BINARY_CONTENT_PLACEHOLDER = "[binary content]";
const BINARY_DENSITY_THRESHOLD = 0.5;
function isUnsafeControlCode(codePoint) {
    return ((codePoint >= 0x01 && codePoint <= 0x08) ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f ||
        (codePoint >= 0x80 && codePoint <= 0x9f));
}
function isWhitespace(character) {
    return /\s/u.test(character);
}
function sanitizeTerminalDocument(input) {
    const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let cleaned = "";
    let unsafeCount = 0;
    let bareControlPending = false;
    const length = normalized.length;
    const appendVisible = (character) => {
        const previous = cleaned[cleaned.length - 1];
        if (bareControlPending &&
            previous !== undefined &&
            !isWhitespace(previous) &&
            !isWhitespace(character)) {
            cleaned += " ";
        }
        cleaned += character;
        bareControlPending = false;
    };
    for (let index = 0; index < length; index++) {
        const codePoint = normalized.charCodeAt(index);
        if (codePoint === 0x1b) {
            unsafeCount++;
            const next = normalized.charCodeAt(index + 1);
            if (next === 0x5b) {
                index++;
                while (index + 1 < length) {
                    index++;
                    const finalCode = normalized.charCodeAt(index);
                    if (finalCode >= 0x40 && finalCode <= 0x7e)
                        break;
                }
            }
            else if (next === 0x5d) {
                index++;
                while (index + 1 < length) {
                    index++;
                    const sequenceCode = normalized.charCodeAt(index);
                    if (sequenceCode === 0x07)
                        break;
                    if (sequenceCode === 0x1b && normalized.charCodeAt(index + 1) === 0x5c) {
                        index++;
                        break;
                    }
                }
            }
            continue;
        }
        if (codePoint === 0x9b) {
            unsafeCount++;
            while (index + 1 < length) {
                index++;
                const finalCode = normalized.charCodeAt(index);
                if (finalCode >= 0x40 && finalCode <= 0x7e)
                    break;
            }
            continue;
        }
        if (codePoint === 0x9d) {
            unsafeCount++;
            while (index + 1 < length) {
                index++;
                const sequenceCode = normalized.charCodeAt(index);
                if (sequenceCode === 0x07 || sequenceCode === 0x9c)
                    break;
                if (sequenceCode === 0x1b && normalized.charCodeAt(index + 1) === 0x5c) {
                    index++;
                    break;
                }
            }
            continue;
        }
        if (codePoint === 0x00 || isUnsafeControlCode(codePoint)) {
            unsafeCount++;
            bareControlPending = true;
            continue;
        }
        appendVisible(normalized[index]);
    }
    return { normalized, cleaned, unsafeCount };
}
export function safeTerminalText(input) {
    const sanitized = sanitizeTerminalDocument(input);
    if (sanitized.normalized.includes("\x00") ||
        (sanitized.normalized.length > 0 &&
            sanitized.unsafeCount / sanitized.normalized.length > BINARY_DENSITY_THRESHOLD)) {
        return BINARY_CONTENT_PLACEHOLDER;
    }
    return sanitized.cleaned;
}
export function safeTerminalDocument(input) {
    return sanitizeTerminalDocument(input).cleaned;
}
