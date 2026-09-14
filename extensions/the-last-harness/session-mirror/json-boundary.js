export function hasDuplicateJsonKeys(text) {
    try {
        if (typeof text !== "string" || text.length > 16 * 1024)
            return true;
        let index = 0;
        let invalid = false;
        const whitespace = () => {
            while (/\s/.test(text[index] ?? ""))
                index += 1;
        };
        const string = () => {
            if (text[index] !== '"')
                return undefined;
            const start = index++;
            while (index < text.length) {
                const character = text[index++];
                if (character === "\\")
                    index += 1;
                else if (character === '"') {
                    const decoded = JSON.parse(text.slice(start, index));
                    return typeof decoded === "string" ? decoded : undefined;
                }
            }
            return undefined;
        };
        const value = () => {
            whitespace();
            if (text[index] === "{")
                object();
            else if (text[index] === "[")
                array();
            else if (text[index] === '"') {
                if (string() === undefined)
                    invalid = true;
            }
            else {
                const start = index;
                while (index < text.length && !",]}".includes(text[index] ?? ""))
                    index += 1;
                if (start === index)
                    invalid = true;
            }
        };
        const object = () => {
            index += 1;
            whitespace();
            const keys = new Set();
            if (text[index] === "}") {
                index += 1;
                return;
            }
            while (index < text.length && !invalid) {
                whitespace();
                const key = string();
                if (key === undefined) {
                    invalid = true;
                    return;
                }
                if (keys.has(key))
                    invalid = true;
                keys.add(key);
                whitespace();
                if (text[index++] !== ":") {
                    invalid = true;
                    return;
                }
                value();
                whitespace();
                if (text[index] === "}") {
                    index += 1;
                    return;
                }
                if (text[index++] !== ",") {
                    invalid = true;
                    return;
                }
            }
            invalid = true;
        };
        const array = () => {
            index += 1;
            whitespace();
            if (text[index] === "]") {
                index += 1;
                return;
            }
            while (index < text.length && !invalid) {
                value();
                whitespace();
                if (text[index] === "]") {
                    index += 1;
                    return;
                }
                if (text[index++] !== ",") {
                    invalid = true;
                    return;
                }
            }
            invalid = true;
        };
        value();
        whitespace();
        return invalid || index !== text.length;
    }
    catch {
        return true;
    }
}
