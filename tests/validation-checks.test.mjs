import assert from "node:assert/strict";
import test from "node:test";
import { LANES, selectLanes } from "../scripts/run-ci-validation.mjs";
import {
  assertValidValidationChecks,
  projectConcurrentLanes,
  projectSequentialChecks,
  VALIDATION_CHECKS,
} from "../scripts/validation-checks.mjs";

function commandKey(argv) {
  return JSON.stringify(argv);
}

test("validation manifest has unique IDs, orders, and valid argv", () => {
  assert.doesNotThrow(() => assertValidValidationChecks(VALIDATION_CHECKS));
  assert.equal(new Set(VALIDATION_CHECKS.map((check) => check.id)).size, VALIDATION_CHECKS.length);
  assert.equal(
    new Set(VALIDATION_CHECKS.map((check) => check.order)).size,
    VALIDATION_CHECKS.length,
  );
  for (const check of VALIDATION_CHECKS) {
    assert.ok(check.id.length > 0);
    assert.ok(check.lane.length > 0);
    assert.ok(check.argv.length > 0);
    assert.ok(check.argv.every((argument) => typeof argument === "string" && argument.length > 0));
  }
});

test("validation projections include every manifest command exactly once", () => {
  const expected = VALIDATION_CHECKS.map((check) => commandKey(check.argv)).sort();
  const sequential = projectSequentialChecks();
  const concurrent = projectConcurrentLanes().flatMap((lane) => lane.commands);

  assert.deepEqual(
    sequential.map((check) => commandKey(check.argv)).sort(),
    expected,
    "sequential projection must contain every manifest command once",
  );
  assert.deepEqual(
    concurrent.map(commandKey).sort(),
    expected,
    "concurrent projection must contain every manifest command once",
  );
  assert.equal(new Set(sequential.map((check) => check.id)).size, VALIDATION_CHECKS.length);
});

test("sequential projection starts with the dependency version check", () => {
  const [firstCheck] = projectSequentialChecks();
  assert.equal(
    firstCheck.id,
    "check-package-versions",
    "package-version validation must precede all other contributor checks",
  );
});

test("sequential projection preserves package and lint ordering invariants", () => {
  const sequential = projectSequentialChecks();
  const indexOf = (id) => sequential.findIndex((check) => check.id === id);
  const before = (left, right) =>
    assert.ok(indexOf(left) < indexOf(right), `${left} must precede ${right}`);

  before("check-package-versions", "check-package-contents");
  before("check-package-contents", "check-lazy-import-boundaries");
  before("check-lazy-import-boundaries", "merge-settings");
  before("merge-settings", "npm-pack");
  before("lint", "format-check");
  before("format-check", "lint-sh");
  before("check-runtime", "check-installer-smoke");
  before("check-installer-smoke", "lint");
});

test("lazy-import-boundaries is projected into the non-lint CI invocation", () => {
  const lazyCheck = VALIDATION_CHECKS.find((check) => check.id === "check-lazy-import-boundaries");
  assert.ok(lazyCheck);

  const nonLintCommands = projectConcurrentLanes()
    .filter((lane) => lane.name !== "lint")
    .flatMap((lane) => lane.commands)
    .map(commandKey);
  assert.ok(nonLintCommands.includes(commandKey(lazyCheck.argv)));
});

test("production lane selection retains the existing lint and non-lint splits", () => {
  const allLanes = selectLanes(LANES, []);
  assert.deepEqual(
    allLanes.map((lane) => lane.name),
    [...new Set(VALIDATION_CHECKS.map((check) => check.lane))],
  );

  const lintLanes = selectLanes(LANES, ["--lanes=lint"]);
  assert.deepEqual(
    lintLanes.map((lane) => lane.name),
    ["lint"],
  );

  const nonLintLanes = selectLanes(LANES, ["--exclude=lint"]);
  assert.ok(!nonLintLanes.some((lane) => lane.name === "lint"));
  assert.ok(
    nonLintLanes.some((lane) =>
      lane.commands.some(
        (argv) => commandKey(argv) === commandKey(["npm", "run", "check:lazy-import-boundaries"]),
      ),
    ),
  );
});

test("invalid or duplicate manifest entries are rejected", () => {
  const duplicateId = VALIDATION_CHECKS.map((check) => ({ ...check, argv: [...check.argv] }));
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(() => assertValidValidationChecks(duplicateId), /id is duplicated/);

  const duplicateArgv = VALIDATION_CHECKS.map((check) => ({ ...check, argv: [...check.argv] }));
  duplicateArgv[1].id = `${duplicateArgv[1].id}-duplicate`;
  duplicateArgv[1].argv = [...duplicateArgv[0].argv];
  assert.throws(() => assertValidValidationChecks(duplicateArgv), /argv is duplicated/);

  const invalidArgv = VALIDATION_CHECKS.map((check) => ({ ...check, argv: [...check.argv] }));
  invalidArgv[0].argv = [];
  assert.throws(() => assertValidValidationChecks(invalidArgv), /non-empty argv/);
});
