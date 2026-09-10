---
name: loop-skill
description: >
  Skill for supervised atomic development and autonomous overnight execution
  with weak/local coding models. Every implementation task is decomposed into
  tiny atoms, each with focused tests, basic runtime verification, durable
  documentation, and a Git checkpoint. Autonomous mode uses one fresh Pi
  session per atom.
---

# Loop Skill

## Purpose

The loop is designed for small or weak coding models.

Never give the model a large implementation problem. The fundamental unit is an **atomic task**:

```text
one small behavior/change
+
minimal working implementation
+
focused automated test
+
acceptance criterion
+
verification command
```

The loop has two modes.

## Supervised mode

Default.

One cycle:

```text
select/resume one atom
→ implement minimal change
→ verify basic behavior
→ write focused tests
→ run tests
→ update PROGRESS.md
→ update TESTMANUAL.md
→ Git checkpoint
→ STOP
```

The user tests the result and decides whether to continue.

## Autonomous mode

Enabled by:

```text
--until-done
```

Autonomous execution is:

```text
atom
→ implementation
→ basic runtime verification
→ focused tests
→ durable docs
→ Git checkpoint
→ NEW PI SESSION
→ restore durable state
→ next atom
→ ...
→ MVP / verified completion
→ STOP
```

Every atom gets a genuinely fresh Pi conversational context.

Conversation history is never project memory.

## Fresh-session isolation

A fresh autonomous atom must be executed through Pi's session replacement mechanism.

The replacement session must:

1. contain no parent conversational history;
2. receive the durable loop handoff;
3. restore the current atom/regression state;
4. execute exactly one atom;
5. end before another atom begins.

A controller-created session is identified by a **durable handoff marker**, not by an in-memory/module-level flag. Pi creates a new extension runtime for a replacement session, so module-local variables cannot be trusted across `/new`.

## Persistent state

The source of truth between sessions is:

```text
GOAL.md
PROGRESS.md
TESTMANUAL.md
ASSUMPTIONS.md
IMPROVEMENTS.md
source files
tests
git history
extension loop state
```

The conversation is not persistent project memory.

## Atomic decomposition

Every implementation atom in `GOAL.md` must contain:

```text
Task ID
Status
Goal
Files
Positive scenarios
Negative/error scenarios
Test
Verify
Acceptance
```

The first atom must be immediately actionable by a weak coding model.

Keep the decomposition sequential and tiny. If an atom requires several independent behaviors, split it before implementation.

## Test matrix rule

For behavioral atoms, when meaningful:

```text
2–3 genuinely different positive scenarios
2–3 genuinely different negative/error scenarios
```

Do not manufacture duplicate cases merely to reach a number.

Documentation-only or trivial non-behavioral atoms use the smallest meaningful verification.

## Implementation-first rule

Weak models frequently spend too much time fighting the test harness before the implementation works.

Therefore the execution order is:

```text
understand atom
→ implement minimal code
→ smoke/basic verification
→ focused automated tests
→ fix implementation/test failures
→ documentation
→ checkpoint
```

The early smoke check may use:

```text
executable invocation
CLI example
curl request
REPL/example
output parsing
small temporary probe
```

This smoke check does not replace required automated tests. It is an early sanity gate.

Never change correct product behavior merely to make a broken test pass.

If the test harness is genuinely unavailable, document the limitation instead of falsely claiming the atom is fully verified.

## Atom selection after interruption

The selection order is strict:

```text
1. active/incomplete current atom
2. active regression
3. first relevant OPEN atom
```

The `current atom` has priority even if its `GOAL.md` status is not `OPEN`.

An abruptly interrupted atom must not be silently skipped.

Do not spend the next session investigating completed atoms just because the current atom is recorded as `current`.

## Mandatory rules

1. One Pi session works on exactly one atom.
2. Never implement multiple independent behaviors in one session.
3. Never start the next atom in the current session.
4. Never jump over an incomplete current atom.
5. If an atom is too large, split it before implementing it.
6. Every implementation atom requires focused tests.
7. Verify the implementation works before investing heavily in tests.
8. Prefer 2–3 distinct positive and 2–3 distinct negative/error scenarios when meaningful.
9. Run the focused tests before claiming completion.
10. Update `PROGRESS.md`.
11. Update `TESTMANUAL.md`.
12. Keep the implementation minimal.
13. Prefer existing project patterns.
14. Preserve current functionality unless the atom explicitly changes it.
15. A regression in an older atom takes priority over the current feature.
16. Do not use conversation history as durable state.

