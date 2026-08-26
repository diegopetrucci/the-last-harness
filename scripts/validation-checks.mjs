/**
 * Canonical inventory of production validation checks.
 *
 * Keep the manifest declaration grouped by the existing CI lane order so CI's
 * lane selection remains stable. `order` is the contributor-facing sequential
 * order and is deliberately independent of that declaration order.
 */

const CHECK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Every command that validates the production package without running tests.
 *
 * @type {ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>}
 */
export const VALIDATION_CHECKS = Object.freeze(
  [
    {
      id: "check-installer-smoke",
      argv: ["bash", "scripts/check-installer-smoke.sh"],
      lane: "smoke",
      order: 7,
    },
    {
      id: "typecheck-runtime",
      argv: ["npm", "run", "typecheck:runtime"],
      lane: "typecheck-rt",
      order: 5,
    },
    {
      id: "check-runtime",
      argv: ["npm", "run", "check:runtime"],
      lane: "check-rt",
      order: 6,
    },
    {
      id: "typecheck",
      argv: ["npm", "run", "typecheck"],
      lane: "typecheck",
      order: 4,
    },
    // Keep lint, format, and ShellCheck in one lane and in this order. lint:sh can
    // download the ShellCheck binary into node_modules; this prevents that write from
    // overlapping the other checks.
    {
      id: "lint",
      argv: ["npm", "run", "lint"],
      lane: "lint",
      order: 8,
    },
    {
      id: "format-check",
      argv: ["npm", "run", "format:check"],
      lane: "lint",
      order: 9,
    },
    {
      id: "lint-sh",
      argv: ["npm", "run", "lint:sh"],
      lane: "lint",
      order: 10,
    },
    // Keep package checks in one lane and preserve their order. The package
    // contents and npm pack checks inspect shared packaging metadata; the lazy
    // import check is included here for the non-lint CI projection independently.
    {
      id: "check-package-versions",
      argv: ["npm", "run", "check:package-versions"],
      lane: "pkg",
      order: 1,
    },
    {
      id: "check-package-contents",
      argv: ["npm", "run", "check:package-contents"],
      lane: "pkg",
      order: 2,
    },
    {
      id: "check-lazy-import-boundaries",
      argv: ["npm", "run", "check:lazy-import-boundaries"],
      lane: "pkg",
      order: 3,
    },
    {
      id: "merge-settings",
      argv: ["node", "scripts/merge-settings.mjs", "--dry-run"],
      lane: "pkg",
      order: 11,
    },
    {
      id: "npm-pack",
      argv: ["npm", "pack", "--dry-run"],
      lane: "pkg",
      order: 12,
    },
  ].map((check) => Object.freeze({ ...check, argv: Object.freeze([...check.argv]) })),
);

/**
 * Validate a manifest before projecting it into either execution form.
 *
 * @param {unknown} checks
 * @returns {ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>}
 */
export function assertValidValidationChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error("Validation check manifest must be a non-empty array.");
  }

  const ids = new Set();
  const argvOwners = new Map();
  const orders = new Set();
  for (const [index, check] of checks.entries()) {
    if (check === null || typeof check !== "object" || Array.isArray(check)) {
      throw new Error(`Validation check ${index + 1} must be an object.`);
    }

    const { id, argv, lane, order } = check;
    if (typeof id !== "string" || !CHECK_ID_PATTERN.test(id)) {
      throw new Error(`Validation check ${index + 1} has an invalid id; use lowercase kebab-case.`);
    }
    if (ids.has(id)) {
      throw new Error(`Validation check id is duplicated: ${id}`);
    }
    ids.add(id);

    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((argument) => typeof argument !== "string" || argument.length === 0)
    ) {
      throw new Error(`Validation check ${id} must define a non-empty argv of non-empty strings.`);
    }
    const argvKey = JSON.stringify(argv);
    const existingArgvOwner = argvOwners.get(argvKey);
    if (existingArgvOwner !== undefined) {
      throw new Error(
        `Validation check argv is duplicated between ${existingArgvOwner} and ${id}.`,
      );
    }
    argvOwners.set(argvKey, id);

    if (typeof lane !== "string" || lane.length === 0) {
      throw new Error(`Validation check ${id} must define a non-empty CI lane.`);
    }

    if (!Number.isSafeInteger(order) || order < 1) {
      throw new Error(`Validation check ${id} must define a positive integer order.`);
    }
    if (orders.has(order)) {
      throw new Error(`Validation check order is duplicated: ${order}`);
    }
    orders.add(order);
  }

  return checks;
}

/**
 * @param {ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>} checks
 */
function orderedChecks(checks) {
  assertValidValidationChecks(checks);
  return [...checks].sort((left, right) => left.order - right.order);
}

/**
 * Project the manifest into the contributor's sequential check list.
 *
 * @param {ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>} [checks]
 * @returns {Array<{ id: string; argv: string[]; lane: string; order: number }>}
 */
export function projectSequentialChecks(checks = VALIDATION_CHECKS) {
  return orderedChecks(checks).map((check) => ({ ...check, argv: [...check.argv] }));
}

/**
 * Project the manifest into the concurrent CI lane shape consumed by run-lane.
 * Commands within each lane retain the manifest's sequential ordering.
 *
 * @param {ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>} [checks]
 * @returns {Array<{ name: string; commands: string[][] }>}
 */
export function projectConcurrentLanes(checks = VALIDATION_CHECKS) {
  assertValidValidationChecks(checks);
  const lanes = new Map();
  for (const check of checks) {
    let laneChecks = lanes.get(check.lane);
    if (laneChecks === undefined) {
      laneChecks = [];
      lanes.set(check.lane, laneChecks);
    }
    laneChecks.push(check);
  }

  return [...lanes].map(([name, laneChecks]) => ({
    name,
    commands: [...laneChecks]
      .sort((left, right) => left.order - right.order)
      .map((check) => [...check.argv]),
  }));
}

assertValidValidationChecks(VALIDATION_CHECKS);
