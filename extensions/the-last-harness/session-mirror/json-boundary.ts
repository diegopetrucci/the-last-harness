// JSON.parse keeps the last duplicate member. Scan object scopes before parsing.
export function hasDuplicateJsonKeys(text: unknown): boolean {
  try {
    if (typeof text !== "string" || text.length > 16 * 1024) return true;
    let index = 0;
    let invalid = false;
    const whitespace = (): void => {
      while (/\s/.test(text[index] ?? "")) index += 1;
    };
    const string = (): string | undefined => {
      if (text[index] !== '"') return undefined;
      const start = index++;
      while (index < text.length) {
        const character = text[index++];
        if (character === "\\") index += 1;
        else if (character === '"') {
          const decoded: unknown = JSON.parse(text.slice(start, index));
          return typeof decoded === "string" ? decoded : undefined;
        }
      }
      return undefined;
    };
    const value = (): void => {
      whitespace();
      if (text[index] === "{") object();
      else if (text[index] === "[") array();
      else if (text[index] === '"') {
        if (string() === undefined) invalid = true;
      } else {
        const start = index;
        while (index < text.length && !",]}".includes(text[index] ?? "")) index += 1;
        if (start === index) invalid = true;
      }
    };
    const object = (): void => {
      index += 1;
      whitespace();
      const keys = new Set<string>();
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
        if (keys.has(key)) invalid = true;
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
    const array = (): void => {
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
  } catch {
    return true;
  }
}
