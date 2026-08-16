import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { LANES } from "../scripts/run-ci-validation.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten all commands from all lanes into a single list of argv arrays.
 *
 * @returns {string[][]}
 */
function allCommands() {
  return LANES.flatMap((lane) => lane.commands);
}

/**
 * Return a compact display string for an argv array, reducing absolute .mjs
 * paths to their basename (mirrors spawnBuffered's _displayArg logic).
 *
 * @param {string[]} argv
 * @returns {string}
 */
function displayCmd(argv) {
  return argv.map((a) => (/^\/.+\.(mjs|js|cjs)$/.test(a) ? basename(a) : a)).join(" ");
}

/**
 * Canonical string for a command argv, suitable for stable set comparison:
 *  - process.execPath is normalised to "node"
 *  - absolute .mjs / .js / .cjs paths are reduced to their basename
 *
 * @param {string[]} argv
 * @returns {string}
 */
function canonicalCmd(argv) {
  return argv
    .map((a) => {
      if (a === process.execPath) return "node";
      if (/^\/.+\.(mjs|js|cjs)$/.test(a)) return basename(a);
      return a;
    })
    .join(" ");
}

/**
 * Check that at least one command in `allCommands()` matches `predicate`.
 *
 * @param {(argv: string[]) => boolean} predicate
 * @param {string} description - shown in assertion failures
 */
