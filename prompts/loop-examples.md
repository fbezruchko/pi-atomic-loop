---
description: >
  Inspect the actual project and propose commands for supervised atomic
  development or autonomous overnight execution with weak/local coding models.
  Every implementation task must be tiny, verified, tested, documented and
  checkpointed in Git.
argument-hint: "[focus: mvp|bugs|tests|regression|refactor|docs|quality]"
---

Inspect the actual project and propose concrete `/loop` commands.

Do not guess project paths, test commands, build commands or entry points.

## Inspect

Check:

* README;
* package manifest/build files;
* source tree;
* tests;
* test runner;
* build;
* lint;
* type checker;
* TODO/FIXME;
* user-visible entry points.

## Main rule

Every implementation cycle is exactly one atom:

```text
one atom
→ minimal implementation
→ smoke/basic verification
→ focused automated tests
→ PROGRESS.md
→ TESTMANUAL.md
→ Git checkpoint
→ stop / fresh session
```

## Current-atom rule

When creating commands or instructions, tell the model:

```text
If a current/incomplete atom is recorded in PROGRESS.md or durable loop state,
resume that atom first. Only when no current atom exists should the model choose
the first relevant OPEN atom from GOAL.md.
```

## Supervised MVP

```text
/loop start Implement exactly the current atom if one is recorded; otherwise implement the first OPEN atomic task from GOAL.md. First make the minimal implementation, then perform the simplest real smoke/basic verification available. Only after the behavior works, add/update focused automated tests covering 2–3 distinct positive scenarios and, where meaningful, 2–3 distinct negative/error scenarios. Run the focused tests, update PROGRESS.md and TESTMANUAL.md, then stop. Do not start another atom.
```

## Autonomous MVP

```text
/loop start Implement exactly one atom in this Pi session. Resume an incomplete current atom before selecting an OPEN atom. First implement the minimal code and perform a basic real verification. Then add/update focused tests with 2–3 distinct positive and, where meaningful, 2–3 distinct negative/error scenarios. Run the tests, update PROGRESS.md and TESTMANUAL.md, finish the atom, and let the controller create the next NEW Pi session. Do not implement the next atom in this session. --until-done
```

## Overnight with safety cap

```text
/loop start Execute GOAL.md as a sequence of tiny atoms. Use exactly one atom per Pi session. Resume any incomplete current atom before selecting an OPEN atom. For each atom: implement minimal code, perform basic smoke verification, add/update focused tests, run them, update PROGRESS.md and TESTMANUAL.md, then let the controller create a NEW Pi session. Stop on MVP/completion, genuine blocker, unresolved regression, repeated stuck state, or operator stop. --until-done --max 30
```

Here `--max 30` means at most 30 atoms in the autonomous run.

## Bug fix

```text
/loop start Fix exactly one selected bug. Add the focused regression test, but first make the smallest code fix and verify the behavior with the simplest available smoke check. Then run the regression test and affected tests, update PROGRESS.md and TESTMANUAL.md, checkpoint the result, and stop.
```

## Regression recovery

```text
/loop start Resolve exactly the active regression in PROGRESS.md. Do not resume the suspended feature. Add/run the regression test, make the smallest fix, perform a basic smoke verification, run the origin atom tests, retest every affected completed atom listed in the regression state, run the global check when useful, update PROGRESS.md and TESTMANUAL.md, then stop. Do not resume another feature in this session.
```

## Feature atom

```text
/loop start Implement exactly the current atom if one exists, otherwise the first OPEN atom from GOAL.md. Do not implement adjacent functionality. First make the minimal implementation and verify that it actually works. Then add/run focused tests with 2–3 distinct positive scenarios and, where meaningful, 2–3 distinct negative/error scenarios. Update PROGRESS.md and TESTMANUAL.md, then stop.
```

## Test atom

```text
/loop start Add focused automated tests for exactly one selected behavior. First confirm the existing behavior with a simple smoke/basic verification. Prefer 2–3 distinct positive scenarios and 2–3 distinct negative/error scenarios when meaningful. Do not refactor unrelated code. Run the tests and update PROGRESS.md and TESTMANUAL.md, then stop.
```

## Refactor atom

```text
/loop start Perform exactly one small behavior-preserving refactoring atom from GOAL.md. Verify the existing behavior first, make the smallest refactor, run focused tests and the broader regression check when useful, update PROGRESS.md and TESTMANUAL.md, then stop.
```

## Autonomous weak-model run

Recommended:

```text
/loop goal <goal>
/loop prepare --model <strong-model>
/loop run --model <cheap/local-model> --until-done
```

Use:

```text
/loop run --model <cheap/local-model> --until-done --max 30
```

when an explicit overnight atom cap is desired.

The controller, not the model, creates the fresh Pi session between atoms.

## Git

The controller manages Git checkpoints. Proposed commands should not depend on the weak model remembering `git add` or `git commit`.

Do not block an active loop merely because build/test commands left generated files in the working tree. The controller checkpoints the workspace before advancing.

## Regression rule

If a later atom exposes an older bug:

```text
current atom
→ suspend current atom
→ regression task
→ regression test
→ smallest fix
→ smoke verification
→ origin tests
→ affected completed atom tests
→ global check
→ regression resolved
→ NEW session
→ resume suspended atom
```

Never continue the later feature while the regression is unresolved.

## Final recommendation

For interactive work:

```text
/loop goal <goal>
/loop prepare --model <strong-model>
/loop run --model <cheap-model>
```

For overnight work:

```text
/loop goal <goal>
/loop prepare --model <strong-model>
/loop run --model <cheap-model> --until-done --max 30
```
