import assert from "node:assert/strict";
import test from "node:test";
import { selectLanes } from "../scripts/run-ci-validation.mjs";

// Keep the selector tests independent of the repository's current lane names or
// command inventory. The production selector is exercised with a representative
// lane shape while LANES itself remains owned by the runner and CI configuration.
const TEST_LANES = [
  { name: "lint", commands: [["npm", "run", "lint"]] },
  { name: "pkg", commands: [["npm", "pack", "--dry-run"]] },
  { name: "runtime", commands: [["npm", "run", "check:runtime"]] },
];

test("selectLanes: no args returns all lanes", () => {
  const result = selectLanes(TEST_LANES, []);
  assert.deepStrictEqual(result, TEST_LANES);
});

test("selectLanes: --lanes= form selects named lanes", () => {
  const result = selectLanes(TEST_LANES, ["--lanes=lint"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "lint");
});

test("selectLanes: --lanes space form selects named lanes", () => {
  const result = selectLanes(TEST_LANES, ["--lanes", "lint"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "lint");
});

test("selectLanes: --lanes= with multiple lanes selects all named", () => {
  const result = selectLanes(TEST_LANES, ["--lanes=lint,pkg"]);
  assert.equal(result.length, 2);
  assert.deepStrictEqual(
    result.map((lane) => lane.name),
    ["lint", "pkg"],
  );
});

test("selectLanes: --exclude= form excludes named lane and returns the rest", () => {
  const result = selectLanes(TEST_LANES, ["--exclude=lint"]);
  assert.equal(result.length, TEST_LANES.length - 1);
  assert.ok(!result.some((lane) => lane.name === "lint"));
});

test("selectLanes: --exclude space form excludes named lane", () => {
  const result = selectLanes(TEST_LANES, ["--exclude", "lint"]);
  assert.equal(result.length, TEST_LANES.length - 1);
  assert.ok(!result.some((lane) => lane.name === "lint"));
});

test("selectLanes: --exclude= with multiple lanes excludes all named", () => {
  const result = selectLanes(TEST_LANES, ["--exclude=lint,pkg"]);
  assert.equal(result.length, TEST_LANES.length - 2);
  assert.ok(!result.some((lane) => lane.name === "lint" || lane.name === "pkg"));
});

test("selectLanes: unknown lane name in --lanes throws with actionable message", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--lanes=nonexistent"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("nonexistent"));
      assert.ok(err.message.includes("Valid lanes"));
      return true;
    },
  );
});

test("selectLanes: unknown lane name in --exclude throws with actionable message", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--exclude=nonexistent"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("nonexistent"));
      assert.ok(err.message.includes("Valid lanes"));
      return true;
    },
  );
});

test("selectLanes: --lanes and --exclude together throws", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--lanes=lint", "--exclude=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("mutually exclusive"));
      return true;
    },
  );
});

test("selectLanes: --exclude all lanes throws for empty selection", () => {
  const allNames = TEST_LANES.map((lane) => lane.name).join(",");
  assert.throws(
    () => selectLanes(TEST_LANES, [`--exclude=${allNames}`]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("zero lanes"));
      return true;
    },
  );
});

test("selectLanes: unknown flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--unknown-flag"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--unknown-flag"));
      return true;
    },
  );
});

test("selectLanes: --lanes with no value throws", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--lanes"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("requires a value"));
      return true;
    },
  );
});

test("selectLanes: --exclude with no value throws", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--exclude"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("requires a value"));
      return true;
    },
  );
});

test("selectLanes: repeated --lanes flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--lanes=lint", "--lanes=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--lanes"));
      assert.ok(err.message.toLowerCase().includes("more than once"));
      return true;
    },
  );
});

test("selectLanes: repeated --exclude flag throws with actionable message", () => {
  assert.throws(
    () => selectLanes(TEST_LANES, ["--exclude=lint", "--exclude=pkg"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--exclude"));
      assert.ok(err.message.toLowerCase().includes("more than once"));
      return true;
    },
  );
});
