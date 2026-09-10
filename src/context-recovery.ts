import { readFileSync } from "node:fs";
import {
  isAbsolute,
  join,
} from "node:path";

import type {
  LoopState,
} from "./loop-state.ts";

export const CONTEXT_PRESSURE_PERCENT = 85;

export const LOW_OUTPUT_LENGTH_TOKENS = 32;

export const MAX_EMERGENCY_SUMMARY_CHARS =
  24_000;

const MAX_FILE_EXCERPT_CHARS = 4_000;

const MAX_FILE_LIST_ENTRIES = 100;

export interface ContextPressureInput {
  stopReason?: string;
  errorMessage?: string;
  outputTokens?: number;
  contextPercent?: number | null;
}

export interface EmergencyFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface EmergencyPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps: EmergencyFileOperations;
}

export interface EmergencyCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;

  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}

export function isContextPressure(
  input: ContextPressureInput,
): boolean {
  const percent =
    input.contextPercent ?? 0;

  const lowOutputLength =
    input.stopReason ===
      "length" &&
    (
      input.outputTokens ??
      Number.POSITIVE_INFINITY
    ) <=
      LOW_OUTPUT_LENGTH_TOKENS;

  const saturatedLength =
    input.stopReason ===
      "length" &&
    percent >=
      CONTEXT_PRESSURE_PERCENT;

  const contextLikeError =
    input.stopReason ===
      "error" &&
    /(?:\b400\b|context|token|length|maximum output)/i.test(
      input.errorMessage ??
        "",
    ) &&
    percent >=
      CONTEXT_PRESSURE_PERCENT;

  return (
    lowOutputLength ||
    saturatedLength ||
    contextLikeError
  );
}

function bounded(
  value: unknown,
  maxChars: number,
): string {
  const text =
    String(value ?? "").trim();

  return text.length <= maxChars
    ? text
    : `${text.slice(
        0,
        maxChars,
      )}\n[truncated]`;
}

