/**
 * Register the .js → .ts loader hook for source-loading tests.
 *
 * Usage: node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Source files use .js import extensions (TypeScript ESM convention) but files
 * on disk are .ts — the loader rewrites .js → .ts at resolve time. Keep loaded
 * sources compatible with Node's strip-types mode.
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));

// Isolate test runs onto a per-process temp root (issue #45). Shared with
// unit tests via isolate-temp-root.mjs.
import "./isolate-temp-root.mjs";
