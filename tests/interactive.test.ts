import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplyPrompt,
  buildPlanPrompt,
  formatCommitMessage,
  interactiveCommitGuard,
  interactiveStatusLines,
  interactiveSystemNote,
  parseCommitBlocked,
  parseMarkerIds,
  planHash,
  resolveCommitMode,
  shortSha,
} from "../src/interactive.ts";

test("plan and applied markers yield atom ids", () => {
  assert.deepEqual(
    parseMarkerIds("COMMIT_PLAN_READY: A001, A002", "COMMIT_PLAN_READY"),
    ["A001", "A002"],
  );
  assert.deepEqual(
    parseMarkerIds("done\nCOMMIT_APPLIED: A007", "COMMIT_APPLIED"),
    ["A007"],
  );
  assert.equal(parseMarkerIds("no marker", "COMMIT_APPLIED"), undefined);
});

test("COMMIT_BLOCKED carries a reason", () => {
  assert.equal(
    parseCommitBlocked("COMMIT_BLOCKED: tests still red"),
    "tests still red",
  );
  assert.equal(parseCommitBlocked("nothing"), undefined);
});

test("plan hash is stable and changes with the diff", () => {
  assert.equal(planHash("a", "b"), planHash("a", "b"));
  assert.notEqual(planHash("a", "b"), planHash("a", "c"));
});

test("commit message is one batch with atom ids", () => {
  assert.equal(
    formatCommitMessage(["A002", "A003"]),
    "loop: interactive batch (A002-A003)",
  );
  assert.equal(
    formatCommitMessage(["A005"]),
    "loop: interactive batch (A005)",
  );
  assert.equal(formatCommitMessage([]), "loop: interactive batch");
});

test("short sha is seven chars", () => {
  assert.equal(shortSha("0123456789abcdef"), "0123456");
});

test("commit guard rejects no batch and busy session", () => {
  assert.match(interactiveCommitGuard(false, true) ?? "", /not active/i);
  assert.match(interactiveCommitGuard(true, false) ?? "", /finish/i);
  assert.equal(interactiveCommitGuard(true, true), undefined);
});

test("commit mode: plan, apply, or regenerate stale", () => {
  assert.equal(
    resolveCommitMode({ apply: false, hasPlan: false, planMatches: false }),
    "plan",
  );
  assert.equal(
    resolveCommitMode({ apply: true, hasPlan: true, planMatches: true }),
    "apply",
  );
  assert.equal(
    resolveCommitMode({ apply: true, hasPlan: true, planMatches: false }),
    "apply-replan",
  );
  assert.equal(
    resolveCommitMode({ apply: true, hasPlan: false, planMatches: false }),
    "apply-replan",
  );
});

test("system note states the journal and no-commit rules", () => {
  const note = interactiveSystemNote("demo", "INTERACTIVE-JOURNAL.md");
  assert.match(note, /INTERACTIVE-JOURNAL\.md/);
  assert.match(note, /do not run git commit/i);
  assert.match(note, /COMMIT_PLAN_READY/);
});

test("plan prompt names the plan file, marker and atom fields", () => {
  const prompt = buildPlanPrompt({
    goal: "demo",
    criteria: "works",
    goalFile: "GOAL.md",
    baselineSha: "0123456789abcdef",
    journalFile: "INTERACTIVE-JOURNAL.md",
    planFile: ".pi-loop/interactive-commit-plan.md",
    diffStat: "1 file changed",
    changedPaths: "src/a.ts",
    checkCommand: "npm test",
  });
  assert.match(prompt, /\.pi-loop\/interactive-commit-plan\.md/);
  assert.match(prompt, /COMMIT_PLAN_READY/);
  assert.match(prompt, /Positive scenarios/);
  assert.match(prompt, /DO NOT modify project files/i);
});

test("apply prompt includes the stored plan when present", () => {
  const base = {
    goal: "demo",
    criteria: "works",
    goalFile: "GOAL.md",
    baselineSha: "0123456789abcdef",
    journalFile: "INTERACTIVE-JOURNAL.md",
    planFile: ".pi-loop/interactive-commit-plan.md",
    diffStat: "1 file changed",
    changedPaths: "src/a.ts",
    checkCommand: "npm test",
  };
  const withPlan = buildApplyPrompt({ ...base, planText: "PLAN-BODY" });
  assert.match(withPlan, /PLAN-BODY/);
  assert.match(withPlan, /COMMIT_APPLIED/);
  const withoutPlan = buildApplyPrompt({ ...base, planText: "" });
  assert.match(withoutPlan, /generate the plan first/i);
});

test("status lines expose baseline, drift and stale plan", () => {
  const lines = interactiveStatusLines({
    baselineSha: "0123456789abcdef",
    driftCount: 2,
    planAt: 1700000000000,
    planHashStale: true,
  });
  assert.ok(lines.some((l) => l.includes("INTERACTIVE")));
  assert.ok(lines.some((l) => l.includes("0123456")));
  assert.ok(lines.some((l) => l.includes("Drift: 2")));
  assert.ok(lines.some((l) => l.includes("STALE")));
});