function assertHasCommand(predicate, description) {
  const commands = allCommands();
  const found = commands.some(predicate);
  assert.ok(
    found,
    `Expected to find command matching "${description}" in lane definitions.\n` +
      `All commands:\n${commands.map((c) => `  ${displayCmd(c)}`).join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Coverage: all 11 checks must be present (the no-dropped-check gate)
// ---------------------------------------------------------------------------

test("LANES: npm run check:package-versions is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("check:package-versions"),
    "npm run check:package-versions",
  );
});

test("LANES: npm run check:package-contents is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("check:package-contents"),
    "npm run check:package-contents",
  );
});

test("LANES: npm run typecheck is present", () => {
  assertHasCommand(
    (c) =>
      c.includes("npm") &&
      c.includes("run") &&
      c.includes("typecheck") &&
      !c.some((a) => a.includes(":")),
    "npm run typecheck",
  );
});

test("LANES: npm run typecheck:runtime is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("typecheck:runtime"),
    "npm run typecheck:runtime",
  );
});

test("LANES: npm run check:runtime is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("check:runtime"),
    "npm run check:runtime",
  );
});

test("LANES: bash scripts/check-installer-smoke.sh is present", () => {
  assertHasCommand(
    (c) => c[0] === "bash" && c.some((a) => a.includes("check-installer-smoke.sh")),
    "bash scripts/check-installer-smoke.sh",
  );
});

test("LANES: zero-warning Oxlint enforcement flows through npm run lint", () => {
  assertHasCommand(
    (c) => c.length === 3 && c[0] === "npm" && c[1] === "run" && c[2] === "lint",
    "npm run lint",
  );
  assert.equal(
    allCommands().filter((c) => c.includes("--deny-warnings")).length,
    0,
    "CI must not duplicate the npm lint script's Oxlint enforcement flag",
  );
});

test("LANES: npm run format:check is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("format:check"),
    "npm run format:check",
  );
});

test("LANES: npm run lint:sh is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("run") && c.includes("lint:sh"),
    "npm run lint:sh",
  );
});

test("LANES: node scripts/merge-settings.mjs --dry-run is present", () => {
  assertHasCommand(
    (c) => c.some((a) => a.includes("merge-settings.mjs")) && c.includes("--dry-run"),
    "node scripts/merge-settings.mjs --dry-run",
  );
});

test("LANES: npm pack --dry-run is present", () => {
  assertHasCommand(
    (c) => c.includes("npm") && c.includes("pack") && c.includes("--dry-run"),
    "npm pack --dry-run",
  );
});

// ---------------------------------------------------------------------------
// Coverage: exact command set matches the 11 canonical checks (no check silently
// added or removed). A set comparison is used so a failure names the offending
// command rather than reporting a bare count mismatch.
// ---------------------------------------------------------------------------

/**
 * The 11 canonical check commands that must be present in LANES, in sorted
 * order. Uses the same normalisation as canonicalCmd (process.execPath → "node",
 * absolute .mjs paths → basename).
 *
 * typecheck:subagents-test-support was removed: the root tsconfig now covers
 * extensions/subagents/test directly, so the dedicated support-only target is
 * redundant. typecheck subsumes all subagent test files.
 */
const EXPECTED_COMMANDS_SORTED = [
  "bash scripts/check-installer-smoke.sh",
  "node merge-settings.mjs --dry-run",
  "npm pack --dry-run",
  "npm run check:package-contents",
  "npm run check:package-versions",
  "npm run check:runtime",
  "npm run format:check",
  "npm run lint",
  "npm run lint:sh",
  "npm run typecheck",
  "npm run typecheck:runtime",
];

test("LANES: command set matches the 11 expected canonical commands (no check silently added or removed)", () => {
  const actualSorted = allCommands().map(canonicalCmd).sort();
  const missing = EXPECTED_COMMANDS_SORTED.filter((c) => !actualSorted.includes(c));
  const extra = actualSorted.filter((c) => !EXPECTED_COMMANDS_SORTED.includes(c));
  assert.deepStrictEqual(
    actualSorted,
    EXPECTED_COMMANDS_SORTED,
    [
      "LANES command set does not match the 11 expected canonical commands.",
      ...(missing.length > 0 ? [`  Missing: ${missing.join(", ")}`] : []),
      ...(extra.length > 0 ? [`  Extra:   ${extra.join(", ")}`] : []),
      `  Actual commands:\n${actualSorted.map((c) => `    ${c}`).join("\n")}`,
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// Structure: Ox and ShellCheck validation stay sequential in one lane
// ---------------------------------------------------------------------------

test("LANES: Oxlint, Oxfmt, and ShellCheck checks are sequential in the lint lane", () => {
  const lintLane = LANES.find((lane) => lane.name === "lint");
  assert.ok(lintLane, "lint lane must be present");
  assert.deepStrictEqual(lintLane.commands, [
    ["npm", "run", "lint"],
    ["npm", "run", "format:check"],
    ["npm", "run", "lint:sh"],
  ]);
});

// ---------------------------------------------------------------------------
// Structure: typecheck:runtime and check:runtime are in separate lanes
// ---------------------------------------------------------------------------

test("LANES: typecheck:runtime and check:runtime are in separate lanes (ticket requirement)", () => {
  const rtLanes = LANES.filter((lane) =>
    lane.commands.some((c) => c.includes("typecheck:runtime") || c.includes("check:runtime")),
  );
  // They must not share the same lane.
  const hasRt = (lane) => lane.commands.some((c) => c.includes("typecheck:runtime"));
  const hasCheckRt = (lane) => lane.commands.some((c) => c.includes("check:runtime"));
  for (const lane of rtLanes) {
    assert.ok(
      !(hasRt(lane) && hasCheckRt(lane)),
      `typecheck:runtime and check:runtime must be in separate lanes, but both are in lane "${lane.name}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Structure: all lanes have non-empty names and at least one command
// ---------------------------------------------------------------------------

test("LANES: every lane has a non-empty name", () => {
  for (const lane of LANES) {
    assert.ok(
      typeof lane.name === "string" && lane.name.length > 0,
      `Lane has empty or missing name: ${JSON.stringify(lane)}`,
    );
  }
});

test("LANES: every lane has at least one command", () => {
  for (const lane of LANES) {
    assert.ok(
      Array.isArray(lane.commands) && lane.commands.length > 0,
      `Lane "${lane.name}" has no commands`,
    );
  }
});

test("LANES: every command is a non-empty string array", () => {
  for (const lane of LANES) {
    for (const cmd of lane.commands) {
      assert.ok(
        Array.isArray(cmd) && cmd.length > 0,
        `Lane "${lane.name}" has an invalid command: ${JSON.stringify(cmd)}`,
      );
      for (const arg of cmd) {
        assert.equal(
          typeof arg,
          "string",
          `Lane "${lane.name}" command has non-string arg: ${JSON.stringify(cmd)}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Structure: lane names are unique
// ---------------------------------------------------------------------------

test("LANES: lane names are unique", () => {
  const names = LANES.map((l) => l.name);
  const unique = new Set(names);
  assert.equal(
    unique.size,
    names.length,
    `Duplicate lane names found: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`,
  );
});