## MVP

MVP means the smallest genuinely user-testable version.

It does not mean:

* all planned features;
* polished UI;
* every edge case;
* all backlog items;
* final architecture.

When MVP is available:

```text
MVP_READY: <summary>
```

Stop the autonomous chain.

Do not continue with post-MVP improvements.

## Regression protocol

A later atom may expose a bug in an earlier completed atom.

When this happens:

```text
current atom
→ regression found
→ suspend current atom
→ create/record regression task
→ write regression test
→ fix old atom
→ smoke verify
→ run origin atom tests
→ retest affected later completed atoms
→ global check when useful
→ resolve regression
→ resume suspended atom
```

Never ignore the old bug.

Never silently patch it while continuing the later feature.

Never declare the regression resolved until the required retests pass.

## Regression task

Represent a regression in `GOAL.md` or `PROGRESS.md` as:

```text
### R001 — Fix whitespace-only password validation

Status: OPEN

Origin atom:
A002

Found during:
A004

Goal:
Reject whitespace-only passwords.

Files:
- src/login.ts
- tests/login.test.ts

Regression test:
Whitespace-only password is rejected.

Retest:
- A002 tests
- A003 tests

Acceptance:
Regression test, origin tests, and affected completed atom tests pass.
```

## Regression dependency rule

When an older atom changes, every later completed atom that may depend on it must be retested.

Correct order:

```text
old atom fixed
→ regression test
→ old atom tests
→ affected later completed atom tests
→ global verification
→ regression resolved
→ suspended atom resumes
```

If any affected test fails, that failure becomes the next regression task.

## PROGRESS.md

`PROGRESS.md` is the cross-session handoff.

It must show:

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

If an atom is interrupted, keep it explicitly as the current atom until it is either completed or deliberately re-scoped.

## TESTMANUAL.md

After every atom, update:

```text
Current state
Prerequisites
Exact start/run command
Manual test steps
Expected result
Known limitations
Feedback
```

Document only functionality that exists now.

## Supervised mode

After one successful atom:

```text
CYCLE_DONE: A004
```

Then stop.

The user tests the result.

The next cycle is operator-driven.

## Autonomous mode

After one successful atom:

```text
CYCLE_DONE: A004
```

The controller:

1. persists durable state;
2. creates a Git checkpoint;
3. replaces the current Pi session;
4. restores state in the new session;
5. resumes the current atom if incomplete, otherwise selects the next relevant OPEN atom;
6. continues until MVP or verified completion.

Do not implement the next atom in the current session.

## Git

Git is a recovery mechanism and checkpoint boundary.

The controller is responsible for:

```text
git init when needed
local Git identity when needed
initial baseline checkpoint
pre-atom workspace checkpoint
per-atom checkpoint
regression checkpoint
```

The loop may encounter generated files from builds/tests between atoms. Active loop execution must not stop merely because such files make the working tree dirty. The controller checkpoints the current workspace before advancing.

Do not require the model to remember routine Git commands.

## Completion

Autonomous mode stops when:

* the configured check passes;
* MVP is reached;
* all completion criteria are satisfied;
* `LOOP_DONE:` is emitted and not contradicted by the configured check;
* a fatal blocker occurs;
* the regression circuit cannot safely recover;
* the operator stops the loop.

## Blocking

Use:

```text
LOOP_BLOCKED: <reason>
```

when external information or infrastructure is genuinely required.

Do not invent important product decisions.

Autonomous mode stops on a genuine blocker.

## Stuck

Stay on the same atom.

Recovery:

1. reread the atom;
2. inspect relevant files;
3. perform a simple smoke check;
4. run the focused test;
5. simplify;
6. try one alternative;
7. use rescue model if configured.

Repeated failure stops the current autonomous chain rather than switching to a different atom.
