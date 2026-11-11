import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommitArgs, parseStartArgs } from "../src/arguments.ts";

test("--interactive is parsed and removed from the description", () => {
  const parsed = parseStartArgs("build demo --interactive --check \"npm test\"");
  assert.equal(parsed.interactive, true);
  assert.equal(parsed.description, "build demo");
  assert.equal(parsed.checkCommand, "npm test");
  assert.equal(parsed.untilDone, false);
});

test("plain goal keeps interactive false", () => {
  assert.equal(parseStartArgs("build demo").interactive, false);
});

test("commit args: no flag is the plan phase", () => {
  assert.deepEqual(parseCommitArgs(""), { apply: false, unknown: [] });
});

test("commit args: --apply is the trusted phase", () => {
  assert.deepEqual(parseCommitArgs("--apply"), { apply: true, unknown: [] });
});

test("commit args: unknown tokens are reported", () => {
  assert.deepEqual(parseCommitArgs("--apply --force"), {
    apply: true,
    unknown: ["--force"],
  });
});
