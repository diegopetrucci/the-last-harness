import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LANES, selectLanes } from "../scripts/run-ci-validation.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

// ---------------------------------------------------------------------------
// selectLanes: happy paths
// ---------------------------------------------------------------------------

test("selectLanes: no args returns all lanes", () => {
  const result = selectLanes(LANES, []);
  assert.deepStrictEqual(result, LANES);
});

test("selectLanes: --lanes= form selects named lanes", () => {
  const result = selectLanes(LANES, ["--lanes=lint"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "lint");
});

test("selectLanes: --lanes space form selects named lanes", () => {
  const result = selectLanes(LANES, ["--lanes", "lint"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "lint");
});

test("selectLanes: --lanes= with multiple lanes selects all named", () => {
  const result = selectLanes(LANES, ["--lanes=lint,pkg"]);
  assert.equal(result.length, 2);
  assert.deepStrictEqual(
    result.map((l) => l.name),
    ["lint", "pkg"],
  );
});

test("selectLanes: --exclude= form excludes named lane and returns the rest", () => {
  const result = selectLanes(LANES, ["--exclude=lint"]);
  assert.equal(result.length, LANES.length - 1);
  assert.ok(!result.some((l) => l.name === "lint"));
});

test("selectLanes: --exclude space form excludes named lane", () => {
  const result = selectLanes(LANES, ["--exclude", "lint"]);
  assert.equal(result.length, LANES.length - 1);
  assert.ok(!result.some((l) => l.name === "lint"));
});

test("selectLanes: --exclude= with multiple lanes excludes all named", () => {
  const result = selectLanes(LANES, ["--exclude=lint,pkg"]);
  assert.equal(result.length, LANES.length - 2);
  assert.ok(!result.some((l) => l.name === "lint" || l.name === "pkg"));
});

// ---------------------------------------------------------------------------
// selectLanes: error cases
// ---------------------------------------------------------------------------

test("selectLanes: unknown lane name in --lanes throws with actionable message", () => {
  assert.throws(
    () => selectLanes(LANES, ["--lanes=nonexistent"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("nonexistent"),
        `message should name the unknown lane: ${err.message}`,
      );
      assert.ok(
        err.message.includes("Valid lanes"),
        `message should list valid lanes: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: unknown lane name in --exclude throws with actionable message", () => {
  assert.throws(
    () => selectLanes(LANES, ["--exclude=nonexistent"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("nonexistent"),
        `message should name the unknown lane: ${err.message}`,
      );
      assert.ok(
        err.message.includes("Valid lanes"),
        `message should list valid lanes: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: --lanes and --exclude together throws", () => {
  assert.throws(
    () => selectLanes(LANES, ["--lanes=lint", "--exclude=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("mutually exclusive"),
        `message should say mutually exclusive: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: --exclude all lanes throws for empty selection", () => {
  const allNames = LANES.map((l) => l.name).join(",");
  assert.throws(
    () => selectLanes(LANES, [`--exclude=${allNames}`]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("zero lanes"),
        `message should mention zero lanes: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: unknown flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(LANES, ["--unknown-flag"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("--unknown-flag"),
        `message should name the unknown flag: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: --lanes with no value throws", () => {
  assert.throws(
    () => selectLanes(LANES, ["--lanes"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("requires a value"),
        `message should say requires a value: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: --exclude with no value throws", () => {
  assert.throws(
    () => selectLanes(LANES, ["--exclude"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("requires a value"),
        `message should say requires a value: ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: repeated --lanes flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(LANES, ["--lanes=lint", "--lanes=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--lanes"), `message should mention --lanes: ${err.message}`);
      assert.ok(
        err.message.toLowerCase().includes("more than once"),
        `message should say 'more than once': ${err.message}`,
      );
      return true;
    },
  );
});

test("selectLanes: repeated --exclude flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(LANES, ["--exclude=lint", "--exclude=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("--exclude"),
        `message should mention --exclude: ${err.message}`,
      );
      assert.ok(
        err.message.toLowerCase().includes("more than once"),
        `message should say 'more than once': ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// CI coverage: every lane in LANES is covered by exactly one ci.yml job
// ---------------------------------------------------------------------------

/**
 * Parse all run-ci-validation.mjs invocations from the CI workflow YAML text
 * (no YAML parser — we scan lines for the script name and extract lane flags).
 *
 * Fail-closed rules:
 *   - Lines whose trimmed form starts with '#' are YAML comments; skip them.
 *   - A line that contains the script name more than once is ambiguous; throw.
 *   - Unknown '--' flags (not '--lanes' or '--exclude') are rejected; throw.
 *   - '--lanes' or '--exclude' present but value cannot be parsed; throw.
 *   - Both '--lanes' and '--exclude' on the same line; throw.
 *
 * Returns an array of objects { line, claimed } where `claimed` is the array
 * of LANES lane names that invocation covers:
 *   --lanes=a,b   → ["a", "b"]   (= form)
 *   --lanes a,b   → ["a", "b"]   (space form)
 *   --exclude=a,b → all lane names except ["a", "b"]
 *   (no flag)     → all lane names
 *
 * @param {string} workflowText
 * @param {string[]} allLaneNames
 * @returns {{ line: string; claimed: string[] }[]}
 */
function parseWorkflowInvocations(workflowText, allLaneNames) {
  const results = [];
  for (const rawLine of workflowText.split("\n")) {
    if (!rawLine.includes("run-ci-validation.mjs")) continue;
    const line = rawLine.trim();
    // Fail closed: skip YAML comment lines.
    if (line.startsWith("#")) continue;
    // Fail closed: reject a line with the script name more than once (ambiguous).
    const occurrences = (line.match(/run-ci-validation\.mjs/g) ?? []).length;
    if (occurrences > 1) {
      throw new Error(
        `parseWorkflowInvocations: line contains 'run-ci-validation.mjs' more than once ` +
          `(ambiguous — cannot safely determine coverage): ${line}`,
      );
    }
    // Detect unknown '--' flags. Split on whitespace, strip any '=value' suffix.
    const unknownFlags = line
      .split(/\s+/)
      .filter((t) => t.startsWith("--"))
      .map((t) => (t.includes("=") ? t.split("=")[0] : t))
      .filter((t) => t !== "--lanes" && t !== "--exclude");
    if (unknownFlags.length > 0) {
      throw new Error(
        `parseWorkflowInvocations: unrecognized flag(s) on run-ci-validation.mjs line ` +
          `(fail closed — cannot safely determine coverage): ${unknownFlags.join(", ")} in: ${line}`,
      );
    }
    // Parse flags — support both '=' form (--lanes=x) and space form (--lanes x).
    // Value must not start with '-' to avoid capturing the next flag as the value.
    const lanesMatch = /--lanes(?:=|\s+)([^-\s][^\s]*)/.exec(line);
    const excludeMatch = /--exclude(?:=|\s+)([^-\s][^\s]*)/.exec(line);
    // Fail closed: if the flag keyword appears but its value could not be parsed, reject.
    if (line.includes("--lanes") && !lanesMatch) {
      throw new Error(
        `parseWorkflowInvocations: '--lanes' flag found but its value could not be parsed ` +
          `(fail closed): ${line}`,
      );
    }
    if (line.includes("--exclude") && !excludeMatch) {
      throw new Error(
        `parseWorkflowInvocations: '--exclude' flag found but its value could not be parsed ` +
          `(fail closed): ${line}`,
      );
    }
    let claimed;
    if (lanesMatch && excludeMatch) {
      throw new Error(
        `parseWorkflowInvocations: line has both '--lanes' and '--exclude' flags (ambiguous): ${line}`,
      );
    } else if (lanesMatch) {
      claimed = lanesMatch[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    } else if (excludeMatch) {
      const excluded = excludeMatch[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      claimed = allLaneNames.filter((n) => !excluded.includes(n));
    } else {
      // No flags: the script runs all lanes.
      claimed = [...allLaneNames];
    }
    results.push({ line, claimed });
  }
  return results;
}

// ---------------------------------------------------------------------------
// parseWorkflowInvocations: unit tests using synthetic workflow text
// ---------------------------------------------------------------------------

test("parseWorkflowInvocations: commented-out invocation does not contribute coverage (guard fails for missing lint)", () => {
  const allLaneNames = LANES.map((l) => l.name);
  // Simulate: lint job's run line is commented out; validation job uses --exclude=lint.
  const syntheticText = [
    "          # node scripts/run-ci-validation.mjs --lanes=lint",
    "          node scripts/run-ci-validation.mjs --exclude=lint",
  ].join("\n");
  const invocations = parseWorkflowInvocations(syntheticText, allLaneNames);
  // Only the --exclude=lint invocation is parsed (comment skipped).
  assert.equal(invocations.length, 1, "comment line must be skipped");
  // Reproduce the coverage-check logic to prove lint is reported missing.
  const seen = new Map();
  for (const { line, claimed } of invocations) {
    for (const name of claimed) seen.set(name, line);
  }
  const missing = allLaneNames.filter((n) => !seen.has(n));
  assert.deepStrictEqual(
    missing,
    ["lint"],
    "lint lane must be reported missing when its invocation is commented out — the guard would fail",
  );
});

test("parseWorkflowInvocations: line with two run-ci-validation.mjs occurrences throws", () => {
  const allLaneNames = LANES.map((l) => l.name);
  const ambiguousLine =
    "node scripts/run-ci-validation.mjs --lanes=lint && node scripts/run-ci-validation.mjs --lanes=pkg";
  assert.throws(
    () => parseWorkflowInvocations(ambiguousLine, allLaneNames),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("more than once"),
        `message should mention 'more than once': ${err.message}`,
      );
      return true;
    },
  );
});

test("parseWorkflowInvocations: space-form '--lanes lint' is parsed equivalently to '--lanes=lint'", () => {
  const allLaneNames = LANES.map((l) => l.name);
  const eqForm = "node scripts/run-ci-validation.mjs --lanes=lint";
  const spaceForm = "node scripts/run-ci-validation.mjs --lanes lint";
  const eqResult = parseWorkflowInvocations(eqForm, allLaneNames);
  const spaceResult = parseWorkflowInvocations(spaceForm, allLaneNames);
  assert.equal(eqResult.length, 1);
  assert.equal(spaceResult.length, 1);
  assert.deepStrictEqual(
    spaceResult[0].claimed,
    eqResult[0].claimed,
    "space-form and =-form must produce the same claimed lanes",
  );
  assert.deepStrictEqual(eqResult[0].claimed, ["lint"]);
});

test("parseWorkflowInvocations: space-form '--exclude lint' is parsed equivalently to '--exclude=lint'", () => {
  const allLaneNames = LANES.map((l) => l.name);
  const eqForm = "node scripts/run-ci-validation.mjs --exclude=lint";
  const spaceForm = "node scripts/run-ci-validation.mjs --exclude lint";
  const eqResult = parseWorkflowInvocations(eqForm, allLaneNames);
  const spaceResult = parseWorkflowInvocations(spaceForm, allLaneNames);
  assert.equal(eqResult.length, 1);
  assert.equal(spaceResult.length, 1);
  assert.deepStrictEqual(
    spaceResult[0].claimed,
    eqResult[0].claimed,
    "space-form and =-form must produce the same claimed lanes",
  );
  assert.ok(!eqResult[0].claimed.includes("lint"), "lint must be excluded");
});

test("parseWorkflowInvocations: unknown flag causes throw (fail closed)", () => {
  const allLaneNames = LANES.map((l) => l.name);
  const lineWithUnknownFlag = "node scripts/run-ci-validation.mjs --unknown-flag=foo";
  assert.throws(
    () => parseWorkflowInvocations(lineWithUnknownFlag, allLaneNames),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("--unknown-flag"),
        `message should name the unknown flag: ${err.message}`,
      );
      return true;
    },
  );
});

test("parseWorkflowInvocations: --lanes without a parseable value throws (fail closed)", () => {
  const allLaneNames = LANES.map((l) => l.name);
  // --lanes at end of line with no value.
  const incompleteFlag = "node scripts/run-ci-validation.mjs --lanes";
  assert.throws(
    () => parseWorkflowInvocations(incompleteFlag, allLaneNames),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--lanes"), `message should mention --lanes: ${err.message}`);
      return true;
    },
  );
});

test("CI workflow: every lane in LANES is covered by exactly one ci.yml job (no lane silently dropped or duplicated)", () => {
  const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
  const workflowText = readFileSync(workflowPath, "utf8");

  const allLaneNames = LANES.map((l) => l.name);
  const invocations = parseWorkflowInvocations(workflowText, allLaneNames);

  assert.ok(
    invocations.length > 0,
    "No run-ci-validation.mjs invocations found in ci.yml — workflow may be misconfigured",
  );

  // Check for duplicates: each lane must appear in exactly one invocation.
  /** @type {Map<string, string>} lane name → first invocation line */
  const seen = new Map();
  /** @type {string[]} */
  const duplicates = [];

  for (const { line, claimed } of invocations) {
    for (const name of claimed) {
      if (seen.has(name)) {
        duplicates.push(`"${name}" is claimed by both "${seen.get(name)}" and "${line}"`);
      } else {
        seen.set(name, line);
      }
    }
  }

  const missing = allLaneNames.filter((n) => !seen.has(n));

  assert.deepStrictEqual(
    duplicates,
    [],
    [
      "Some lanes are claimed by more than one ci.yml job:",
      ...duplicates.map((d) => `  ${d}`),
    ].join("\n"),
  );

  assert.deepStrictEqual(
    missing,
    [],
    [
      "Some lanes in LANES are not covered by any ci.yml job:",
      ...missing.map((n) => `  ${n}`),
      "Invocations found:",
      ...invocations.map((i) => `  ${i.line} → [${i.claimed.join(", ")}]`),
    ].join("\n"),
  );
});
