import fs from "node:fs";

/** @param {string} filePath @param {unknown} value */
export function writeAtomicJson(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf-8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the publication error if cleanup also fails.
    }
    throw error;
  }
}
