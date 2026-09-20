---
name: atom-planning
description: >
  Use during /loop prepare, before writing the loop plan. Interview the user
  about implementation details, determine the expected solution complexity
  (mvp / standard / design) and the implementing model class (strong / weak),
  then decompose the goal into atoms sized for that model strength.
---

# Atom Planning

Run this skill during `/loop prepare`, before writing `GOAL.md` or any plan.
The output is an agreed understanding of what to build, at which complexity
level, and with which atom granularity. No code is written in this phase.

## Steps

### 1. Explore project context

Read the relevant files, docs, and recent commits so questions are grounded
in the actual project state, not guesses.

### 2. Clarifying questions — one at a time

Ask focused questions about the intended implementation (purpose, constraints,
success criteria). Rules:

- One question per turn. If a topic needs more exploration, split it.
- Prefer `ask_user` with multiple-choice options when possible; open-ended is fine too.
- Do not re-ask anything the user already answered in the goal text or earlier.
- Separate what the user said from your own assumptions; invite correction.

### 3. Complexity level (mandatory question)

If the user has not stated it, ask how complex the solution should be:

```text
Complexity: <mvp | standard | design>

- mvp      — "quick-quick" throwaway build: no architecture, no polish,
             fastest working version; trade structure for speed
- standard — normal project structure with modest, pragmatic design
             decisions; tests and clarity where they are cheap
- design   — full engineering: architecture, interfaces, and docs come
             first; the plan reads like a short spec
```

### 4. Model tier (mandatory question)

If not stated, ask which class of model will implement the atoms:

```text
Model tier: <strong | weak>
```

The tier only sizes the atoms. The concrete model is set separately with
`--model`; never infer or change it from this answer.

| Tier  | Atom granularity |
|-------|------------------|
| strong | Atoms may be larger: one cohesive change, several files allowed, but still one behavior + tests per atom |
| weak   | Extremely small micro-atoms: one tiny behavior in one or two files, immediately verifiable |

### 5. Hand off to plan writing

Summarize the agreed understanding (goal, complexity, model tier, atom
granularity) in a short note for the user, then continue with the
`/loop prepare` instructions: write `GOAL.md` with

- `Complexity: <mvp | standard | design>` and `Model tier: <strong | weak>`
  right below "## Original User Request",
- an `## Atom sizing` section stating the chosen granularity,
- the atom queue sized accordingly (a strong-model plan may contain fewer,
  larger atoms; a weak-model plan many tiny ones),
- MVP definition and explicit non-goals (scaled to the complexity level).

If the user answers both mandatory questions themselves before asking, skip
straight to step 5.
