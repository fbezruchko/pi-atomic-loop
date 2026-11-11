# Interactive loop mode — design

## Intent

Add a third loop mode to `pi-atomic-loop`: the user fixes `/loop <goal>`, then works
with the agent conversationally inside one session. The agent implements the user's
requests for real, but the loop controller creates no Git checkpoints, no fresh
sessions, and no atom markers. The batch of accumulated changes is retroactively
formalised as one or more atoms only when the user runs `/loop commit`.

The reason: some work is easier to drive by hand than to pre-plan as atoms, but the
project's durable artifacts (GOAL.md, PROGRESS.md, TESTMANUAL.md, tests, Git
checkpoints) must not be bypassed.

## Why this mode is separate

Today `/loop <goal>` only stores the goal, `/loop run` starts one atom in a fresh
session, and `CYCLE_DONE` / `MVP_READY` / `LOOP_DONE` in the assistant text make the
controller commit and stop. Interactive mode must not be affected by those markers:
the user's ordinary conversation must never be interpreted as a loop turn.

## Approaches considered

1. **Baseline commit + journal + post-hoc atoms (chosen).** Record the baseline HEAD
   SHA when interactive mode starts, never commit until `/loop commit`, have the
   agent keep a short request→change journal. At commit time the facts are
   `git diff <baseline>` (covers even accidental intermediate commits) plus the
   journal (which carries the user's intent, not visible in a diff).
2. **Journal only.** Survives restarts but can drift from the real code; rejected.
3. **Diff only.** Precise about code but loses the user's wording and reasoning;
   rejected because post-hoc atom definitions need intent.

## Mode entry

- `/loop interactive <goal> [--check "CMD"] [--model M] ...` — sets the goal and
  starts interactive mode immediately.
- `/loop <goal> --interactive` — same thing, flag form.
- `/loop prepare` remains optional and independent. Interactive mode does not
  require GOAL.md to exist beforehand; `/loop commit` creates it retroactively.

Starting interactive mode:

1. ensure a Git repository and local identity (reuse existing helpers);
2. create an initial baseline checkpoint if the repository is empty;
3. store `interactive = true`, `interactiveBaselineSha = git rev-parse HEAD`,
   `interactiveStartedAt`, `interactivePlan = ""`;
4. show the status bar as `Loop INTERACTIVE · <goal>`;
5. inject one short system-prompt note with the goal, the journal rule and the
   "do not commit / do not emit loop markers" rule. No per-turn loop instructions.

## During interactive mode

- `state.active` stays `false`; the controller's agent-side machinery (stuck
  detection, CYCLE_DONE handling, autonomous continuation, check after every turn)
  does not run. Degenerate-repetition protection may still run.
- The agent appends one short entry per substantive user request to
  `INTERACTIVE-JOURNAL.md` in the repo root:

  ```text
  ## <timestamp> — <request summary>
  Changed: <files/behaviour>
  Tests: <added/updated or none yet>
  Notes: <decisions, caveats>
  ```

  The file is committed with the batch, so the intent survives in history.
- The agent must not run `git commit`, must not emit `ATOM_STARTED` / `CYCLE_DONE` /
  `MVP_READY` / `LOOP_DONE`, and must not edit GOAL.md/PROGRESS.md retroactively
  until `/loop commit`. These are prompt rules; the controller does not rely on them
  (see baseline safety below).

## Baseline safety

- The baseline HEAD is stored in durable loop state. Accidental intermediate commits
  are tolerated: `git diff <baseline>` still shows every change since the baseline.
- The extension never reads "current HEAD" as the batch base.
- On `/loop status` the extension reports `git rev-list --count <baseline>..HEAD` as
  "intermediate commits since baseline" so the operator can see drift.
- `git add -N .` before hashing makes untracked files visible in the diff. It only
  marks intent-to-add and does not stage content; `git add -A` at commit finalises.

## `/loop commit` — plan phase

`/loop commit` (no flags) must not modify project files. It:

1. rejects unless interactive mode is on and the session is idle;
2. computes batch facts — `git diff --stat <baseline>`, `git status --porcelain`,
   journal path — and sends one instruction asking the agent to produce a plan only;