function readDurableFile(
  cwd: string,
  file: string,
): string | undefined {
  try {
    const path =
      isAbsolute(file)
        ? file
        : join(cwd, file);

    const text =
      readFileSync(
        path,
        "utf8",
      ).trim();

    return text
      ? bounded(
          text,
          MAX_FILE_EXCERPT_CHARS,
        )
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildEmergencyCompaction(
  state: LoopState,
  preparation: EmergencyPreparation,
  cwd: string,
): EmergencyCompactionResult {
  const allModifiedFiles =
    new Set([
      ...preparation.fileOps
        .written,
      ...preparation.fileOps
        .edited,
    ]);

  const modifiedFiles =
    [
      ...allModifiedFiles,
    ]
      .sort()
      .slice(
        0,
        MAX_FILE_LIST_ENTRIES,
      );

  const readFiles =
    [
      ...preparation.fileOps.read,
    ]
      .filter(
        (file) =>
          !allModifiedFiles.has(
            file,
          ),
      )
      .sort()
      .slice(
        0,
        MAX_FILE_LIST_ENTRIES,
      );

  const durableFileNames = [
    state.goalFile ||
      "GOAL.md",
    "PROGRESS.md",
    "TESTMANUAL.md",
    "IMPROVEMENTS.md",
    "ASSUMPTIONS.md",
  ];

  const durableSections =
    [
      ...new Set(
        durableFileNames,
      ),
    ]
      .map(
        (file) => ({
          file,
          text:
            readDurableFile(
              cwd,
              file,
            ),
        }),
      )
      .filter(
        (
          entry,
        ): entry is {
          file: string;
          text: string;
        } => Boolean(entry.text),
      )
      .map(
        (entry) =>
          `### ${entry.file}\n${entry.text}`,
      );

  const fileContext =
    durableSections.length > 0
      ? durableSections.join(
          "\n\n",
        )
      : "No durable loop files were readable.";

  const files = [
    readFiles.length > 0
      ? `<read-files>\n${readFiles.join(
          "\n",
        )}\n</read-files>`
      : "<read-files>\n</read-files>",

    modifiedFiles.length > 0
      ? `<modified-files>\n${modifiedFiles.join(
          "\n",
        )}\n</modified-files>`
      : "<modified-files>\n</modified-files>",
  ].join(
    "\n\n",
  );

  const regressionState =
    state.regressionActive
      ? [
          "ACTIVE",
          `origin=${state.regressionOriginAtomId || "-"}`,
          `foundDuring=${
            state.regressionFoundDuringAtomId ||
            "-"
          }`,
          `suspended=${
            state.suspendedAtomId ||
            "-"
          }`,
          `affected=${
            state.regressionAffectedAtomIds.join(",") ||
            "-"
          }`,
          `retestRequired=${state.regressionRetestRequired}`,
          `passStreak=${state.regressionPassStreak}`,
          `description=${bounded(
            state.regressionDescription,
            1_500,
          )}`,
        ].join(
          "\n",
        )
      : "none";

  const autonomousState =
    state.untilDone
      ? [
          "AUTONOMOUS",
          `runStartedAt=${
            state.autonomousRunStartedAt ||
            "-"
          }`,
          `atomsCompletedThisRun=${
            state.atomsCompletedThisRun
          }`,
          `maxAtoms=${
            state.maxIterations > 0
              ? state.maxIterations
              : "unlimited"
          }`,
          `handoffPending=${
            state.autonomousHandoffPending
          }`,
        ].join(
          "\n",
        )
      : "SUPERVISED";

  const finalDirection =
    state.regressionActive
      ? "\n\n## Next Step\nRegression mode is active. Do NOT start or resume a new feature. Read the regression task in PROGRESS.md, fix the regression, run its focused regression test, then retest every affected completed atom listed above. Do not resume the suspended atom until the required retests pass and the regression is resolved."
      : `\n\n## Next Step\nRe-establish bearings from the working tree. Read ${state.goalFile}, PROGRESS.md and TESTMANUAL.md. If a current atom exists, resume that atom. Otherwise select the first relevant OPEN atom. Perform exactly one atomic task.`;

  const body =
    `## Goal\n` +
    `${bounded(
      state.description ||
        "No saved loop goal.",
      4_000,
    )}\n\n` +

    `## Completion Criteria\n` +
    `${bounded(
      state.completionCriteria ||
        "Smallest user-testable MVP.",
      2_000,
    )}\n\n` +

    `## Loop State\n` +
    `- Mode: ${
      state.untilDone
        ? "AUTONOMOUS"
        : "SUPERVISED"
    }\n` +
    `- Autonomous state:\n${autonomousState}\n` +
    `- Iteration: ${state.iterationCount}\n` +
    `- Current atom: ${state.currentAtomId || "-"}\n` +
    `- Last completed atom: ${state.lastCompletedAtomId || "-"}\n` +
    `- Suspended atom: ${state.suspendedAtomId || "-"}\n` +
    `- Atom session closed: ${state.atomCycleClosed}\n` +
    `- Status before recovery: ${state.status}\n` +
    `- Last check passed: ${state.lastCheckPassed ?? "unknown"}\n` +
    `- Last check score: ${state.lastCheckScore ?? "unknown"}\n` +
    `- Check fail streak: ${state.checkFailStreak}\n` +
    `- Last notice: ${bounded(
      state.lastNotice ||
        "none",
      1_000,
    )}\n\n` +

    `## Regression State\n` +
    `${regressionState}\n\n` +

    `## Durable Project Context\n` +
    `${fileContext}\n\n` +

    `## File Operations\n` +
    `${files}`;

  const summary =
    `${body.slice(
      0,
      MAX_EMERGENCY_SUMMARY_CHARS -
        finalDirection.length,
    )}${finalDirection}`;

  return {
    summary,
    firstKeptEntryId:
      preparation.firstKeptEntryId,
    tokensBefore:
      preparation.tokensBefore,
    details: {
      readFiles,
      modifiedFiles,
    },
  };
}
