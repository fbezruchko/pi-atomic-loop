# Interactive Loop Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive loop mode where the user drives implementation in one session, the controller never commits, and `/loop commit` retroactively formalises the accumulated changes as atoms, tests and one Git checkpoint.

**Architecture:** Pure helpers live in new `src/interactive.ts` (markers, plan hash, prompts, guards) and `src/interactive-git.ts` (baseline, batch facts, drift, injected `GitRunner`). `src/arguments.ts` parses `--interactive` and `/loop commit --apply`. `src/loop-state.ts` gains durable interactive fields. `extensions/index.ts` wires commands, turn injection and the two-phase commit; it stays thin and delegates semantics to the agent, as in supervised/autonomous mode.

**Tech Stack:** TypeScript run directly by Node (`node --test`, `node --check`), Pi extension API, Git CLI, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-11-interactive-mode-design.md`

## Global Constraints

- Interactive mode sets `state.active = false`: no stuck detection, no CYCLE_DONE handling, no autonomous continuation, no check after every turn. Degenerate-repetition protection stays.
- The batch base is always `interactiveBaselineSha`, never current HEAD. `git diff <baseline>` must remain valid if the agent commits by accident.
- Atom IDs are assigned by the agent using the same conventions it already uses in GOAL.md. The extension never allocates IDs.
- The extension does not create tags or push in any mode. The agent performs version bumps, CHANGELOG entries and other release semantics inside the apply turn, before `COMMIT_APPLIED`.
- One commit per batch: `loop: interactive batch (<ids>)`. Splitting an already-merged worktree per atom is out of scope.
- Interactive mode survives a session restart; supervised/autonomous pause behavior is unchanged.
- All code comments, docstrings and commit messages in English.
- Do not change behavior of supervised/autonomous modes except where this plan says so.

## Review Focus

- `/loop commit` with no active interactive batch must reject before touching any file. Test: `interactiveCommitGuard`.
- `/loop commit --apply` after the worktree changed since the plan must regenerate the plan rather than apply a stale one. Test: `resolveCommitMode`.
- Untracked files must appear in the batch facts and the plan hash. Test: real temp-repo integration in Task 3.
- A session restart must keep `interactive`, the baseline SHA and the stored plan. Test: state restore in Task 4.
- `/loop stop` mid-batch must leave changes uncommitted and clear only interactive state. Test: `resetInteractiveBatch` in Task 4.
- A missing marker or `COMMIT_BLOCKED` must not commit and must keep the plan. Tests: marker parsing in Task 2, extension branch in Task 7.

---

### Task 1: Argument parsing

**Files:**
- Modify: `src/arguments.ts`
- Modify: `package.json` (test script glob)
- Test: `tests/arguments-interactive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StartArgs.interactive: boolean`
  - `parseStartArgs(args).interactive` is `true` when `--interactive` is present and the flag is removed from the description.
  - `parseCommitArgs(args: string): { apply: boolean; unknown: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/arguments-interactive.test.ts`
Expected: FAIL — `parseCommitArgs` is not exported and `interactive` is undefined.

- [ ] **Step 3: Implement parsing**

Add `interactive: false` to the `StartArgs` declaration and to the returned object. In the token loop:

```ts
if (token === "--interactive") {
  interactive = true;
  continue;
}
```

Add below `parseStartArgs`:

```ts
export function parseCommitArgs(args: string): {
  apply: boolean;
  unknown: string[];
};
```

It trims, splits on whitespace, returns `apply: tokens.includes("--apply")`, and every other non-empty token goes to `unknown`.

Update `package.json` scripts to `"test": "node --test tests/*.test.ts"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/*.test.ts`
Expected: all tests PASS, including `tests/run-overrides.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/arguments.ts package.json tests/arguments-interactive.test.ts
git commit -m "feat: parse interactive mode and commit flags"
```

---

### Task 2: Pure interactive helpers and prompts

**Files:**
- Create: `src/interactive.ts`
- Test: `tests/interactive.test.ts`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces:
  - `type InteractiveMarker = "COMMIT_PLAN_READY" | "COMMIT_APPLIED"`
  - `parseMarkerIds(text: string, marker: InteractiveMarker): string[] | undefined`
  - `parseCommitBlocked(text: string): string | undefined`
  - `planHash(diff: string, statusText: string): string`
  - `formatCommitMessage(atomIds: string[]): string`
  - `shortSha(sha: string): string`
  - `interactiveCommitGuard(interactive: boolean, idle: boolean): string | undefined`
  - `type CommitMode = "plan" | "apply" | "apply-replan"`
  - `resolveCommitMode(input: { apply: boolean; hasPlan: boolean; planMatches: boolean }): CommitMode`
  - `interactiveSystemNote(goal: string, journalFile: string): string`
  - `type PlanPromptInput = { goal; criteria; goalFile; baselineSha; journalFile; planFile; diffStat; changedPaths; checkCommand }` (all `string`)
  - `buildPlanPrompt(input: PlanPromptInput): string`
  - `type ApplyPromptInput = PlanPromptInput & { planText: string }`
  - `buildApplyPrompt(input: ApplyPromptInput): string`
  - `type InteractiveStatusInput = { baselineSha; driftCount: number; planAt: number; planHashStale: boolean }`
  - `interactiveStatusLines(input: InteractiveStatusInput): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplyPrompt, buildPlanPrompt, formatCommitMessage, interactiveCommitGuard,
  interactiveStatusLines, interactiveSystemNote, parseCommitBlocked, parseMarkerIds,
  planHash, resolveCommitMode, shortSha,
} from "../src/interactive.ts";

test("plan and applied markers yield atom ids", () => {
  assert.deepEqual(parseMarkerIds("COMMIT_PLAN_READY: A001, A002", "COMMIT_PLAN_READY"), ["A001", "A002"]);
  assert.deepEqual(parseMarkerIds("done\nCOMMIT_APPLIED: A007", "COMMIT_APPLIED"), ["A007"]);
  assert.equal(parseMarkerIds("no marker", "COMMIT_APPLIED"), undefined);
});

test("COMMIT_BLOCKED carries a reason", () => {
  assert.equal(parseCommitBlocked("COMMIT_BLOCKED: tests still red"), "tests still red");
  assert.equal(parseCommitBlocked("nothing"), undefined);
});

test("plan hash is stable and changes with the diff", () => {
  assert.equal(planHash("a", "b"), planHash("a", "b"));
  assert.notEqual(planHash("a", "b"), planHash("a", "c"));
});

test("commit message is one batch with atom ids", () => {
  assert.equal(formatCommitMessage(["A002", "A003"]), "loop: interactive batch (A002-A003)");
  assert.equal(formatCommitMessage(["A005"]), "loop: interactive batch (A005)");
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
  assert.equal(resolveCommitMode({ apply: false, hasPlan: false, planMatches: false }), "plan");
  assert.equal(resolveCommitMode({ apply: true, hasPlan: true, planMatches: true }), "apply");
  assert.equal(resolveCommitMode({ apply: true, hasPlan: true, planMatches: false }), "apply-replan");
  assert.equal(resolveCommitMode({ apply: true, hasPlan: false, planMatches: false }), "apply-replan");
});

test("system note states the journal and no-commit rules", () => {
  const note = interactiveSystemNote("demo", "INTERACTIVE-JOURNAL.md");
  assert.match(note, /INTERACTIVE-JOURNAL\.md/);
  assert.match(note, /do not run git commit/i);
  assert.match(note, /COMMIT_PLAN_READY/);
});

test("plan prompt names the plan file, marker and atom fields", () => {
  const prompt = buildPlanPrompt({
    goal: "demo", criteria: "works", goalFile: "GOAL.md",
    baselineSha: "0123456789abcdef", journalFile: "INTERACTIVE-JOURNAL.md",
    planFile: ".pi-loop/interactive-commit-plan.md", diffStat: "1 file changed",
    changedPaths: "src/a.ts", checkCommand: "npm test",
  });
  assert.match(prompt, /\.pi-loop\/interactive-commit-plan\.md/);
  assert.match(prompt, /COMMIT_PLAN_READY/);
  assert.match(prompt, /Positive scenarios/);
  assert.match(prompt, /DO NOT modify project files/i);
});

test("apply prompt includes the stored plan when present", () => {
  const base = {
    goal: "demo", criteria: "works", goalFile: "GOAL.md",
    baselineSha: "0123456789abcdef", journalFile: "INTERACTIVE-JOURNAL.md",
    planFile: ".pi-loop/interactive-commit-plan.md", diffStat: "1 file changed",
    changedPaths: "src/a.ts", checkCommand: "npm test",
  };
  const withPlan = buildApplyPrompt({ ...base, planText: "PLAN-BODY" });
  assert.match(withPlan, /PLAN-BODY/);
  assert.match(withPlan, /COMMIT_APPLIED/);
  const withoutPlan = buildApplyPrompt({ ...base, planText: "" });
  assert.match(withoutPlan, /generate the plan first/i);
});

test("status lines expose baseline, drift and stale plan", () => {
  const lines = interactiveStatusLines({
    baselineSha: "0123456789abcdef", driftCount: 2, planAt: 1700000000000, planHashStale: true,
  });
  assert.ok(lines.some((l) => l.includes("INTERACTIVE")));
  assert.ok(lines.some((l) => l.includes("0123456")));
  assert.ok(lines.some((l) => l.includes("Drift: 2")));
  assert.ok(lines.some((l) => l.includes("STALE")));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/interactive.test.ts`
Expected: FAIL — module `src/interactive.ts` does not exist.

- [ ] **Step 3: Implement `src/interactive.ts`**

Write the helpers with these exact behaviors:

- `parseMarkerIds`: regex `new RegExp("\\b" + marker + "\\s*:\\s*([A-Za-z0-9._,\\s-]*)", "i")`, split on commas, trim, filter non-empty; return `undefined` when the marker is absent or yields no ids.
- `parseCommitBlocked`: `/\bCOMMIT_BLOCKED\s*:\s*(.+)$/im`, trim; `undefined` when absent.
- `planHash`: `createHash("sha256").update(diff).update("\u0000").update(statusText).digest("hex")`.
- `formatCommitMessage`: empty → `"loop: interactive batch"`; one → `(A005)`; several → `(first-last)`.
- `shortSha`: `sha.slice(0, 7)`.
- `interactiveCommitGuard`: not interactive → `"Interactive mode is not active. Use /loop interactive <goal> first."`; not idle → `"Finish the current turn before /loop commit."`; else `undefined`.
- `resolveCommitMode`: exactly the truth table in the test.
- `interactiveSystemNote`: mentions the goal, that the user drives, that `INTERACTIVE-JOURNAL.md` gets one short entry per substantive request, that the agent must not run `git commit`, must not emit `ATOM_STARTED`/`CYCLE_DONE`/`MVP_READY`/`LOOP_DONE`, must not edit GOAL.md/PROGRESS.md/TESTMANUAL.md until `/loop commit`, and that `/loop commit` handles formalisation. The journal entry format is `## <timestamp> — <request>` with `Changed:` and `Tests:` lines.
- `buildPlanPrompt`: multi-line instruction. Must include: goal, criteria, goal file, baseline short sha, journal path, plan path, `diffStat`, `changedPaths`, check command. State `DO NOT modify project files`. Require the plan file content: proposed atoms in the GOAL.md atom template (`### Axxx — name`, `Goal`, `Files`, `Positive scenarios` 2–3, `Negative/error scenarios` 2–3, `Test`, `Verify`, `Acceptance`), tests to add/repair, regression candidates, check/test commands, proposed commit message. Atom IDs follow existing GOAL.md conventions. End with `COMMIT_PLAN_READY: <ids>` and print the short summary.
- `buildApplyPrompt`: same context. When `planText` is non-empty, embed it under "Approved plan" and say to execute it exactly. When empty, say "Read GOAL.md and the batch facts, generate the plan first, then execute it in this turn" (generate the plan first). Steps: retroactively append atoms as `Status: COMPLETED` with `Retrospective: interactive batch <short sha>`; update `PROGRESS.md` (mode, MVP, last completed, known issues, next 3); update `TESTMANUAL.md`; add missing focused tests per atom standard; run focused tests then the check command; apply the regression protocol if an older atom is affected; perform release semantics (version bump/CHANGELOG) in this turn if the project needs them; do not run `git commit`; end with `COMMIT_APPLIED: <ids>` only when green, otherwise `COMMIT_BLOCKED: <reason>`.
- `interactiveStatusLines`: return `["Interactive: true", "Baseline: <short|->", "Drift: <n> commit(s) since baseline", <plan line>]`; the plan line is `"Plan: none"`, `"Plan: ready (<iso>)"`, or `"Plan: STALE (<iso>)"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/interactive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interactive.ts tests/interactive.test.ts
git commit -m "feat: add interactive mode helpers and prompts"
```

---

### Task 3: Git batch facts with an injected runner

**Files:**
- Create: `src/interactive-git.ts`
- Test: `tests/interactive-git.test.ts`

**Interfaces:**
- Consumes: `node:child_process` only in tests; the module itself has no I/O.
- Produces:
  - `type GitResult = { code: number; stdout: string; stderr: string }`
  - `type GitRunner = (args: string[], timeout?: number) => Promise<GitResult>`
  - `getHeadSha(run: GitRunner): Promise<string | undefined>`
  - `ensureInteractiveBaseline(run: GitRunner): Promise<{ ok: boolean; sha: string; reason: string }>`
  - `collectBatchFacts(run: GitRunner, baselineSha: string): Promise<{ ok: boolean; diff: string; statusText: string; stat: string; paths: string[]; reason: string }>`
  - `countDrift(run: GitRunner, baselineSha: string): Promise<number>`

- [ ] **Step 1: Write the failing tests (fake runner + real temp repo)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBatchFacts, countDrift, ensureInteractiveBaseline, getHeadSha,
  type GitRunner,
} from "../src/interactive-git.ts";

function fakeRunner(script: Record<string, { code: number; stdout: string; stderr: string }>): GitRunner {
  return async (args) => script[args.join(" ")] ?? { code: 1, stdout: "", stderr: "unexpected" };
}

test("getHeadSha returns undefined without HEAD", async () => {
  const run = fakeRunner({ "rev-parse HEAD": { code: 128, stdout: "", stderr: "no head" } });
  assert.equal(await getHeadSha(run), undefined);
});

test("ensureInteractiveBaseline creates an empty commit when HEAD is missing", async () => {
  const calls: string[] = [];
  const run: GitRunner = async (args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "commit --allow-empty -m loop: interactive baseline") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "rev-parse HEAD") {
      return calls.filter((c) => c === "rev-parse HEAD").length === 1
        ? { code: 128, stdout: "", stderr: "no head" }
        : { code: 0, stdout: "abc123\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const result = await ensureInteractiveBaseline(run);
  assert.equal(result.ok, true);
  assert.equal(result.sha, "abc123");
  assert.ok(calls.includes("commit --allow-empty -m loop: interactive baseline"));
});

test("collectBatchFacts marks untracked files and returns paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-facts-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const baseline = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "a.txt"), "base\nchanged\n");
  writeFileSync(join(dir, "new.txt"), "untracked\n");

  const facts = await collectBatchFacts(async (args) => {
    try {
      return { code: 0, stdout: execFileSync("git", args, { cwd: dir, encoding: "utf8" }), stderr: "" };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }, baseline);

  assert.equal(facts.ok, true);
  assert.match(facts.diff, /new\.txt/);
  assert.deepEqual(facts.paths.sort(), ["a.txt", "new.txt"]);
});

test("countDrift counts intermediate commits", async () => {
  const run = fakeRunner({ "rev-list --count base..HEAD": { code: 0, stdout: "2\n", stderr: "" } });
  assert.equal(await countDrift(run, "base"), 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/interactive-git.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/interactive-git.ts`**

- `getHeadSha`: `run(["rev-parse", "HEAD"])`; return trimmed stdout when `code === 0`, else `undefined`.
- `ensureInteractiveBaseline`: call `getHeadSha`. If present, `{ ok: true, sha, reason: "HEAD present" }`. Otherwise run `commit --allow-empty -m loop: interactive baseline`; on failure return `{ ok: false, sha: "", reason: <stderr snippet> }`; then re-read HEAD and return it, or fail with `"no HEAD after baseline commit"`.
- `collectBatchFacts`:
  1. `git add -N .` — failure → `{ ok: false, ..., reason: "git add -N failed: ..." }`. This only marks intent-to-add so untracked files appear in `git diff`.
  2. `git diff --no-color <baselineSha>`.
  3. `git diff --stat <baselineSha>`.
  4. `git status --porcelain=v1 --untracked-files=all`.
  5. Parse paths from porcelain: drop the first 3 chars, handle ` -> ` renames and quoted paths, trim.
  Return `{ ok: true, diff, statusText: status, stat, paths, reason: "" }`.
- `countDrift`: if `baselineSha` is empty, `0`; else `rev-list --count <baselineSha>..HEAD`, `Number.parseInt(trim, 10) || 0` on success, `0` on failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/interactive-git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interactive-git.ts tests/interactive-git.test.ts
git commit -m "feat: collect interactive batch facts from git"
```

---

### Task 4: Durable interactive state

**Files:**
- Modify: `src/loop-state.ts`
- Test: `tests/interactive-state.test.ts`

**Interfaces:**
- Consumes: existing `LoopState`, `defaultState`, `restoreLoopState`, `persistedLoopState`, `STATE_ENTRY_TYPE`.
- Produces:
  - `LoopState.interactive: boolean`
  - `LoopState.interactiveBaselineSha: string`
  - `LoopState.interactiveStartedAt: number`
  - `LoopState.interactivePlan: string`
  - `LoopState.interactivePlanHash: string`
  - `LoopState.interactivePlanAt: number`
  - `LoopState.interactiveCommitPending: "" | "plan" | "apply"`
  - `resetInteractiveBatch(state: LoopState): void` — clears plan/hash/at/pending only, keeps mode and baseline.
  - `stopInteractive(state: LoopState): void` — clears all interactive fields and baseline.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultState, persistedLoopState, resetInteractiveBatch, restoreLoopState,
  STATE_ENTRY_TYPE, stopInteractive,
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
    type: "custom", customType: STATE_ENTRY_TYPE,
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
  assert.ok(persistedLoopState(state).interactivePlan.length <= 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/interactive-state.test.ts`
Expected: FAIL — fields and helpers do not exist.

- [ ] **Step 3: Implement in `src/loop-state.ts`**

Add the seven fields to `LoopState`, set defaults (`false`, `""`, `0`, `""`, `""`, `0`, `""`), add restore sanitisation:

```ts
if (!["", "plan", "apply"].includes(result.interactiveCommitPending)) {
  result.interactiveCommitPending = "";
}
if (typeof result.interactive !== "boolean") result.interactive = false;
if (typeof result.interactiveBaselineSha !== "string") result.interactiveBaselineSha = "";
if (typeof result.interactiveStartedAt !== "number") result.interactiveStartedAt = 0;
if (typeof result.interactivePlan !== "string") result.interactivePlan = "";
if (typeof result.interactivePlanHash !== "string") result.interactivePlanHash = "";
if (typeof result.interactivePlanAt !== "number") result.interactivePlanAt = 0;
```

In `persistedLoopState`, add `interactivePlan: state.interactivePlan.slice(0, 20_000)`.

Add the two exported helpers exactly as described in Interfaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop-state.ts tests/interactive-state.test.ts
git commit -m "feat: persist interactive loop state"
```

---

### Task 5: Extension wiring — start, status, stop, restart

**Files:**
- Modify: `extensions/index.ts`
- Verify: `README.md` command list is out of scope here (Task 8).

**Interfaces:**
- Consumes (from earlier tasks): all exports of `src/interactive.ts`, `src/interactive-git.ts`, `parseCommitArgs`, and the new `LoopState` helpers.
- Produces inside `extensions/index.ts`:
  - `function gitRunner(ctx: ExtensionContext): GitRunner` — adapts `gitExec(ctx, args, timeout)` to the injected runner shape.
  - `async function startInteractive(pi, ctx, parsed: StartArgs): Promise<void>`
  - `async function ensureInteractiveJournal(ctx: ExtensionContext): Promise<void>`
  - Interactive branches in `loopModeText`, `statusBarText`, `statusText`, `session_start`, `before_agent_start`, `/loop` handler, `help`.
  - `INTERACTIVE_JOURNAL_FILE = "INTERACTIVE-JOURNAL.md"` and `INTERACTIVE_PLAN_FILE = ".pi-loop/interactive-commit-plan.md"` constants.

- [ ] **Step 1: Add constants and imports**

Import from `../src/arguments.ts`: `parseCommitArgs`. Import from `../src/interactive.ts`: `interactiveStatusLines`, `interactiveSystemNote`, `planHash`, `shortSha`. Import from `../src/interactive-git.ts`: `collectBatchFacts`, `countDrift`, `ensureInteractiveBaseline`, `getHeadSha`, `type GitRunner`. Import `resetInteractiveBatch`, `stopInteractive` from `../src/loop-state.ts`.

Add the plan path to the loop-owned/ignored paths so it is never committed: include `.pi-loop/interactive-commit-plan.md` in the candidates passed to `ignoreLoopLog` and in `isLoopOwnedPath`.

- [ ] **Step 2: Implement `gitRunner` and `startInteractive`**

`gitRunner(ctx)` returns `async (args, timeout) => gitExec(ctx, args, timeout)`.

`startInteractive(pi, ctx, parsed)`:

1. `applyGoalConfig(parsed)` (already called by the caller; do not call twice).
2. `await ensureGitRepository(ctx)`; on failure notify and restore `state.active=false; state.status="paused"; persist`.
3. `const result = await ensureInteractiveBaseline(gitRunner(ctx))`; on failure notify error, set `lastNotice`, persist, return.
4. `await ensureInteractiveJournal(ctx)` — bash: create `INTERACTIVE-JOURNAL.md` with `# Interactive journal` if absent, then append `\n## Batch <ISO timestamp>\n` (use `printf` with a fixed format and pass the timestamp as an argument to avoid quoting problems).
5. Set `state.interactive = true`, `interactiveBaselineSha = result.sha`, `interactiveStartedAt = Date.now()`, `resetInteractiveBatch(state)`, `status = "stopped"`, `active = false`, `lastNotice = "Interactive mode started."`; persist.
6. If `parsed.model`, `switchModel`; abort start on failure.
7. `ctx.ui.setStatus("loop", statusBarText())`; notify `Interactive mode started at <short sha>. Work normally in this session; run /loop commit when the batch is ready.`

- [ ] **Step 3: Status/session/prompt integration**

- `loopModeText`: return `"INTERACTIVE"` when `state.interactive`.
- `statusBarText`: interactive branch `Loop INTERACTIVE · <goal trimmed to 40 chars>`.
- `statusText`: leave as is; `/loop status` appends `interactiveStatusLines` in the handler.
- `session_start`: before the `state.active` pause block, add:

```ts
if (state.interactive) {
  ctx.ui.setStatus("loop", statusBarText());
  ctx.ui.notify("Interactive loop resumed; run /loop commit when the batch is ready.", "info");
  return;
}
```

- `before_agent_start`: when `state.interactive`, return the existing system prompt plus `interactiveSystemNote(state.description, INTERACTIVE_JOURNAL_FILE)`; do not consult `state.active` for this branch.
- Degenerate-repetition protection must keep running in interactive mode: change the guards in `context`, `message_start`, `message_update`, and `message_end` from `if (!state.active)` to `if (!state.active && !state.interactive)`. Do not change their bodies; the abort on degenerate streamed output is the only behavior interactive inherits from the loop machinery.
- `/loop status` handler: after the existing state text, if `state.interactive`, compute `drift = await countDrift(gitRunner(ctx), state.interactiveBaselineSha)`, `current = await collectBatchFacts(...)`, `stale = Boolean(state.interactivePlanHash) && state.interactivePlanHash !== planHash(current.diff, current.statusText)`, and append `interactiveStatusLines({ baselineSha, driftCount: drift, planAt: state.interactivePlanAt, planHashStale: stale })`.

- [ ] **Step 4: Command handler changes**

- At the top of the handler after `command` is computed, reject everything except the interactive-safe commands while interactive:

```ts
const interactiveSafe = new Set<string>(["commit", "status", "stats", "stop", "end", "help"]);
if (state.interactive && !interactiveSafe.has(command)) {
  ctx.ui.notify("Interactive mode is active. Use /loop commit or /loop stop first.", "error");
  return;
}
```

This also blocks the convenience `/loop <goal>` form, which would otherwise reset the state and silently end the batch.

- Add `command === "interactive"`: require `remainder`, `parseStartArgs(remainder)`, `applyGoalConfig`, then `await startInteractive(pi, ctx, parsed)`.
- In `/loop start`, `/loop goal ... --interactive` and the convenience `/loop <goal>` branch, after `applyGoalConfig`, if `parsed.interactive` then `await startInteractive(...)` and return.
- `stop` branch: if `state.interactive`, call `stopInteractive(state)`, persist, `ctx.ui.setStatus("loop", undefined)`, notify `"Interactive mode stopped; changes were left uncommitted."`; if the agent is busy, `ctx.abort()`; return.
- `help`: add `/loop interactive <goal>`, `/loop <goal> --interactive`, `/loop commit`, `/loop commit --apply`, and note the single batch checkpoint.
- `interactiveCommitGuard` is imported in Task 6, not here.

- [ ] **Step 5: Verify**

Run:

```bash
npm run lint
node --test tests/*.test.ts
```

Expected: `node --check` passes for all files; all tests PASS.

Manual operator smoke (run after the whole plan; record the result in PROGRESS-style notes):

1. In a scratch git repo, start Pi with this extension and run `/loop interactive demo --check "npm test"`.
2. A file named `INTERACTIVE-JOURNAL.md` exists and contains a `## Batch` header.
3. `/loop status` shows `Interactive: true`, the seven-char baseline and drift 0.
4. Restart the Pi session; `/loop status` still shows interactive mode.
5. `/loop run` is rejected with the interactive message.

- [ ] **Step 6: Commit**

```bash
git add extensions/index.ts
git commit -m "feat: start, status and stop interactive mode"
```

---

### Task 6: `/loop commit` plan phase

**Files:**
- Modify: `extensions/index.ts`
- Test: covered by Task 2 helpers; extension branch verified manually.

**Interfaces:**
- Consumes: `buildPlanPrompt`, `planHash`, `parseMarkerIds`, `resolveCommitMode`, `interactiveCommitGuard`, `collectBatchFacts`, `getHeadSha`.
- Produces in `extensions/index.ts`:
  - `async function sendInteractiveCommit(pi, ctx, apply: boolean): Promise<void>`
  - `async function handleInteractiveAgentEnd(pi, ctx, lastAssistantText: string): Promise<void>`
  - a `"commit"` command branch.

- [ ] **Step 1: Implement `sendInteractiveCommit`**

1. `const guard = interactiveCommitGuard(state.interactive, ctx.isIdle()); if (guard) notify error; return`.
2. `const facts = await collectBatchFacts(gitRunner(ctx), state.interactiveBaselineSha);` fail → notify.
3. `const hash = planHash(facts.diff, facts.statusText);`
4. `const mode = resolveCommitMode({ apply, hasPlan: Boolean(state.interactivePlan), planMatches: state.interactivePlanHash === hash });`
5. Set `state.interactiveCommitPending = mode === "plan" ? "plan" : "apply"`; persist; log `interactive_commit_request` with `{ mode }`.
6. Build the prompt with `buildPlanPrompt(...)` only for `mode === "plan"`. For `"apply"` and `"apply-replan"` use `buildApplyPrompt({... planText: mode === "apply" ? state.interactivePlan : ""})`; the empty-plan form tells the agent to generate the plan first and execute it in the same turn.
7. `pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, details: { kind: "interactive-commit", mode } }, { triggerTurn: true })`.
8. For `apply-replan`, notify `Batch changed since the plan; regenerating it and applying in this turn.`

- [ ] **Step 2: Handle agent end**

In `agent_end`, inside the existing `if (!state.active)` block after the preparing branch, add:

```ts
if (state.interactive) {
  const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
  await handleInteractiveAgentEnd(pi, ctx, messageToText(lastAssistant));
  return;
}
```

`handleInteractiveAgentEnd`:

- If `state.interactiveCommitPending !== "plan"`, return (apply handling comes in Task 7).
- If the marker is missing: notify `"No COMMIT_PLAN_READY from the agent; nothing stored."`, reset pending, persist, return.
- Read the plan file via `gitExec(ctx, ["bash", "-lc", "cat .pi-loop/interactive-commit-plan.md"])` or `pi.exec("bash", ...)`; if `code !== 0` or empty output, notify and reset pending.
- Recompute facts; if failed, notify and reset pending.
- Store `interactivePlan = planText.slice(0, 20_000)`, `interactivePlanHash = planHash(facts.diff, facts.statusText)`, `interactivePlanAt = Date.now()`, `interactiveCommitPending = ""`, `status = "stopped"`, `lastNotice`, persist.
- Notify with the atom ids and the plan file path; log `interactive_plan_ready`.

- [ ] **Step 3: Add the command branch**

Before the generic convenience section, add:

```ts
if (command === "commit") {
  const parsedCommit = parseCommitArgs(remainder);
  if (parsedCommit.unknown.length > 0) {
    ctx.ui.notify(`Unknown /loop commit options: ${parsedCommit.unknown.join(", ")}`, "error");
    return;
  }
  await sendInteractiveCommit(pi, ctx, parsedCommit.apply);
  return;
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run lint
node --test tests/*.test.ts
```

Expected: PASS.

Manual smoke (after Task 7 so apply exists, or now for plan only):

1. In interactive mode, change a file, then `/loop commit`.
2. The agent produces only a plan; `.pi-loop/interactive-commit-plan.md` exists; PROJECT files are unchanged except the journal.
3. `/loop status` shows `Plan: ready` and drift 0.
4. `/loop commit` again with no changes still builds a plan (no crash).

- [ ] **Step 5: Commit**

```bash
git add extensions/index.ts
git commit -m "feat: add /loop commit plan phase"
```

---

### Task 7: `/loop commit --apply`

**Files:**
- Modify: `extensions/index.ts`

**Interfaces:**
- Consumes: `buildApplyPrompt`, `formatCommitMessage`, `parseMarkerIds`, `parseCommitBlocked`, `commitAllCurrentChanges` (existing), `getHeadSha`, `ensureInteractiveJournal`, `resetInteractiveBatch`.
- Produces: apply branch in `handleInteractiveAgentEnd` and `async function finalizeInteractiveBatch(pi, ctx, ids: string[]): Promise<void>`.

- [ ] **Step 1: Extend `handleInteractiveAgentEnd`**

After the plan branch, handle `interactiveCommitPending === "apply"`:

1. `const blocked = parseCommitBlocked(text)`; if present: notify the reason, `interactiveCommitPending = ""`, persist, log `interactive_blocked`, return without touching git.
2. `const ids = parseMarkerIds(text, "COMMIT_APPLIED")`; if missing: notify `"No COMMIT_APPLIED or COMMIT_BLOCKED from the agent; nothing committed."`, reset pending, persist, return.
3. `await finalizeInteractiveBatch(pi, ctx, ids)`.

- [ ] **Step 2: Implement `finalizeInteractiveBatch`**

1. Re-collect facts; on failure notify, reset pending, persist, return.
2. `const commit = await commitAllCurrentChanges(ctx, formatCommitMessage(ids));` — this already runs `git add -A` and `git commit`. On `!commit.ok`: notify error, reset pending, persist, return.
3. `const newSha = (await getHeadSha(gitRunner(ctx))) ?? state.interactiveBaselineSha;`
4. If `commit.committed === false`, verify whether the batch is already committed: run `git diff --quiet <oldBaseline>`; only when the exit code is `0` (no diff) treat it as success, log `interactive_already_committed`. Otherwise notify `"Nothing staged; batch may be inconsistent."`, set `interactiveCommitPending = ""`, persist, and return without rebaselining.
5. On success: `state.interactiveBaselineSha = newSha`, `resetInteractiveBatch(state)`, `state.status = "stopped"`, `state.lastNotice = "Interactive batch committed."`, persist.
6. Delete the plan file: `gitExec(ctx, ["bash", "-lc", "rm -f .pi-loop/interactive-commit-plan.md"])`.
7. `await ensureInteractiveJournal(ctx)` to append the next `## Batch` header.
8. `ctx.ui.setStatus("loop", statusBarText())`; notify `Batch committed as <short sha> (atoms <ids>); interactive mode continues.`
9. Log `interactive_batch_committed` with `{ atoms: ids, sha: newSha }`.

- [ ] **Step 3: Verify**

Run:

```bash
npm run lint
node --test tests/*.test.ts
```

Expected: PASS.

Manual operator smoke:

1. Interactive mode, change two unrelated behaviours, `/loop commit`, review the plan.
2. `/loop commit --apply`; the agent edits GOAL.md/PROGRESS.md/TESTMANUAL.md, adds tests, runs them and the check, then one commit appears.
3. `git log --oneline -1` shows `loop: interactive batch (...)`.
4. `/loop status` shows the new baseline and `Plan: none`; interactive mode is still on.
5. Change a file after the plan, then `/loop commit --apply`; it re-plans first.
6. Force a failing test and run `/loop commit --apply`; the agent ends with `COMMIT_BLOCKED`, no commit is created and the plan is kept.

- [ ] **Step 4: Commit**

```bash
git add extensions/index.ts
git commit -m "feat: apply interactive commit batch"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `DOCUMENTATION.md`
- Modify: `DOCUMENTATION_ru.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (description mentions interactive mode)

- [ ] **Step 1: Document the mode**

README: add `Interactive mode` under the modes section with `/loop interactive <goal>` / `/loop <goal> --interactive`, `/loop commit`, `/loop commit --apply`, the baseline SHA guarantee, the journal, and the one-commit-per-batch rule. Add the commands to the command table. Keep both existing modes' text intact.

DOCUMENTATION.md and DOCUMENTATION_ru.md: full section covering entry, state fields, plan file `.pi-loop/interactive-commit-plan.md`, journal `INTERACTIVE-JOURNAL.md`, plan hash staleness, apply path, commit ownership parity, restart behavior, stop behavior, and the rejected commands. Russian text in `DOCUMENTATION_ru.md`; English elsewhere.

CHANGELOG: add an `Unreleased` entry describing interactive mode.

`package.json`: extend `description` with `plus an interactive mode that retroactively formalises a hand-edited batch into atoms and one Git checkpoint`.

- [ ] **Step 2: Full verification**

Run:

```bash
npm run lint
node --test tests/*.test.ts
git status --porcelain
```

Expected: lint passes, every test PASS, and only the intended documentation files are modified.

- [ ] **Step 3: Commit**

```bash
git add README.md DOCUMENTATION.md DOCUMENTATION_ru.md CHANGELOG.md package.json
git commit -m "docs: document interactive loop mode"
```
