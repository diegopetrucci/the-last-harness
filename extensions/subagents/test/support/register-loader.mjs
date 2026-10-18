/**
 * Register the .js → .ts loader hook for source-loading tests.
 *
 * Usage (from extensions/subagents):
 *   node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 * Usage (from repo root):
 *   node --experimental-strip-types --import ./extensions/subagents/test/support/register-loader.mjs --test <file>
 *
 * Source files use .js import extensions (TypeScript ESM convention) but files
 * on disk are .ts — the loader rewrites .js → .ts at resolve time. Keep loaded
 * sources compatible with Node's strip-types mode.
 */

import { registerHooks } from "node:module";
import { resolve } from "./ts-loader.mjs";

// In-thread synchronous hooks (module.register() is deprecated: DEP0205).
registerHooks({ resolve });

// Isolate test runs onto a per-process temp root (issue #45). Shared with
// unit tests via isolate-temp-root.mjs.
import "./isolate-temp-root.mjs";
