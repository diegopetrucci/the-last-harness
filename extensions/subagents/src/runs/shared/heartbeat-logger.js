import * as fs from "node:fs";
import * as path from "node:path";
export function createHeartbeatLogger(logPath, deps = {}) {
    if (!logPath) {
        return { append() { } };
    }
    const mkdir = deps.mkdirSync ?? ((dir, options) => fs.mkdirSync(dir, options));
    const appendFile = deps.appendFileSync ?? ((file, data) => fs.appendFileSync(file, data));
    return {
        append(record) {
            try {
                mkdir(path.dirname(logPath), { recursive: true });
                appendFile(logPath, JSON.stringify(record) + "\n");
            }
            catch {
            }
        },
    };
}
