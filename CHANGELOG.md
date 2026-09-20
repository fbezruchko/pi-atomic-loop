# Changelog

## 1.0.6 — Documentation cleanup and localization

- **Documentation localization**: the German version (`DOCUMENTATION_de.md`) is removed; a **Russian** version (`DOCUMENTATION_ru.md`) is added as an alternative to the English main documentation. All future documentation is English-first.
- **Install method**: the unsupported `npm` install path (`pi install npm:pi-atomic-loop`, "once published") is removed — the package is git-only for now. Installation is via git (`pi install git:github.com/fbezruchko/pi-atomic-loop@v1.0.6`) or a local checkout.
- **Fork remnants removed**: the upstream `pi-loop-mode` release history (2.2.0–2.5.4) is dropped from the CHANGELOG. The fork attribution in the README "About this fork" section and the 1.0.0 changelog entry are kept.

## 1.0.5

- **Plan dialogue in `/loop prepare`**: before writing the plan, the model now runs the new `atom-planning` skill — it interviews the user about implementation details (one question at a time, via `ask_user`), determines the expected solution complexity (`Complexity: mvp | standard | design`) and the implementing model class (`Model tier: strong | weak`). Both decisions are recorded in `GOAL.md` together with a new **Atom sizing** section: a strong-model plan uses larger cohesive atoms (several files allowed), a weak-model plan stays on tiny micro-atoms. The tier never changes `--model`; it only sizes atoms. Every atom session now respects the Atom sizing section when judging whether an atom is small enough.
- **`/loop prepare --quick`**: skips the dialogue and uses the old behavior as defaults (mvp + weak).

## 1.0.4

- **Hide the `Loop …` footer label when no cycle is active.** The extension set the status bar unconditionally on every `session_start`, so plain sessions (and new ones) always showed `Loop SUPERVISED` even though nothing was running. The label is now shown only while a cycle is active and cleared on `session_start` (inactive), `/loop stop`, `/loop end`, and the git-blocked abort path.

## 1.0.3

- **Clean context for supervised atoms**: `/loop run`, `/loop start` and `/loop resume` now create a genuinely fresh Pi session for every atom (same `newSession()` handoff as autonomous mode). Previously the supervised cycle kept running in the current session while its instructions claimed "This is a NEW Pi session" — the whole previous atom's context stayed in the window. After an atom completes, supervised mode stops and waits for `/loop resume` (which starts the next fresh session); autonomous mode continues spawning fresh sessions as before.
- **`/loop <goal>` sets the goal only**: the convenience form now has the same semantics as `/loop goal` — it stores goal + configuration and starts nothing. Starting is always explicit: `/loop prepare` (optional) then `/loop run`. One-shot start remains available via `/loop start <goal>`.
- **Dead code removed**: `runLoop()`, `resetCycleState()`, `sendFreshLoopTurn()` are gone; the fresh-session spawner (`startFreshAtomSession`) is now the single path for both modes. Help text and DOCUMENTATION.md (command reference, core concept) updated to match.

## 1.0.2

- **Fix `ctx.exec is not a function`**: the git helpers (`gitExec`, `ignoreLoopLog`) called `exec()` on the extension *context*, but in current pi `exec()` lives on the extension *API* object, not the context. They now call it via the captured API (`piGlobal!.exec`). All other `ctx.*` accesses were verified to map to valid context members.

## 1.0.1

- **Scripts fix**: `lint` now checks only the files that exist (`extensions/index.ts`, `src/*.ts`); the inherited `tests/*.test.ts` globs (there is no `tests/` directory in this repo) are removed. `test` is an honest no-op, since the package ships no test suite.

## 1.0.0 — Fork / rebrand (pi-atomic-loop)

- **Autonomous package**: renamed from the upstream `pi-loop-mode` to `pi-atomic-loop`; version numbering restarts at 1.0.0; author is now `fbezruchko`.
- **Fork attribution**: forked from upstream [`pi-loop-mode`](https://www.npmjs.com/package/pi-loop-mode) v2.5.4 by Robert Ressl (see README "About this fork").
- **Preview metadata removed**: dropped the `pi.video`/`pi.image` gallery fields and the `assets/` + `GALLERY.md` files — the old demo no longer reflects this extension's atomic-cycle behavior.
- **Install**: from git (`pi install git:github.com/fbezruchko/pi-atomic-loop@v1.0.0`) or a local path.

---


