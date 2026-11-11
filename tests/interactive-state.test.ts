import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultState,
  persistedLoopState,
  resetInteractiveBatch,
  restoreLoopState,
  STATE_ENTRY_TYPE,
  stopInteractive,
} from "../src/loop-state.ts";

test("interactive defaults are off and empty", () => {
  const state = defaultState();
  assert.equal(state.interactive, false);
  assert.equal(state.interactiveBaselineSha, "");
  assert.equal(state.interactiveCommitPending, "");
});

test("restore keeps interactive mode, baseline and plan", () => {
  const entry = {
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: {
      interactive: true,
      interactiveBaselineSha: "abc123",
      interactiveStartedAt: 11,
      interactivePlan: "PLAN",
      interactivePlanHash: "hash",
      interactivePlanAt: 12,
      interactiveCommitPending: "apply",
    },
  };

  const state = restoreLoopState([entry]);

  assert.equal(state.interactive, true);
  assert.equal(state.interactiveBaselineSha, "abc123");
  assert.equal(state.interactivePlan, "PLAN");
  assert.equal(state.interactiveCommitPending, "apply");
});

test("restore sanitises an invalid pending value", () => {
  const state = restoreLoopState([{
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: { interactive: true, interactiveCommitPending: "bogus" },
  }]);

  assert.equal(state.interactiveCommitPending, "");
});

test("resetInteractiveBatch keeps the mode and baseline", () => {
  const state = defaultState();
  state.interactive = true;
  state.interactiveBaselineSha = "abc";
  state.interactivePlan = "PLAN";
  state.interactivePlanHash = "hash";
  state.interactivePlanAt = 5;
  state.interactiveCommitPending = "plan";

  resetInteractiveBatch(state);

  assert.equal(state.interactive, true);
  assert.equal(state.interactiveBaselineSha, "abc");
  assert.equal(state.interactivePlan, "");
  assert.equal(state.interactiveCommitPending, "");
});

test("stopInteractive clears the whole mode", () => {
  const state = defaultState();
  state.interactive = true;
  state.interactiveBaselineSha = "abc";

  stopInteractive(state);

  assert.equal(state.interactive, false);
  assert.equal(state.interactiveBaselineSha, "");
});

test("persisted state truncates a huge plan", () => {
  const state = defaultState();
  state.interactivePlan = "x".repeat(50_000);

  assert.ok(
    persistedLoopState(state).interactivePlan.length <= 20_000,
  );
});
