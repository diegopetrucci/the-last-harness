import assert from "node:assert/strict";
import test from "node:test";
import {
  projectContributorCommands,
  runContributorValidation,
  TEST_AFTER_CHECK_ID,
  TEST_COMMAND,
} from "../scripts/run-validation.mjs";
import { projectSequentialChecks } from "../scripts/validation-checks.mjs";

test("contributor projection inserts npm test after installer smoke", () => {
  const commands = projectContributorCommands();
  const checks = projectSequentialChecks();
  const validationCommands = commands.filter((command) => command.kind === "validation");
  const testCommands = commands.filter((command) => command.kind === "test");

  assert.deepEqual(
    validationCommands.map((command) => command.id),
    checks.map((check) => check.id),
  );
  assert.equal(testCommands.length, 1);
  assert.deepEqual(testCommands[0].argv, TEST_COMMAND);

  const smokeIndex = commands.findIndex((command) => command.id === TEST_AFTER_CHECK_ID);
  const testIndex = commands.findIndex((command) => command.kind === "test");
  const lintIndex = commands.findIndex((command) => command.id === "lint");
  assert.equal(testIndex, smokeIndex + 1);
  assert.ok(testIndex < lintIndex);
});

test("contributor runner fails fast at the first failed command", () => {
  const commands = projectContributorCommands();
  const failedId = commands[2].id;
  const invoked = [];

  const status = runContributorValidation({
    run(_argv, command) {
      invoked.push(command.id);
      return command.id === failedId ? 17 : 0;
    },
  });

  assert.equal(status, 17);
  assert.deepEqual(
    invoked,
    commands.slice(0, 3).map((command) => command.id),
    "commands after the first failure must not run",
  );
});

test("contributor runner returns zero after every projected command succeeds", () => {
  const invoked = [];
  const status = runContributorValidation({
    run(_argv, command) {
      invoked.push(command.id);
      return 0;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(
    invoked,
    projectContributorCommands().map((command) => command.id),
  );
});
