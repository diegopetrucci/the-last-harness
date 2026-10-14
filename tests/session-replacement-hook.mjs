import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const targetPath = process.env.TLH_TEST_SESSION_PATH;
const replacementPath = process.env.TLH_TEST_REPLACEMENT_PATH;
if (targetPath === undefined || replacementPath === undefined) {
  throw new Error("session replacement hook requires both fixture paths");
}

const originalCreateReadStream = fs.createReadStream;
let replaced = false;
fs.createReadStream = function createReadStream(...args) {
  const stream = originalCreateReadStream.apply(this, args);
  if (!replaced && String(args[0]) === targetPath) {
    stream.once("open", () => {
      fs.renameSync(replacementPath, targetPath);
      replaced = true;
    });
  }
  return stream;
};
syncBuiltinESMExports();
