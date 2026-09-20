# Changelog

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
- **Install**: from git (`pi install git:github.com/fbezruchko/pi-atomic-loop@v1.0.0`), local path, or npm (once published).

---

## Upstream pi-loop-mode history (pre-fork)

The entries below are the upstream `pi-loop-mode` release history, kept for reference.

## 2.5.4

- **Early 512k-model compaction guidance**: documented project settings that reserve the full 65,536-token output budget and keep 150k recent tokens, preventing tool-heavy sessions from reaching the hard context boundary.
- **LLM-independent emergency compaction**: low-output `length` stops and saturated 400/context/token errors now compact from persisted loop state, durable project files, and file-operation metadata without calling the already-failing summarization model.
- **Context circuit breaker**: at most two emergency recoveries run without a successful assistant turn; the third context-pressure failure pauses with state preserved instead of creating an endless retry loop.
- **Manual recovery**: `/compact` at 85% or higher with saved loop state uses the same bounded local fallback when normal summarization can no longer fit.

## 2.5.3

- **License**: relicensed from MIT to GNU AGPL v3.0 only (`AGPL-3.0-only`).
- **Repeated-token degeneration detection**: the kill switch now catches a single word repeated 16× consecutively and short phrases of up to four words repeated 8×, not only complete repeated sentences. Detection and context sanitizing cover both visible text and provider thinking/reasoning blocks. Mid-stream aborts enter automatic stuck recovery instead of leaving unattended loops paused.
- **Documentation language switch**: `DOCUMENTATION.md` is now English (authoritative main documentation); the German version moved to `DOCUMENTATION_de.md` as a parallel translation. All future documentation is English-first.
- **`/loop-examples` prompt template** (`prompts/loop-examples.md`): inspects the current project and proposes ready-to-paste `/loop` commands for unattended improvement — endless product improvement, bug fixing with `--check`, coverage as a fitness function (`SCORE:`), feature roadmaps with the strong-prepare/cheap-run model split, safe refactoring, docs, and throttled overnight runs on weaker/local models. Optional focus argument: `/loop-examples tests`.
- **Bounded iteration log**: `.pi-loop-log.jsonl` now rotates at 5 MiB with one bounded `.1` backup; `/loop stats` reads only retained data and ignores malformed lines.
- **Soft stop** (`/loop finish`, alias `/loop soft-stop`): finish the in-flight iteration normally, then stop without scheduling a new turn. State is preserved for `/loop resume`. If issued between iterations (idle), the loop stops immediately. Pending soft stops survive restarts, asynchronous goal checks/model switches, and compaction callbacks through an `agent_settled` finalizer.
- **Rescue return fix**: loops started on the current model now return to that model after a rescue turn instead of remaining on the rescue model.
- **Branch-safe persistence**: session state restores only from the active session-tree branch.
- **Reliability test suite and modules**: lifecycle, checks, rescue, compaction, timers, parsing, state, repetition, and logging now have deterministic coverage; the runtime is split into focused `src/` modules.

- Fix: `/loop stop` and `/loop end` now actually stop the loop. Previously they only flipped the state flag: the in-flight agent turn kept running, already-queued loop follow-up messages still triggered new turns, and async continuations in `agent_end` (goal check, model switch) could overwrite the stop and reschedule the loop.
  - `stop`/`end` now abort the in-flight turn (`ctx.abort()`), which also flushes queued loop messages.
  - A monotonic run token invalidates all stale async continuations (delay timers, compaction callbacks, `agent_end` tails after awaits).
  - `sendLoopTurn` re-checks `state.active` before sending, so no code path can send a loop turn after a stop.

## 2.5.2

- Add a visible README preview image that links to the MP4 demo, so npmjs.com shows a gallery-style preview even though it does not render custom `pi.video` metadata as an embedded video.
- Update pi gallery asset URLs to versioned unpkg links for `2.5.2`.

## 2.5.1

- Add pi.dev gallery metadata (`pi.video` and `pi.image`) using public unpkg URLs.
- Add gallery assets: `assets/pi-loop-mode-demo.mp4` and `assets/pi-loop-mode-preview.png`.
- Add `GALLERY.md` documenting how the gallery assets are served and updated.

## 2.5.0

- **Rescue model** (`--rescue-model M`): after 3 consecutive stuck interventions, a stronger model takes over for a single cleanup turn (fix one thing, rewrite `PROGRESS.md`, update the `IMPROVEMENTS.md` backlog, leave a `NEXT:` line), then control returns to the loop model.
- **Anti-repetition sampling penalties**: after any stuck intervention, `frequency_penalty`/`presence_penalty` (0.5) and slightly raised temperature for 3 turns (OpenAI-compatible completions APIs only, e.g. vLLM/Ollama).
- **Automatic context compaction**: after 5 consecutive stuck interventions the context is compacted, with repetitive filler explicitly excluded from the summary.
- **Backlog-driven improvement mode**: after `LOOP_DONE` in endless mode, work is driven by an `IMPROVEMENTS.md` checklist with file paths and acceptance criteria; vague items are forbidden.
- **Per-iteration JSONL log** (`.pi-loop-log.jsonl`) and `/loop stats`: event distribution, interventions, productive iterations/hour, score trend.
- **Prompt jitter**: "continue" prompts are slightly varied to avoid deterministic repetition.
- Fix: `/loop run --rescue-model M` was parsed but not applied.

## 2.4.0

- **Degenerate-generation kill switch**: one sentence repeated within a single response is detected (≥ 4 repeats), the stream is aborted live (≥ 6 repeats), the stored message is truncated after the first repetition, and poisoned context is sanitized before every LLM call.

## 2.3.0

- **Near-duplicate detection**: consecutive responses ≥ 80 % similar (Jaccard on word trigrams, digits masked) count as stuck — catches rephrased repetition that exact fingerprints miss.
- **Window repetition**: the same response 3+ times in the recent window (catches alternating A-B-A-B loops).
- **Tool-call requirement**: 3 turns without any tool call trigger a stuck intervention; loop prompts forbid narration-only turns.
- **Hard-reset escalation**: from the 3rd consecutive stuck intervention, recent response openings are injected as banned phrases and the turn must start with a tool call.

## 2.2.0

- Separate goal/prepare/run phases with per-phase model selection (`/loop goal`, `/loop prepare --model M`, `/loop run --model M`).
- Objective goal function (`--check "CMD"`) with `SCORE:` tracking and regression prompts.
- Endless mode by default; `--until-done` for verified completion.
- Error retry with exponential backoff, auto-resume after restart/reload, stuck detection with rotating recovery strategies, no-progress audit, persistence via session entries.
