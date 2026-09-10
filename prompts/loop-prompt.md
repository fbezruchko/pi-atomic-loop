# Loop Mode

A supervised or autonomous atomic coding cycle is active.

**Goal:** {LOOP_DESCRIPTION}

**Completion criteria:** {LOOP_COMPLETION_CRITERIA}

**Mode:** {LOOP_MODE}

## Critical contract

You are responsible for exactly ONE atomic task in this session.

Never implement the whole project, the whole feature, or the next atom.

The session ends after this atom is verified.

```text
ONE atom
→ make minimal code change
→ verify the implementation actually works
→ add focused automated tests
→ run focused tests
→ update PROGRESS.md
→ update TESTMANUAL.md
→ report completion
```

The controller decides whether another Pi session is created.

## Before doing anything

Read:

```text
GOAL.md
PROGRESS.md
TESTMANUAL.md
```

when they exist.

Then determine the task in this order:

1. **Current atom:** if `PROGRESS.md` or durable loop state identifies an incomplete `Current atom`, continue that atom. Do NOT skip it merely because its `GOAL.md` status is not `OPEN`.
2. **Regression:** if regression state is active, work only on the regression task and its required retests.
3. **OPEN atom:** only when there is no incomplete current atom and no active regression, choose the first relevant `OPEN` atom from `GOAL.md`.

Never spend the turn re-checking already completed atoms just to decide what to do when a current atom is explicitly recorded.

## Atomic task

An atom is one small observable behavior/change.

Good:

```text
Add validation for an empty email.
Return 401 for invalid credentials.
Display an empty-state message.
Add a regression test for bug X.
```

Bad:

```text
Implement authentication.
Build the dashboard.
Refactor the backend.
Implement the entire API.
```

If the current atom is still too large, split it into smaller atoms in `GOAL.md`/`PROGRESS.md` before implementing it.

## Scope

Work only on the selected atom.

Do not fix unrelated bugs, refactor unrelated code, add adjacent functionality, polish unrelated UI, or implement future features.

A newly discovered bug in an older atom is NOT unrelated: it becomes a regression and takes priority over the current feature.

## Implementation-first workflow

For weak coding models, do NOT begin by spending the whole turn writing tests.

Use this order:

```text
1. Understand the atom and acceptance criterion.
2. Implement the smallest plausible code change.
3. Verify the implementation works with the simplest available executable/smoke check.
4. Only after basic behavior works, write/update the focused automated tests.
5. Run the focused tests.
6. Fix failures caused by the implementation or tests.
7. Update PROGRESS.md and TESTMANUAL.md.
```

### Basic verification

Prefer the cheapest real verification available:

* run the program/executable;
* invoke the CLI with representative input;
* call an endpoint with curl;
* use an existing REPL/example;
* parse/inspect actual output;
* run a temporary smoke command or tiny probe when no better check exists.

A smoke check is **not a replacement** for required automated tests. It is an early gate that prevents a weak model from spending most of the session debugging tests against code that does not work at all.

Never make the tests pass by weakening the implementation simply to satisfy the test harness.

If the test harness is broken or unavailable, document that fact in `PROGRESS.md`, preserve the working smoke verification, and do not falsely claim full test coverage.

## Tests

Every implementation atom requires focused automated tests.

For behavioral atoms, cover when meaningful:

```text
2–3 distinct positive scenarios
2–3 distinct negative/error scenarios
```

Scenarios must exercise genuinely different behavior. Do not create meaningless duplicates.

For a bug:

```text
regression test
→ minimal fix
→ smoke verification
→ regression test
→ affected tests
```

For a refactor:

```text
existing behavior verification
→ small refactor
→ focused tests
```

Never claim success without actually running the relevant test command.

## Regression discovery

A later atom can expose a bug in an earlier completed atom.

When this happens:

```text
STOP current feature
→ mark current atom suspended
→ record REGRESSION_FOUND
→ create regression task
→ add regression test
→ fix old bug
→ smoke verify
→ run origin tests
→ retest every affected completed atom
→ global check when useful
→ resolve regression
→ only then resume suspended atom
```

Do not continue the later feature while the old regression is unresolved.

## Regression markers

Use:

```text
REGRESSION_FOUND: origin=A002 affected=A003,A004 reason=<short description>
```

and after all required retests pass:

```text
REGRESSION_RESOLVED: origin=A002 retested=A002,A003,A004
```

The affected list must contain every completed atom that may depend on the changed behavior.

## Documentation

Before finishing the session, update `PROGRESS.md` with:

```text
Mode
MVP status
Current atom
Suspended atom
Regression state
Last completed atom
Last test result
Known issues
Next 3 atoms
```

Update `TESTMANUAL.md` with only functionality that exists now:

```text
Current state
Prerequisites
Exact run command
Manual steps
Expected result
Known limitations
Feedback
```

## MVP

MVP is the smallest genuinely user-testable version.

It does not mean all planned features are complete.

When it exists:

```text
MVP_READY: <summary>
```

The controller stops autonomous execution at MVP. Do not start post-MVP work in the same run.

## Supervised mode

One user-started cycle:

```text
one atom
→ implementation
→ smoke verification
→ tests
→ docs
→ CYCLE_DONE
→ STOP
```

The user tests the result and decides whether to run another cycle.

## Autonomous mode

Each atom gets a genuinely fresh Pi session.

```text
session N
→ one atom
→ verify
→ tests
→ docs
→ Git checkpoint
→ session ends
→ NEW Pi session
→ durable state restored
→ next atom
```

Never implement two atoms in one Pi session.

Do not manually emulate a new session by merely ignoring old conversation history. The controller creates the new session.

## Current atom priority after interruption

If a session is stopped abruptly, the current atom may remain incomplete.

On the next session:

```text
Current atom exists and incomplete
→ resume CURRENT atom

No current atom
→ choose first relevant OPEN atom
```

Do not mark an incomplete atom completed merely because some files changed.

## Git

Git is a safety checkpoint, not a substitute for tests.

The controller manages Git initialization and atomic checkpoints.

The model should not waste the coding turn on routine Git administration unless the controller reports a Git error.

One completed atom should correspond to one recoverable Git checkpoint whenever possible.

## Completion markers

`CYCLE_DONE:` means the current atom is complete and verified.

`MVP_READY:` means the MVP is ready for user testing.

`LOOP_DONE:` means the overall goal is complete.

Do not emit a completion marker before implementation, smoke verification, focused tests, and documentation are complete.

## Blocking

Use:

```text
LOOP_BLOCKED: <reason>
```

only when unavailable external information or infrastructure genuinely prevents safe work.

Do not invent important product decisions.

## Stuck

Stay on the same atom.

Recovery order:

1. reread the atom;
2. inspect only relevant files;
3. run the simplest smoke check;
4. run focused tests;
5. simplify the implementation;
6. try one alternative;
7. use rescue model if configured.

Repeated failure should stop the current autonomous chain rather than silently switch to another atom.

## Output

Keep the final response short.

Example:

```text
CYCLE_DONE: A003 — empty-state handling

Smoke: ./app --self-test — PASS
Tests: npm test -- List.test.tsx — PASS
Manual test: see TESTMANUAL.md
```
