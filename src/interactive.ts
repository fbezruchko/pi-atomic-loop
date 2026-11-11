import { createHash } from "node:crypto";

export type InteractiveMarker =
  | "COMMIT_PLAN_READY"
  | "COMMIT_APPLIED";

const ATOM_ID_RE = /^[A-Za-z0-9._-]+$/;

export function parseMarkerIds(
  text: string,
  marker: InteractiveMarker,
): string[] | undefined {
  const match = text.match(
    new RegExp(
      `\\b${marker}\\s*:\\s*([^\\r\\n]*)`,
      "i",
    ),
  );

  if (!match) {
    return undefined;
  }

  const ids = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0 &&
        ATOM_ID_RE.test(value),
    );

  return ids.length > 0
    ? ids
    : undefined;
}

export function parseCommitBlocked(
  text: string,
): string | undefined {
  const match = text.match(
    /\bCOMMIT_BLOCKED\s*:\s*([^\r\n]+)/i,
  );

  return match?.[1]?.trim() || undefined;
}

export function planHash(
  diff: string,
  statusText: string,
): string {
  return createHash("sha256")
    .update(diff)
    .update("\u0000")
    .update(statusText)
    .digest("hex");
}

export function formatCommitMessage(
  atomIds: string[],
): string {
  const ids = atomIds.filter(Boolean);

  if (ids.length === 0) {
    return "loop: interactive batch";
  }

  if (ids.length === 1) {
    return `loop: interactive batch (${ids[0]})`;
  }

  return `loop: interactive batch (${ids[0]}-${ids[ids.length - 1]})`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function interactiveCommitGuard(
  interactive: boolean,
  idle: boolean,
): string | undefined {
  if (!interactive) {
    return "Interactive mode is not active. Use /loop interactive <goal> first.";
  }

  if (!idle) {
    return "Finish the current turn before /loop commit.";
  }

  return undefined;
}

export type CommitMode =
  | "plan"
  | "apply"
  | "apply-replan";

export function resolveCommitMode(input: {
  apply: boolean;
  hasPlan: boolean;
  planMatches: boolean;
}): CommitMode {
  if (!input.apply) {
    return "plan";
  }

  return input.hasPlan && input.planMatches
    ? "apply"
    : "apply-replan";
}

export function interactiveSystemNote(
  goal: string,
  journalFile: string,
): string {
  return [
    "Interactive loop mode is active.",
    `Goal: ${goal || "-"}`,
    "",
    "The operator drives this session directly. Implement what the operator asks, conversationally.",
    "There is no atom selection, no completion marker, and no automatic Git checkpoint in this mode.",
    "",
    `Journal: append one short entry to ${journalFile} after each substantive request:`,
    "## <timestamp> — <request summary>",
    "Changed: <files/behaviour>",
    "Tests: <added/updated or none yet>",
    "Notes: <decisions, caveats>",
    "",
    "Rules:",
    "- Do not run git commit.",
    "- Do not emit ATOM_STARTED, CYCLE_DONE, MVP_READY or LOOP_DONE.",
    "- Do not edit GOAL.md, PROGRESS.md or TESTMANUAL.md until the operator runs /loop commit.",
    "- /loop commit handles retroactive formalisation, tests, regression checks and the single Git checkpoint.",
    "- /loop commit produces COMMIT_PLAN_READY (plan) and COMMIT_APPLIED (after the batch is green); the controller commits after the latter.",
    "- Changes stay uncommitted; the controller remembers the batch baseline commit.",
  ].join("\n");
}

export interface PlanPromptInput {
  goal: string;
  criteria: string;
  goalFile: string;
  baselineSha: string;
  journalFile: string;
  planFile: string;
  diffStat: string;
  changedPaths: string;
  checkCommand: string;
}

export type ApplyPromptInput = PlanPromptInput & {
  planText: string;
};

const ATOM_TEMPLATE = [
  "### Axxx — <short name>",
  "Status: COMPLETED",
  "Goal: <one concrete behaviour/change>",
  "Files: <exact files>",
  "Positive scenarios:",
  "1. <distinct positive scenario>",
  "2. <distinct positive scenario when meaningful>",
  "3. <distinct positive scenario when meaningful>",
  "Negative/error scenarios:",
  "1. <distinct negative/error scenario>",
  "2. <distinct negative/error scenario when meaningful>",
  "3. <distinct negative/error scenario when meaningful>",
  "Test: <test file and relevant cases>",
  "Verify: <exact command>",
  "Acceptance: <one observable criterion>",
];

function batchFacts(input: PlanPromptInput): string[] {
  return [
    `Goal: ${input.goal || "-"}`,
    `Completion criteria: ${input.criteria || "smallest user-testable MVP"}`,
    `Goal file: ${input.goalFile}`,
    `Batch baseline: ${shortSha(input.baselineSha) || "-"}`,
    `Journal: ${input.journalFile}`,
    `Plan file: ${input.planFile}`,
    `Configured check: ${input.checkCommand || "-"}`,
    "",
    "Git facts since the baseline:",
    input.diffStat || "(no diff stat)",
    "",
    "Changed paths:",
    input.changedPaths || "(none)",
  ];
}

export function buildPlanPrompt(
  input: PlanPromptInput,
): string {
  return [
    "Build a retroactive atom plan for the interactive batch.",
    "",
    "DO NOT modify project files in this phase. Only write the plan file and print a short summary.",
    "",
    ...batchFacts(input),
    "",
    "Read GOAL.md (when present), the journal, and the actual diff before planning.",
    "Split the batch into one or more atoms. Assign atom IDs by the same convention the project already uses in GOAL.md; continue the existing sequence. The controller does not allocate IDs.",
    "",
    `Write the plan to ${input.planFile}. It must contain:`,
    "- Proposed atoms with these fields (2-3 genuinely different positive and 2-3 negative/error scenarios where meaningful; do not manufacture duplicates):",
    "",
    ...ATOM_TEMPLATE,
    "",
    "- Tests to add or repair, with the exact files and cases.",
    "- Regression candidates: older completed atoms whose behaviour may be affected, and the retests required.",
    "- The check/test commands to run, including the configured check.",
    "- The proposed commit message.",
    "",
    "Do not weaken tests or implementation to make the plan look green.",
    "Print a short summary (atom IDs and names, test plan) after writing the file.",
    "End with exactly:",
    "COMMIT_PLAN_READY: <comma-separated atom ids>",
  ].join("\n");
}

export function buildApplyPrompt(
  input: ApplyPromptInput,
): string {
  const planText = input.planText.trim();

  const planSection = planText
    ? [
        "Execute this approved plan exactly:",
        "",
        planText,
      ]
    : [
        "No valid stored plan matched the current diff.",
        "Read GOAL.md (when present), the journal and the actual diff, generate the plan first, then execute it in this same turn.",
        "The plan must use the project's atom template and existing atom ID conventions.",
      ];

  return [
    "Apply the interactive batch: formalise it as atoms, tests, documentation and one Git checkpoint.",
    "",
    ...batchFacts(input),
    "",
    ...planSection,
    "",
    "Execution order:",
    "1. Retroactively append the atoms to GOAL.md with Status: COMPLETED and a line `Retrospective: interactive batch <baseline short sha>`. Keep the file's existing structure and numbering conventions.",
    "2. Update PROGRESS.md: mode, MVP state, last completed atoms, known issues, next 3 atoms.",
    "3. Update TESTMANUAL.md with only functionality that exists now.",
    "4. Write the missing focused tests required by the project's atom standard. Do not delete meaningful tests.",
    "5. Run the focused tests, then the configured check command when present. Fix failures.",
    "6. If an older completed atom is affected, apply the regression protocol: regression test, fix, origin tests, retest affected atoms.",
    "7. Perform release semantics that the project requires for this change (version bump, CHANGELOG entry, generated metadata) in this turn. The controller commits afterwards.",
    "8. Do not run git commit. Do not create tags. The controller stages and commits the whole batch.",
    "",
    "Only when every required test and the configured check are green, end with:",
    "COMMIT_APPLIED: <comma-separated atom ids>",
    "",
    "Otherwise end with:",
    "COMMIT_BLOCKED: <short reason>",
    "",
    "Keep the final response short.",
  ].join("\n");
}

export interface InteractiveStatusInput {
  baselineSha: string;
  driftCount: number;
  planAt: number;
  planHashStale: boolean;
}

export function interactiveStatusLines(
  input: InteractiveStatusInput,
): string[] {
  let plan: string;

  if (input.planAt <= 0) {
    plan = "Plan: none";
  } else {
    const when = new Date(input.planAt).toISOString();
    plan = input.planHashStale
      ? `Plan: STALE (${when})`
      : `Plan: ready (${when})`;
  }

  return [
    "INTERACTIVE: true",
    `Baseline: ${shortSha(input.baselineSha) || "-"}`,
    `Drift: ${input.driftCount} commit(s) since baseline`,
    plan,
  ];
}