3. the agent writes the plan to `.pi-loop/interactive-commit-plan.md` and prints a
   short summary; required plan content:
   - proposed atoms (`Axxx — name`, goal, files, 2–3 positive and 2–3
     negative/error scenarios where meaningful, test file, verify command,
     acceptance criterion), one atom or several; the agent assigns atom IDs by
     the same rule it uses when it writes or extends GOAL.md in the other modes
     (continue the existing sequence, keep the file's conventions); the
     extension never allocates IDs;
   - tests to add or repair;
   - regression candidates (older completed atoms whose behaviour may be affected);
   - the check/test commands to run;
   - proposed commit message;
4. the agent ends with `COMMIT_PLAN_READY: <atom ids>`;
5. on `agent_end` the extension validates the plan file and marker, stores
   `interactivePlan = plan text`, `interactivePlanHash = sha256(diff since baseline)`,
   `interactivePlanAt`, and notifies the operator.

## `/loop commit --apply` — apply phase

Two paths:

- **Plan exists and hash matches** → the agent executes that plan.
- **No plan, or plan hash no longer matches** → the agent generates the plan and
  executes it in the same turn (explicitly trusted path).

The instruction asks the agent, in one turn:

1. retroactively add the atoms to GOAL.md as `COMPLETED` with a note
   `retrospective: interactive batch <baseline-short>`;
2. update PROGRESS.md (mode, MVP state, last completed atoms, known issues,
   next 3 atoms) and TESTMANUAL.md (only functionality that exists now);
3. write the missing focused tests to the project's atom standard;
4. run focused tests, then the configured `--check` command (if any);
5. apply the regression protocol if an older completed atom is affected;
6. end with `COMMIT_APPLIED: <atom ids>` only when everything is green, otherwise
   `COMMIT_BLOCKED: <reason>`.

On `COMMIT_APPLIED` the extension:

1. verifies the working tree;
2. `git add -A` and one commit: `loop: interactive batch (<Axxx–Ayyy>)`
   (single checkpoint; splitting an already-merged worktree per atom is fragile);
3. archives the plan: clears `.pi-loop/interactive-commit-plan.md`, records the new
   HEAD as `interactiveBaselineSha`, clears plan state, sets status `stopped`;
4. keeps interactive mode on, so the user can continue working and commit the next
   batch.

### Git commit ownership (parity with existing modes)

In supervised and autonomous mode the agent never runs `git commit`; the extension
commits the whole worktree after `CYCLE_DONE` / `MVP_READY` / `LOOP_DONE` via
`commitAtomicChanges()`. Anything that must be part of the commit (version bump,
CHANGELOG entry, generated metadata) is edited by the agent during the same turn,
before the completion marker. Tags are not created by the extension in any mode
today.

Interactive mode keeps exactly this split: the agent does every semantic step in
the apply turn (including version bump / CHANGELOG / any file a release requires),
then emits `COMMIT_APPLIED`; the extension only stages and commits. If a project
needs an annotated tag or a push, that stays a separate, explicit operator action,
as it is in the other modes.

On `COMMIT_BLOCKED`, or when no marker arrives, the extension leaves the worktree
untouched, keeps interactive mode and the plan, and notifies the operator.

## State model

Add to `LoopState` (persisted, restored, defaulted, sanitised):

```text
interactive: boolean
interactiveBaselineSha: string
interactiveStartedAt: number
interactivePlan: string          // truncated when persisted
interactivePlanHash: string
interactivePlanAt: number
interactiveCommitPending: "" | "plan" | "apply"
```

`Mode` in status text gains `INTERACTIVE`. `parseStartArgs` gains `interactive`
(`--interactive`) and `/loop commit` arguments are parsed by their own small parser
(`--apply` only), not by `parseStartArgs`.

## Command surface

```text
/loop interactive <goal>       start interactive mode (same as --interactive)
/loop <goal> --interactive     start interactive mode
/loop commit                   propose the atom plan; no file changes
/loop commit --apply           build the plan (if needed) and apply it + commit
/loop status                   shows INTERACTIVE, baseline, drift, plan state
/loop stop                     leave interactive mode; changes stay uncommitted
/loop end                      clear state (as today)
```

Rejected while interactive mode is on: `/loop run`, `/loop resume`, `/loop start`,
`/loop prepare` (ask the operator to `/loop commit` or `/loop stop` first).

## Session restart

Unlike an active supervised/autonomous loop, interactive mode is not paused on
restart because it never acts on its own: `session_start` keeps
`interactive = true`, restores the baseline and the plan, shows the status bar and
notifies "Interactive loop resumed; /loop commit when ready".

## What is left to the builder

- Exact wording of the injected instructions and system-prompt note.
- Whether to reuse `runGoalCheck` for the configured check during apply (yes) and how
  to surface its output.
- README / DOCUMENTATION / DOCUMENTATION_ru / CHANGELOG updates.

## Tests

- `src/arguments.ts`: `--interactive` parsing, flag removed from the description.
- `src/interactive.ts` (new, pure helpers): plan hash normalisation, atom-ID
  allocation, marker parsing (`COMMIT_PLAN_READY`, `COMMIT_APPLIED`,
  `COMMIT_BLOCKED`), plan validation.
- Extension wiring stays thin; the existing `tests/run-overrides.test.ts` keeps
  passing.
