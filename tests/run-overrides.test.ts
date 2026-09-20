import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStartArgs } from "../src/arguments.ts";
import { applyRunOverrides, defaultState } from "../src/loop-state.ts";

/**
 * Regression tests for the autonomous chain stopping after every atom.
 *
 * Root cause (see tictactoe/.pi-loop-log.jsonl): `/loop goal` configures
 * supervised mode, which caps maxIterations at 1 (ATOMS_PER_SESSION).
 * A later `/loop run --until-done` flips only `untilDone` and left
 * `maxIterations = 1` in place, so the fresh-session continuation hit
 * "Autonomous atom limit reached (1)" after each completed atom and the
 * chain never advanced on its own.
 */

function supervisedConfiguredState() {
  const state = defaultState();
  state.description = "demo goal";
  // This is exactly what applyGoalConfig stores for a non-untilDone start.
  state.untilDone = false;
  state.maxIterations = 1;
  return state;
}

test("run --until-done after supervised config: chain must be unlimited", () => {
  const state = supervisedConfiguredState();
  applyRunOverrides(state, parseStartArgs("--until-done"));

  assert.equal(state.untilDone, true);
  assert.equal(
    state.maxIterations,
    0,
    "switching to autonomous must clear the supervised single-atom cap",
  );
});

test("run --until-done --max 5 keeps the explicit cap", () => {
  const state = supervisedConfiguredState();
  applyRunOverrides(state, parseStartArgs("--until-done --max 5"));

  assert.equal(state.untilDone, true);
  assert.equal(state.maxIterations, 5);
});

test("plain run does not touch an explicit autonomous cap", () => {
  const state = supervisedConfiguredState();
  state.untilDone = true;
  state.maxIterations = 7;
  applyRunOverrides(state, parseStartArgs(""));

  assert.equal(state.untilDone, true);
  assert.equal(state.maxIterations, 7);
});

test("plain run after exhausted cap continues unlimited with a notice", () => {
  const state = supervisedConfiguredState();
  state.untilDone = true;
  state.maxIterations = 2;
  state.atomsCompletedThisRun = 2;
  const notice = applyRunOverrides(state, parseStartArgs(""));

  assert.equal(state.maxIterations, 0);
  assert.match(notice ?? "", /exhausted/i);
});

test("new explicit --max on an exhausted cap replaces it, no notice", () => {
  const state = supervisedConfiguredState();
  state.untilDone = true;
  state.maxIterations = 2;
  state.atomsCompletedThisRun = 2;
  const notice = applyRunOverrides(
    state,
    parseStartArgs("--max 4"),
  );

  assert.equal(state.maxIterations, 4);
  assert.equal(notice, undefined);
});

test("run applies model overrides alongside mode switching", () => {
  const state = supervisedConfiguredState();
  applyRunOverrides(
    state,
    parseStartArgs("--until-done --model foo/bar --rescue-model baz/qux"),
  );

  assert.equal(state.loopModel, "foo/bar");
  assert.equal(state.rescueModel, "baz/qux");
});
