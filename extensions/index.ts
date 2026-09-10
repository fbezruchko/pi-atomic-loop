import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";

import {
  parseStartArgs,
  type StartArgs,
} from "../src/arguments.ts";

import {
  buildEmergencyCompaction,
  isContextPressure,
} from "../src/context-recovery.ts";

import {
  applyCheckOutcome,
  type CheckOutcome,
} from "../src/goal-check.ts";

import {
  appendLogEntry,
  formatLoopStats,
  LOG_FILE,
  readLogEntries,
} from "../src/loop-log.ts";

import {
  defaultState,
  persistedLoopState,
  restoreLoopState,
  STATE_ENTRY_TYPE,
  type LoopState,
} from "../src/loop-state.ts";

import {
  contentToText,
  detectDegenerateRepetition,
  fingerprint,
  messageToRepetitionText,
  messageToText,
  normalizeText,
  sanitizeDegenerateMessage,
  snippet,
  textSimilarity,
} from "../src/repetition.ts";

export {
  detectDegenerateRepetition,
  sanitizeDegenerateText,
} from "../src/repetition.ts";

export type {
  DegenerateInfo,
} from "../src/repetition.ts";

const MESSAGE_TYPE = "loop";

const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;

const SIMILARITY_THRESHOLD = 0.8;
const REPEAT_WINDOW_COUNT = 3;

const MAX_TOOLLESS_TURNS = 3;

const HARD_RESET_AFTER = 3;
const RESCUE_AFTER = 3;
const COMPACT_AFTER = 5;

const DEGENERATE_REPEATS = 4;
const DEGENERATE_STREAM_REPEATS = 6;
const DEGENERATE_CHECK_INTERVAL = 500;

const PENALTY_TURNS = 3;

/**
 * IMPORTANT:
 * One Pi session executes exactly one atomic task.
 *
 * Supervised mode:
 *   one session -> one atom -> stop.
 *
 * Autonomous mode:
 *   one session -> one atom -> newSession() -> next atom.
 */
const ATOMS_PER_SESSION = 1;

type TurnKind =
  | "start"
  | "resume"
  | "recover"
  | "stuck"
  | "rescue";

const STATE_CHANGE_RE =
  /\b(written|edited|changed|updated|created|deleted|renamed|committed|fixed|successfully|passed|installed)\b/i;

const ATOM_STARTED_RE =
  /\bATOM_STARTED\s*:\s*([A-Za-z0-9._-]+)/i;

const CYCLE_DONE_RE =
  /\bCYCLE_DONE\s*:\s*([A-Za-z0-9._-]+)/i;

const MVP_READY_RE =
  /\bMVP_READY\s*:/i;

const LOOP_DONE_RE =
  /\bLOOP_DONE\s*:/i;

const LOOP_BLOCKED_RE =
  /\bLOOP_BLOCKED\s*:/i;

const REGRESSION_FOUND_RE =
  /\bREGRESSION_FOUND\s*:\s*origin=([A-Za-z0-9._-]+)\s+affected=([A-Za-z0-9._,-]*)\s+reason=(.+)$/i;

const REGRESSION_RESOLVED_RE =
  /\bREGRESSION_RESOLVED\s*:\s*origin=([A-Za-z0-9._-]+)\s+retested=([A-Za-z0-9._,-]*)/i;

let state: LoopState = defaultState();

let pendingTimer:
  | ReturnType<typeof setTimeout>
  | undefined;

let runToken = 0;

let degenerateAbortPending = false;

let emergencyCompactionPending = false;

let lastDegenerateCheckLength = 0;

function clearPendingTimer(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }
}

function pushLimited<T>(
  items: T[],
  item: T,
  max: number,
): void {
  items.push(item);

  while (items.length > max) {
    items.shift();
  }
}

function bannedOpenings(): string {
  const openings = new Set<string>();

  for (
    const text of state.lastAssistantSnippets.slice(-3)
  ) {
    const words = text
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");

    if (words) {
      openings.add(`"${words}…"`);
    }
  }

  return (
    [...openings].join(", ") || "-"
  );
}

function hasStateChange(
  toolName: string,
  text: string,
  isError: boolean,
): boolean {
  if (isError) {
    return false;
  }

  if (
    toolName === "write" ||
    toolName === "edit"
  ) {
    return true;
  }

  return STATE_CHANGE_RE.test(text);
}

function recordToolResult(
  toolName: string,
  text: string,
  isError: boolean,
): void {
  pushLimited(
    state.recentToolResults,
    {
      tool: toolName,
      fingerprint: fingerprint(text),
      snippet: snippet(text),
      isError,
      time: Date.now(),
    },
    10,
  );

  if (
    hasStateChange(
      toolName,
      text,
      isError,
    )
  ) {
    state.lastStateChangeIteration =
      state.iterationCount + 1;
  }
}

function restoreState(
  ctx: ExtensionContext,
): void {
  state =
    restoreLoopState(
      ctx.sessionManager.getBranch(),
    );
}

function persistState(
  pi: ExtensionAPI,
): void {
  pi.appendEntry(
    STATE_ENTRY_TYPE,
    persistedLoopState(
      state,
    ),
  );
}

function persistStateToSession(
  ctx:
    | ExtensionCommandContext
    | ReplacedSessionContext,
): void {
  ctx.sessionManager.appendCustomEntry(
    STATE_ENTRY_TYPE,
    persistedLoopState(
      state,
    ),
  );
}

function resolveModel(
  ctx: ExtensionContext,
  spec: string,
) {
  const slash =
    spec.indexOf("/");

  if (slash > 0) {
    const found =
      ctx.modelRegistry.find(
        spec.slice(
          0,
          slash,
        ),
        spec.slice(
          slash + 1,
        ),
      );

    if (found) {
      return found;
    }
  }

  const all =
    ctx.modelRegistry.getAll();

  const lower =
    spec.toLowerCase();

  return (
    all.find(
      (m) =>
        m.id.toLowerCase() ===
        lower,
    ) ??
    all.find(
      (m) =>
        `${m.provider}/${m.id}`.toLowerCase() ===
        lower,
    ) ??
    all.find(
      (m) =>
        m.id
          .toLowerCase()
          .includes(lower),
    ) ??
    all.find(
      (m) =>
        `${m.provider}/${m.id}`
          .toLowerCase()
          .includes(lower),
    )
  );
}

async function switchModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: string,
): Promise<boolean> {
  const model =
    resolveModel(
      ctx,
      spec,
    );

  if (!model) {
    ctx.ui.notify(
      `Loop: model not found: ${spec}`,
      "error",
    );

    return false;
  }

  const ok =
    await pi.setModel(
      model,
    );

  if (!ok) {
    ctx.ui.notify(
      `Loop: no API key configured for ${model.provider}/${model.id}`,
      "error",
    );

    return false;
  }

  ctx.ui.notify(
    `Loop: model set to ${model.provider}/${model.id}`,
    "info",
  );

  return true;
}

/**
 * THIS FUNCTION WAS MISSING IN THE PREVIOUS VERSION.
 *
 * It is called by:
 *   /loop goal
 *   /loop start
 *   /loop run
 *   /loop <goal>
 */
function applyGoalConfig(
  parsed: StartArgs,
): void {
  const sameGoal =
    state.description ===
    parsed.description;

  const preservedPreparedAt =
    sameGoal
      ? state.preparedAt
      : 0;

  state = {
    ...defaultState(),

    description:
      parsed.description,

    completionCriteria:
      parsed.criteria,

    /**
     * In supervised mode the effective maximum is one atom.
     * In autonomous mode --max controls the maximum number of atoms
     * in the autonomous run.
     */
    maxIterations:
      parsed.untilDone
        ? parsed.maxIterations
        : ATOMS_PER_SESSION,

    untilDone:
      parsed.untilDone,

    delaySeconds:
      parsed.delaySeconds,

    checkCommand:
      parsed.checkCommand,

    checkTimeoutSeconds:
      parsed.checkTimeoutSeconds,

    goalFile:
      parsed.goalFile ||
      "GOAL.md",

    loopModel:
      parsed.model,

    rescueModel:
      parsed.rescueModel,

    preparedAt:
      preservedPreparedAt,

    status:
      "stopped",

    currentAtomId:
      "",

    lastCompletedAtomId:
      "",

    suspendedAtomId:
      "",

    regressionActive:
      false,

    regressionOriginAtomId:
      "",

    regressionFoundDuringAtomId:
      "",

    regressionAffectedAtomIds:
      [],

    regressionDescription:
      "",

    regressionPassStreak:
      0,

    regressionRetestRequired:
      false,

    atomsCompletedThisRun:
      0,

    atomCycleClosed:
      false,

    autonomousHandoffPending:
      false,

    autonomousRunStartedAt:
      0,
  };
}

function loopModeText(): string {
  return state.untilDone
    ? "AUTONOMOUS"
    : "SUPERVISED";
}

function logIteration(
  event: string,
  extra: Record<
    string,
    unknown
  > = {},
): void {
  appendLogEntry(
    LOG_FILE,
    {
      ts:
        new Date().toISOString(),

      iteration:
        state.iterationCount,

      event,

      model:
        state.rescueActive
          ? state.rescueModel
          : state.loopModel ||
            undefined,

      mode:
        state.untilDone
          ? "autonomous"
          : "supervised",

      atomId:
        state.currentAtomId ||
        undefined,

      score:
        state.lastCheckScore,

      checkPassed:
        state.lastCheckPassed,

      stuckStreak:
        state.consecutiveStuckCount,

      notice:
        state.lastNotice ||
        undefined,

      ...extra,
    },
  );
}

function iterationLabel(): string {
  return `${state.iterationCount}/${ATOMS_PER_SESSION}`;
}

function parseAtomStarted(
  text: string,
): string | undefined {
  const match =
    text.match(
      ATOM_STARTED_RE,
    );

  return match?.[1]?.trim();
}

function parseCycleDoneAtom(
  text: string,
): string | undefined {
  const match =
    text.match(
      CYCLE_DONE_RE,
    );

  return match?.[1]?.trim();
}

function parseRegressionFound(
  text: string,
):
  | {
      originAtomId: string;
      affectedAtomIds: string[];
      reason: string;
    }
  | undefined {
  const match =
    text.match(
      REGRESSION_FOUND_RE,
    );

  if (!match) {
    return undefined;
  }

  return {
    originAtomId:
      match[1].trim(),

    affectedAtomIds:
      match[2]
        .split(",")
        .map(
          (value) =>
            value.trim(),
        )
        .filter(Boolean),

    reason:
      match[3].trim(),
  };
}

function parseRegressionResolved(
  text: string,
):
  | {
      originAtomId: string;
      retestedAtomIds: string[];
    }
  | undefined {
  const match =
    text.match(
      REGRESSION_RESOLVED_RE,
    );

  if (!match) {
    return undefined;
  }

  return {
    originAtomId:
      match[1].trim(),

    retestedAtomIds:
      match[2]
        .split(",")
        .map(
          (value) =>
            value.trim(),
        )
        .filter(Boolean),
  };
}

function loopInstructions(
  kind: TurnKind,
): string {
  const lines: string[] = [];

  if (kind === "resume") {
    lines.push(
      "This is a NEW Pi session.",
      "Do not rely on previous conversation history.",
    );
  } else {
    lines.push(
      "Start the current atomic coding cycle.",
    );
  }

  lines.push(
    `Mode: ${loopModeText()}`,

    `Goal: ${
      state.description
    }`,

    `Completion criteria: ${
      state.completionCriteria ||
      "smallest user-testable MVP"
    }`,

    `Current atom: ${
      state.currentAtomId ||
      "select the first OPEN atom from GOAL.md"
    }`,

    `Last completed atom: ${
      state.lastCompletedAtomId ||
      "-"
    }`,

    `Iteration: ${
      state.iterationCount + 1
    }/${ATOMS_PER_SESSION}`,
  );

  if (
    state.regressionActive
  ) {
    lines.push(
      "",
      "REGRESSION MODE IS ACTIVE.",
      `Origin atom: ${
        state.regressionOriginAtomId ||
        "-"
      }`,
      `Found during: ${
        state.regressionFoundDuringAtomId ||
        "-"
      }`,
      `Suspended atom: ${
        state.suspendedAtomId ||
        "-"
      }`,
      `Affected completed atoms: ${
        state.regressionAffectedAtomIds.join(
          ", ",
        ) || "-"
      }`,
      `Description: ${
        state.regressionDescription ||
        "-"
      }`,
      "",
      "Do NOT work on the suspended feature.",
      "Fix the regression first.",
      "Run the regression test.",
      "Run the origin atom tests.",
      "Retest every affected completed atom.",
      "Only after every required retest passes may the suspended feature resume.",
    );
  }

  lines.push(
    "",
    "Before acting:",
    `1. Read ${state.goalFile}.`,
    "2. Read PROGRESS.md.",
    "3. Read TESTMANUAL.md when present.",
    "4. Select exactly one atomic task.",
    "5. Work only on that task.",

    "",
    "TEST REQUIREMENTS:",

    "- Every implementation atom requires focused automated tests.",
    "- Prefer 2–3 genuinely different positive scenarios when meaningful.",
    "- Prefer 2–3 genuinely different negative/error scenarios when meaningful.",
    "- Do not manufacture duplicate scenarios merely to reach a count.",

    "",
    "REGRESSION RULE:",

    "If the current task exposes a bug in an older completed atom, STOP the current task.",
    "Suspend it.",
    "Record REGRESSION_FOUND.",
    "Add a regression test.",
    "Fix the older atom.",
    "Retest the origin atom.",
    "Retest every affected completed atom.",
    "Do not continue the suspended task until the affected chain is green.",

    "",
    "Regression marker:",
    "REGRESSION_FOUND: origin=Axxx affected=Ayyy,Azzz reason=<short description>",

    "",
    "Regression resolution marker:",
    "REGRESSION_RESOLVED: origin=Axxx retested=Axxx,Ayyy,Azzz",

    "",
    "When beginning the selected atom:",
    "ATOM_STARTED: Axxx",

    "",
    "When the selected atom is complete:",
    "CYCLE_DONE: Axxx",

    "",
    "When a minimal user-testable MVP exists:",
    "MVP_READY: <summary>",

    "",
    "When the whole goal is complete:",
    "LOOP_DONE: <summary>",

    "",
    "Before stopping:",
    "Update PROGRESS.md.",
    "Update TESTMANUAL.md.",
    "Do not start another atom in this session.",
  );

  return lines.join(
    "\n",
  );
}

function prepareInstructions(): string {
  return [
    "Prepare the loop specification. DO NOT implement project functionality.",

    "",
    `Goal: ${state.description}`,

    `Completion criteria: ${
      state.completionCriteria ||
      "smallest user-testable MVP"
    }`,

    "",
    "The coding model may be weak/local.",

    "Therefore the roadmap MUST be decomposed into extremely small atomic tasks.",

    "",
    "Every implementation atom must contain:",

    "### A001 — <short name>",
    "Status: OPEN",
    "Goal: <one concrete behavior/change>",
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

    "",
    "Use 2–3 positive and 2–3 negative/error scenarios when meaningful.",
    "Do not manufacture artificial cases when fewer genuinely different scenarios exist.",

    "",
    "Define the smallest user-testable MVP.",

    "Define explicit non-goals.",

    "Create a sequential task queue.",

    "The first OPEN task must be immediately actionable by a weak coding model.",

    "",
    "REGRESSION POLICY:",

    "A later atom can expose a bug in an older completed atom.",

    "When this happens:",
    "1. Suspend the later atom.",
    "2. Create a regression task.",
    "3. Add a regression test.",
    "4. Fix the older atom.",
    "5. Run the origin atom tests.",
    "6. Retest all affected later completed atoms.",
    "7. Resume the suspended atom only after the dependency chain is green.",

    "",
    `Write ${state.goalFile}.`,

    'At the very top write "## Original User Request" and preserve the initiating request exactly.',

    "",
    "Update PROGRESS.md with:",
    "- MVP state",
    "- current atom",
    "- last completed atom",
    "- regression state",
    "- next three atoms",

    "",
    "Update TESTMANUAL.md with the current runnable functionality only.",

    "",
    "Do NOT implement any project task during preparation.",

    "",
    "End with GOAL_READY: <one-line summary>.",
  ].join(
    "\n",
  );
}

function resetCycleState(
  preserveAutonomousRun: boolean,
): void {
  state.active = true;

  state.startTime =
    Date.now();

  state.iterationCount =
    0;

  if (
    !preserveAutonomousRun
  ) {
    state.atomsCompletedThisRun =
      0;

    state.autonomousRunStartedAt =
      Date.now();
  }

  state.maxIterations =
    state.untilDone
      ? state.maxIterations
      : ATOMS_PER_SESSION;

  state.consecutiveStuckCount =
    0;

  state.consecutiveErrorCount =
    0;

  state.interventionCount =
    0;

  state.doneSignalCount =
    0;

  state.blockedSignalCount =
    0;

  state.lastAssistantFingerprints =
    [];

  state.lastAssistantSnippets =
    [];

  state.lastAssistantTexts =
    [];

  state.recentToolResults =
    [];

  state.turnsWithoutTools =
    0;

  state.toolCallsThisTurn =
    0;

  state.rescueActive =
    false;

  state.rescueReturnModel =
    "";

  state.penaltyTurnsRemaining =
    0;

  state.lastCompactIteration =
    0;

  state.softStopRequested =
    false;

  state.atomCycleClosed =
    false;

  state.autonomousHandoffPending =
    false;

  state.status =
    state.regressionActive
      ? "regression"
      : "running";

  state.lastNotice =
    "Atomic cycle started.";
}

function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  kind: TurnKind,
): void {
  runToken++;

  clearPendingTimer();

  degenerateAbortPending =
    false;

  emergencyCompactionPending =
    false;

  resetCycleState(
    false,
  );

  persistState(pi);

  ctx.ui.notify(
    state.untilDone
      ? "Autonomous loop started."
      : "Supervised atomic loop started.",
    "info",
  );

  ctx.ui.setStatus(
    "loop",
    statusBarText(),
  );

  sendLoopTurn(
    pi,
    kind,
    ctx,
  );
}

function sendLoopTurn(
  pi: ExtensionAPI,
  kind: TurnKind,
  ctx?: ExtensionContext,
): void {
  if (
    !state.active ||
    state.softStopRequested
  ) {
    return;
  }

  const idle =
    ctx?.isIdle() ??
    false;

  pi.sendMessage(
    {
      customType:
        MESSAGE_TYPE,

      content:
        loopInstructions(
          kind,
        ),

      display:
        true,

      details: {
        kind,

        iteration:
          state.iterationCount +
          1,

        atomId:
          state.currentAtomId ||
          undefined,

        mode:
          state.untilDone
            ? "autonomous"
            : "supervised",
      },
    },

    idle
      ? {
          triggerTurn:
            true,
        }
      : {
          triggerTurn:
            true,
          deliverAs:
            "followUp",
        },
  );
}

async function sendFreshLoopTurn(
  ctx: ReplacedSessionContext,
  kind: TurnKind,
): Promise<void> {
  await ctx.sendMessage(
    {
      customType:
        MESSAGE_TYPE,

      content:
        loopInstructions(
          kind,
        ),

      display:
        true,

      details: {
        kind,

        iteration:
          state.iterationCount +
          1,

        atomId:
          state.currentAtomId ||
          undefined,

        mode:
          "autonomous",
      },
    },

    {
      triggerTurn:
        true,
    },
  );
}

function scheduleLoopTurn(
  pi: ExtensionAPI,
  kind: TurnKind,
  delayMs: number,
  ctx?: ExtensionContext,
): void {
  clearPendingTimer();

  if (
    delayMs <= 0
  ) {
    sendLoopTurn(
      pi,
      kind,
      ctx,
    );

    return;
  }

  const token =
    runToken;

  pendingTimer =
    setTimeout(
      () => {
        pendingTimer =
          undefined;

        if (
          !state.active ||
          token !==
            runToken
        ) {
          return;
        }

        sendLoopTurn(
          pi,
          kind,
        );
      },
      delayMs,
    );
}

function statusBarText(): string {
  const atom =
    state.currentAtomId
      ? ` · ${state.currentAtomId}`
      : "";

  const regression =
    state.regressionActive
      ? " · REGRESSION"
      : "";

  const check =
    state.lastCheckScore !==
    undefined
      ? ` · score ${state.lastCheckScore}`
      : state.lastCheckPassed !==
          undefined
        ? ` · check ${
            state.lastCheckPassed
              ? "✓"
              : "✗"
          }`
        : "";

  return (
    `Loop ${loopModeText()}${atom}${regression}${check}`
  );
}

function statusText(
  ctx: ExtensionContext,
): string {
  return [
    `Active: ${state.active}`,

    `Status: ${state.status}`,

    `Mode: ${loopModeText()}`,

    `Goal: ${
      state.description ||
      "-"
    }`,

    `Current atom: ${
      state.currentAtomId ||
      "-"
    }`,

    `Last completed atom: ${
      state.lastCompletedAtomId ||
      "-"
    }`,

    `Suspended atom: ${
      state.suspendedAtomId ||
      "-"
    }`,

    `Regression active: ${
      state.regressionActive
    }`,

    `Regression origin: ${
      state.regressionOriginAtomId ||
      "-"
    }`,

    `Affected atoms: ${
      state.regressionAffectedAtomIds.join(
        ", ",
      ) || "-"
    }`,

    `Atoms completed this run: ${
      state.atomsCompletedThisRun
    }`,

    `Max atoms: ${
      state.maxIterations > 0
        ? state.maxIterations
        : "∞"
    }`,

    `Check: ${
      state.checkCommand ||
      "-"
    }`,

    `Check status: ${
      state.lastCheckPassed ===
      undefined
        ? "-"
        : state.lastCheckPassed
          ? "PASSING"
          : `FAILING (${state.checkFailStreak})`
    }`,

    `Goal file: ${
      state.goalFile
    }`,

    `Loop model: ${
      state.loopModel ||
      "-"
    }`,

    `Rescue model: ${
      state.rescueModel ||
      "-"
    }`,

    `Stuck streak: ${
      state.consecutiveStuckCount
    }`,

    `Last notice: ${
      state.lastNotice ||
      "-"
    }`,

    `Session entries: ${
      ctx.sessionManager
        .getEntries()
        .length
    }`,
  ].join(
    "\n",
  );
}

async function runGoalCheck(
  pi: ExtensionAPI,
): Promise<CheckOutcome> {
  try {
    const result =
      await pi.exec(
        "bash",
        [
          "-lc",
          state.checkCommand,
        ],
        {
          timeout:
            state.checkTimeoutSeconds *
            1000,
        },
      );

    const output =
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

    const scoreMatches =
      [
        ...output.matchAll(
          /SCORE:\s*(-?\d+(?:\.\d+)?)/gi,
        ),
      ];

    const score =
      scoreMatches.length >
      0
        ? Number.parseFloat(
            scoreMatches[
              scoreMatches.length -
                1
            ][1],
          )
        : undefined;

    return {
      passed:
        result.code === 0,

      score,

      output:
        snippet(
          output,
          400,
        ),

      execFailed:
        false,
    };
  } catch (error) {
    return {
      passed:
        false,

      score:
        undefined,

      output:
        snippet(
          String(error),
          200,
        ),

      execFailed:
        true,
    };
  }
}


function backoffSeconds(): number {
  const exponent =
    Math.min(
      Math.max(
        state.consecutiveErrorCount - 1,
        0,
      ),
      6,
    );

  return Math.min(
    MAX_BACKOFF_SECONDS,
    BASE_BACKOFF_SECONDS *
      2 ** exponent,
  );
}

async function interveneStuck(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): Promise<void> {
  const token =
    runToken;

  state.consecutiveStuckCount++;
  state.interventionCount++;

  state.status =
    "stuck";

  state.lastNotice =
    reason;

  state.turnsWithoutTools =
    0;

  state.penaltyTurnsRemaining =
    PENALTY_TURNS;

  if (
    state.rescueModel &&
    !state.rescueActive &&
    state.consecutiveStuckCount >=
      RESCUE_AFTER
  ) {
    const switched =
      await switchModel(
        pi,
        ctx,
        state.rescueModel,
      );

    if (
      !state.active ||
      token !==
        runToken
    ) {
      return;
    }

    if (switched) {
      state.rescueActive =
        true;

      persistState(pi);

      logIteration(
        "rescue_start",
        {
          reason,
        },
      );

      ctx.ui.notify(
        "Loop: rescue model is attempting the SAME atom.",
        "warning",
      );

      scheduleLoopTurn(
        pi,
        "rescue",
        0,
        ctx,
      );

      return;
    }
  }

  if (
    state.consecutiveStuckCount >=
    HARD_RESET_AFTER
  ) {
    state.active =
      false;

    state.status =
      "paused";

    state.lastNotice =
      `Atomic cycle stopped after repeated stuck recovery: ${reason}`;

    persistState(pi);

    logIteration(
      "cycle_stuck_stop",
      {
        reason,
      },
    );

    ctx.ui.notify(
      state.lastNotice,
      "warning",
    );

    return;
  }

  const delayMs =
    Math.min(
      60,
      2 **
        Math.min(
          state.consecutiveStuckCount,
          6,
        ),
    ) * 1000;

  if (
    state.consecutiveStuckCount >=
      COMPACT_AFTER &&
    state.iterationCount -
      state.lastCompactIteration >=
      COMPACT_AFTER
  ) {
    state.lastCompactIteration =
      state.iterationCount;

    persistState(pi);

    logIteration(
      "compact",
      {
        reason,
      },
    );

    ctx.compact({
      customInstructions:
        "Preserve only the current atomic task, regression state, acceptance criterion, focused tests, GOAL.md, PROGRESS.md and TESTMANUAL.md. Exclude unrelated planning.",

      onComplete:
        () => {
          if (
            !state.active ||
            token !==
              runToken
          ) {
            return;
          }

          scheduleLoopTurn(
            pi,
            "stuck",
            0,
            ctx,
          );
        },

      onError:
        () => {
          if (
            !state.active ||
            token !==
              runToken
          ) {
            return;
          }

          scheduleLoopTurn(
            pi,
            "stuck",
            delayMs,
            ctx,
          );
        },
    });

    return;
  }

  persistState(pi);

  logIteration(
    "stuck",
    {
      reason,
    },
  );

  if (
    !ctx.hasPendingMessages()
  ) {
    scheduleLoopTurn(
      pi,
      "stuck",
      delayMs,
      ctx,
    );
  }
}

function finalizeCurrentCycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  eventName: string,
  completed: boolean,
): void {
  runToken++;

  clearPendingTimer();

  degenerateAbortPending =
    false;

  emergencyCompactionPending =
    false;

  state.active =
    false;

  state.softStopRequested =
    false;

  state.status =
    completed
      ? "completed"
      : "stopped";

  state.lastNotice =
    message;

  persistState(pi);

  logIteration(
    eventName,
  );

  ctx.ui.notify(
    message,
    "info",
  );

  ctx.ui.setStatus(
    "loop",
    completed
      ? "Loop complete"
      : "Cycle complete — waiting",
  );
}

/**
 * Starts a fresh autonomous cycle in a new Pi session.
 *
 * Pi 0.84.4 exposes newSession() on ExtensionCommandContext and provides
 * the replacement-session command context via withSession().
 *
 * We deliberately omit parentSession so the next atom has a clean
 * conversational history.
 */

const STANDARD_LOOP_OWNED_FILES = new Set([
  "PROGRESS.md",
  "TESTMANUAL.md",
  "ASSUMPTIONS.md",
  "IMPROVEMENTS.md",
]);

function normalizeRepoPath(
  value: string,
): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

const LOOP_LOG_REPO_PATHS = new Set([
  normalizeRepoPath(LOG_FILE),
  ".pi-loop-log.jsonl",
  "pi-loop-log.jsonl",
  ".pi-loop-log.jsonl.1",
  "pi-loop-log.jsonl.1",
]);

function isLoopOwnedPath(
  path: string,
): boolean {
  const normalized =
    normalizeRepoPath(path);

  return (
    normalized ===
      normalizeRepoPath(
        state.goalFile ||
          "GOAL.md",
      ) ||
    STANDARD_LOOP_OWNED_FILES.has(
      normalized,
    ) ||
    LOOP_LOG_REPO_PATHS.has(
      normalized,
    )
  );
}

async function gitExec(
  ctx: ExtensionContext,
  args: string[],
  timeout = 30_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result =
      await ctx.exec(
        "git",
        args,
        { timeout },
      );

    return {
      code: result.code,
      stdout:
        result.stdout ?? "",
      stderr:
        result.stderr ?? "",
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: String(error),
    };
  }
}

async function gitIsRepository(
  ctx: ExtensionContext,
): Promise<boolean> {
  const result =
    await gitExec(
      ctx,
      [
        "rev-parse",
        "--is-inside-work-tree",
      ],
    );

  return (
    result.code === 0 &&
    result.stdout.trim() ===
      "true"
  );
}

async function gitStatus(
  ctx: ExtensionContext,
): Promise<string> {
  const result =
    await gitExec(
      ctx,
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
    );

  if (result.code !== 0) {
    return "";
  }

  return result.stdout.trim();
}

async function ensureGitIdentity(
  ctx: ExtensionContext,
): Promise<void> {
  const name =
    await gitExec(
      ctx,
      [
        "config",
        "--local",
        "--get",
        "user.name",
      ],
    );

  if (
    name.code !== 0 ||
    !name.stdout.trim()
  ) {
    await gitExec(
      ctx,
      [
        "config",
        "--local",
        "user.name",
        "Pi Loop",
      ],
    );
  }

  const email =
    await gitExec(
      ctx,
      [
        "config",
        "--local",
        "--get",
        "user.email",
      ],
    );

  if (
    email.code !== 0 ||
    !email.stdout.trim()
  ) {
    await gitExec(
      ctx,
      [
        "config",
        "--local",
        "user.email",
        "pi-loop@localhost",
      ],
    );
  }
}

async function ignoreLoopLog(
  ctx: ExtensionContext,
): Promise<void> {
  const candidates = [
    ...LOOP_LOG_REPO_PATHS,
  ].filter(Boolean);

  for (const path of candidates) {
    await ctx.exec(
      "bash",
      [
        "-lc",
        'mkdir -p .git/info; touch .git/info/exclude; grep -qxF -- "$1" .git/info/exclude 2>/dev/null || printf "%s\\n" "$1" >> .git/info/exclude',
        "pi-loop-ignore",
        path,
      ],
      {
        timeout: 10_000,
      },
    );
  }
}

function parseStatusPaths(
  status: string,
): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (line.length < 4) {
        return "";
      }

      const raw =
        line.slice(3).trim();

      if (
        raw.includes(" -> ")
      ) {
        return normalizeRepoPath(
          raw
            .split(" -> ")
            .at(-1) ??
            raw,
        );
      }

      if (
        raw.startsWith('"') &&
        raw.endsWith('"')
      ) {
        return normalizeRepoPath(
          raw.slice(1, -1),
        );
      }

      return normalizeRepoPath(raw);
    })
    .filter(Boolean);
}

async function commitAllCurrentChanges(
  ctx: ExtensionContext,
  message: string,
): Promise<{
  ok: boolean;
  committed: boolean;
  reason: string;
}> {
  const status =
    await gitStatus(ctx);

  if (!status) {
    return {
      ok: true,
      committed: false,
      reason:
        "working tree is clean",
    };
  }

  const add =
    await gitExec(
      ctx,
      ["add", "-A"],
    );

  if (add.code !== 0) {
    return {
      ok: false,
      committed: false,
      reason:
        `git add failed: ${snippet(
          add.stderr,
          320,
        )}`,
    };
  }

  const staged =
    await gitExec(
      ctx,
      [
        "diff",
        "--cached",
        "--quiet",
      ],
    );

  if (staged.code === 0) {
    return {
      ok: true,
      committed: false,
      reason:
        "nothing staged to commit",
    };
  }

  if (staged.code !== 1) {
    return {
      ok: false,
      committed: false,
      reason:
        `git staged-diff check failed: ${snippet(
          staged.stderr,
          320,
        )}`,
    };
  }

  const commit =
    await gitExec(
      ctx,
      [
        "commit",
        "-m",
        message,
      ],
      60_000,
    );

  if (commit.code !== 0) {
    return {
      ok: false,
      committed: false,
      reason:
        `git commit failed: ${snippet(
          commit.stderr,
          320,
        )}`,
    };
  }

  logIteration(
    "git_commit",
    { message },
  );

  return {
    ok: true,
    committed: true,
    reason:
      commit.stdout.trim() ||
      message,
  };
}

async function checkpointBeforeAtom(
  ctx: ExtensionContext,
): Promise<{
  ok: boolean;
  reason: string;
}> {
  const status =
    await gitStatus(ctx);

  if (!status) {
    return {
      ok: true,
      reason:
        "working tree is clean",
    };
  }

  const paths =
    parseStatusPaths(status);

  const unrelated =
    paths.filter(
      (path) =>
        !isLoopOwnedPath(path),
    );

  /**
   * The loop owns the repository while it is executing an active run.
   * This is intentional for overnight operation: build/test commands can
   * create or modify generated files between atom commits. Those changes
   * must not randomly stop the chain on the next atom.
   *
   * The current checkpoint is committed before advancing, so every state
   * change remains recoverable in Git.
   */
  if (
    unrelated.length > 0
  ) {
    const recovered =
      await commitAllCurrentChanges(
        ctx,
        "loop: recover workspace before next atom",
      );

    if (!recovered.ok) {
      return {
        ok: false,
        reason:
          `${recovered.reason} Unrelated paths were present: ${unrelated.join(
            ", ",
          )}`,
      };
    }

    logIteration(
      "git_workspace_recovery",
      {
        paths: unrelated,
        message:
          recovered.reason,
      },
    );

    return {
      ok: true,
      reason:
        "workspace checkpointed before next atom",
    };
  }

  const metadata =
    await commitAllCurrentChanges(
      ctx,
      "loop: checkpoint loop metadata",
    );

  if (!metadata.ok) {
    return {
      ok: false,
      reason:
        metadata.reason,
    };
  }

  return {
    ok: true,
    reason:
      metadata.reason,
  };
}

async function ensureGitRepository(
  ctx: ExtensionContext,
): Promise<{
  ok: boolean;
  reason: string;
}> {
  if (
    !(
      await gitIsRepository(ctx)
    )
  ) {
    const init =
      await gitExec(
        ctx,
        ["init"],
      );

    if (init.code !== 0) {
      return {
        ok: false,
        reason:
          `git init failed: ${snippet(
            init.stderr,
            240,
          )}`,
      };
    }

    logIteration(
      "git_init",
    );
  }

  await ensureGitIdentity(
    ctx,
  );

  await ignoreLoopLog(
    ctx,
  );

  const head =
    await gitExec(
      ctx,
      [
        "rev-parse",
        "--verify",
        "HEAD",
      ],
    );

  if (head.code !== 0) {
    const initialStatus =
      await gitStatus(ctx);

    if (!initialStatus) {
      return {
        ok: true,
        reason:
          "repository initialized and clean",
      };
    }

    const initial =
      await commitAllCurrentChanges(
        ctx,
        "loop: initial checkpoint",
      );

    if (!initial.ok) {
      return initial;
    }

    logIteration(
      "git_initial_commit",
    );

    return {
      ok: true,
      reason:
        "initial checkpoint committed",
    };
  }

  return checkpointBeforeAtom(
    ctx,
  );
}

async function commitAtomicChanges(
  ctx: ExtensionContext,
  message: string,
): Promise<{
  ok: boolean;
  committed: boolean;
  reason: string;
}> {
  await ignoreLoopLog(ctx);
  return commitAllCurrentChanges(
    ctx,
    message,
  );
}

async function startFreshAutonomousSession(
  ctx:
    | ExtensionCommandContext
    | ReplacedSessionContext,
): Promise<void> {
  const gitReady =
    await ensureGitRepository(
      ctx,
    );

  if (!gitReady.ok) {
    state.active = false;
    state.status = "paused";
    state.lastNotice =
      gitReady.reason;

    persistStateToSession(
      ctx,
    );

    logIteration(
      "git_blocked",
      { reason: gitReady.reason },
    );

    ctx.ui.notify(
      `Loop stopped: ${gitReady.reason}`,
      "error",
    );

    return;
  }

  const handoff =
    persistedLoopState({
      ...state,
      active: true,
      atomCycleClosed: false,
      autonomousHandoffPending:
        true,
      status:
        state.regressionActive
          ? "regression"
          : "running",
    });

  const modelSpec =
    state.loopModel;

  const result =
    await ctx.newSession({
      /** Never set parentSession: the next atom gets a clean context. */
      setup:
        async (
          sessionManager,
        ) => {
          sessionManager.appendCustomEntry(
            STATE_ENTRY_TYPE,
            handoff,
          );

          if (modelSpec) {
            const model =
              resolveModel(
                ctx,
                modelSpec,
              );

            if (model) {
              sessionManager.appendModelChange(
                model.provider,
                model.id,
              );
            }
          }
        },

      withSession:
        async (
          freshCtx,
        ) => {
          /**
           * From this point on ONLY freshCtx is used for session-bound APIs.
           * The old context has already been replaced and must not be reused.
           */
          state =
            restoreLoopState(
              freshCtx.sessionManager.getBranch(),
            );

          state.autonomousHandoffPending =
            false;
          state.active = true;
          state.atomCycleClosed = false;
          state.iterationCount = 0;
          state.startTime =
            Date.now();

          state.consecutiveStuckCount = 0;
          state.consecutiveErrorCount = 0;
          state.interventionCount = 0;
          state.doneSignalCount = 0;
          state.blockedSignalCount = 0;

          state.lastAssistantFingerprints = [];
          state.lastAssistantSnippets = [];
          state.lastAssistantTexts = [];
          state.recentToolResults = [];

          state.turnsWithoutTools = 0;
          state.toolCallsThisTurn = 0;

          state.rescueActive = false;
          state.rescueReturnModel = "";
          state.penaltyTurnsRemaining = 0;
          state.lastCompactIteration = 0;
          state.softStopRequested = false;

          state.status =
            state.regressionActive
              ? "regression"
              : "running";

          persistStateToSession(
            freshCtx,
          );

          logIteration(
            "new_session",
            {
              freshSession: true,
            },
          );

          /**
           * sendUserMessage is intentional: the new session contains only
           * the durable handoff entry plus this fresh task instruction.
           */
          await freshCtx.sendUserMessage(
            loopInstructions(
              "resume",
            ),
          );

          await freshCtx.waitForIdle();

          state =
            restoreLoopState(
              freshCtx.sessionManager.getBranch(),
            );

          if (
            state.status ===
              "completed"
          ) {
            return;
          }

          if (
            state.status ===
              "paused"
          ) {
            return;
          }

          /** Regression always wins over the normal atom queue. */
          if (
            state.regressionActive
          ) {
            state.active = true;
            state.status =
              "regression";

            await startFreshAutonomousSession(
              freshCtx,
            );

            return;
          }

          /**
           * If the atom completed, start the next atom ONLY through a fresh
           * session. Never schedule a normal follow-up in the same session.
           */
          if (
            state.lastCompletedAtomId
          ) {
            if (
              state.maxIterations >
                0 &&
              state.atomsCompletedThisRun >=
                state.maxIterations
            ) {
              state.active = false;
              state.status =
                "paused";
              state.lastNotice =
                `Autonomous atom limit reached (${state.maxIterations}).`;
              persistStateToSession(
                freshCtx,
              );
              logIteration(
                "max_reached",
              );
              return;
            }

            state.active = true;
            state.status =
              "running";
            state.currentAtomId = "";

            await startFreshAutonomousSession(
              freshCtx,
            );

            return;
          }

          /**
           * A current atom without completion means an interrupted/partial
           * atom. Keep it current and stop. /loop resume will finish it before
           * considering any OPEN atom.
           */
          state.active =
            false;
          state.status =
            "paused";
          state.lastNotice =
            state.currentAtomId
              ? `Atom ${state.currentAtomId} is incomplete; resume it before selecting another OPEN atom.`
              : "Atomic cycle ended without a completion marker.";

          persistStateToSession(
            freshCtx,
          );

          logIteration(
            "atom_incomplete",
          );

          freshCtx.ui.notify(
            state.lastNotice,
            "warning",
          );
        },
    });

  if (
    result.cancelled
  ) {
    state.active =
      false;
    state.status =
      "paused";
    state.lastNotice =
      "Autonomous fresh-session transition was cancelled.";

    persistState(
      piGlobal!,
    );
  }
}

let piGlobal:
  | ExtensionAPI
  | undefined;

export default function (
  pi: ExtensionAPI,
) {
  piGlobal =
    pi;

  pi.on(
    "session_before_compact",
    async (
      event,
      ctx,
    ) => {
      const saturatedManualCompaction =
        event.reason ===
          "manual" &&
        Boolean(
          state.description,
        ) &&
        (
          ctx.getContextUsage()
            ?.percent ?? 0
        ) >= 85;

      if (
        !emergencyCompactionPending &&
        !saturatedManualCompaction
      ) {
        return;
      }

      emergencyCompactionPending =
        false;

      return {
        compaction:
          buildEmergencyCompaction(
            state,
            event.preparation,
            ctx.cwd,
          ),
      };
    },
  );

function goalSummaryText(): string {
  return [
    `Goal: ${state.description || "-"}`,

    `Criteria: ${
      state.completionCriteria ||
      "-"
    }`,

    `Mode: ${
      state.untilDone
        ? "AUTONOMOUS"
        : "SUPERVISED"
    }`,

    "Atoms per Pi session: 1",

    `Autonomous atom limit: ${
      state.maxIterations > 0
        ? state.maxIterations
        : "∞"
    }`,

    `Check: ${
      state.checkCommand ||
      "-"
    }`,

    `Check timeout: ${
      state.checkTimeoutSeconds
    }s`,

    `Goal file: ${
      state.goalFile
    }`,

    `Prepared: ${
      state.preparedAt > 0
        ? new Date(
            state.preparedAt,
          ).toISOString()
        : "no"
    }`,

    `Loop model: ${
      state.loopModel ||
      "- (current model)"
    }`,

    `Rescue model: ${
      state.rescueModel ||
      "-"
    }`,

    `Current atom: ${
      state.currentAtomId ||
      "-"
    }`,

    `Last completed atom: ${
      state.lastCompletedAtomId ||
      "-"
    }`,

    `Suspended atom: ${
      state.suspendedAtomId ||
      "-"
    }`,

    `Regression active: ${
      state.regressionActive
    }`,

    `Regression origin: ${
      state.regressionOriginAtomId ||
      "-"
    }`,

    `Regression affected: ${
      state.regressionAffectedAtomIds.join(
        ", ",
      ) || "-"
    }`,

    `Atoms completed this run: ${
      state.atomsCompletedThisRun
    }`,
  ].join("\n");
}

  pi.registerCommand(
    "loop",
    {
      description:
        "Atomic loop: default = one atom; --until-done = autonomous atoms in fresh Pi sessions.",

      handler:
        async (
          args,
          ctx,
        ) => {
          const trimmed =
            args.trim();

          const [
            subcommand = "status",
            ...rest
          ] =
            trimmed.split(
              /\s+/,
            );

          const command =
            subcommand.toLowerCase();

          const remainder =
            rest
              .join(" ")
              .trim();

          if (
            command ===
            "start"
          ) {
            if (
              !remainder
            ) {
              ctx.ui.notify(
                'Usage: /loop start <goal> [--delay S] [--check "CMD"] [--check-timeout S] [--model M] [--rescue-model M] [--until-done] [--max N]',
                "error",
              );

              return;
            }

            const parsed =
              parseStartArgs(
                remainder,
              );

            applyGoalConfig(
              parsed,
            );

            const gitReady =
              await ensureGitRepository(
                ctx,
              );

            if (!gitReady.ok) {
              ctx.ui.notify(
                `Loop stopped: ${gitReady.reason}`,
                "error",
              );
              return;
            }

            if (
              state.loopModel &&
              !(
                await switchModel(
                  pi,
                  ctx,
                  state.loopModel,
                )
              )
            ) {
              return;
            }

            if (
              state.untilDone
            ) {
              await startFreshAutonomousSession(
                ctx,
              );
            } else {
              runLoop(
                pi,
                ctx,
                "start",
              );
            }

            return;
          }

          if (
            command ===
            "goal"
          ) {
            if (
              !remainder
            ) {
              ctx.ui.notify(
                `Loop goal:\n${goalSummaryText()}`,
                "info",
              );

              return;
            }

            if (
              state.active
            ) {
              ctx.ui.notify(
                "Loop is running. Use /loop stop first.",
                "error",
              );

              return;
            }

            const parsed =
              parseStartArgs(
                remainder,
              );

            applyGoalConfig(
              parsed,
            );

            persistState(
              pi,
            );

            ctx.ui.notify(
              `Goal set:\n${goalSummaryText()}\n\nNext: /loop prepare, then /loop run.`,
              "info",
            );

            return;
          }

          if (
            command ===
            "prepare"
          ) {
            if (
              !state.description
            ) {
              ctx.ui.notify(
                "No goal set. Use /loop goal <goal> first.",
                "error",
              );

              return;
            }

            if (
              state.active
            ) {
              ctx.ui.notify(
                "Loop is running. Use /loop stop first.",
                "error",
              );

              return;
            }

            const parsed =
              parseStartArgs(
                remainder,
              );

            if (
              parsed.goalFile
            ) {
              state.goalFile =
                parsed.goalFile;
            }

            if (
              parsed.model &&
              !(
                await switchModel(
                  pi,
                  ctx,
                  parsed.model,
                )
              )
            ) {
              return;
            }

            state.status =
              "preparing";

            persistState(
              pi,
            );

            ctx.ui.notify(
              `Preparing ${state.goalFile} with atomic decomposition…`,
              "info",
            );

            pi.sendMessage(
              {
                customType:
                  MESSAGE_TYPE,

                content:
                  prepareInstructions(),

                display:
                  true,

                details: {
                  kind:
                    "prepare",
                },
              },
              {
                triggerTurn:
                  true,
              },
            );

            return;
          }

          if (
            command ===
            "run"
          ) {
            if (
              !state.description
            ) {
              ctx.ui.notify(
                "No goal set. Use /loop goal <goal> first.",
                "error",
              );

              return;
            }

            if (
              state.active
            ) {
              ctx.ui.notify(
                "Loop is already running.",
                "error",
              );

              return;
            }

            const parsed =
              parseStartArgs(
                remainder,
              );

            if (
              parsed.model
            ) {
              state.loopModel =
                parsed.model;
            }

            if (
              parsed.rescueModel
            ) {
              state.rescueModel =
                parsed.rescueModel;
            }

            if (
              parsed.maxIterations >
              0
            ) {
              state.maxIterations =
                parsed.maxIterations;
            }

            if (
              parsed.untilDone
            ) {
              state.untilDone =
                true;
            }

            const gitReady =
              await ensureGitRepository(
                ctx,
              );

            if (!gitReady.ok) {
              ctx.ui.notify(
                `Loop stopped: ${gitReady.reason}`,
                "error",
              );
              return;
            }

            if (
              state.loopModel &&
              !(
                await switchModel(
                  pi,
                  ctx,
                  state.loopModel,
                )
              )
            ) {
              return;
            }

            if (
              state.untilDone
            ) {
              await startFreshAutonomousSession(
                ctx,
              );
            } else {
              runLoop(
                pi,
                ctx,
                "start",
              );
            }

            return;
          }

          if (
            command ===
            "resume"
          ) {
            if (
              !state.description
            ) {
              ctx.ui.notify(
                "No loop to resume. Use /loop start <goal>.",
                "error",
              );

              return;
            }

            if (
              state.active
            ) {
              ctx.ui.notify(
                "Loop is already running.",
                "error",
              );

              return;
            }

            const parsed =
              parseStartArgs(
                remainder,
              );

            if (
              parsed.model
            ) {
              state.loopModel =
                parsed.model;
            }

            if (
              parsed.rescueModel
            ) {
              state.rescueModel =
                parsed.rescueModel;
            }

            if (
              parsed.maxIterations >
              0
            ) {
              state.maxIterations =
                parsed.maxIterations;
            }

            if (
              parsed.untilDone
            ) {
              state.untilDone =
                true;
            }

            const gitReady =
              await ensureGitRepository(
                ctx,
              );

            if (!gitReady.ok) {
              ctx.ui.notify(
                `Loop stopped: ${gitReady.reason}`,
                "error",
              );
              return;
            }

            if (
              state.untilDone
            ) {
              await startFreshAutonomousSession(
                ctx,
              );
            } else {
              runLoop(
                pi,
                ctx,
                "resume",
              );
            }

            return;
          }

          if (
            command ===
              "finish" ||
            command ===
              "soft-stop"
          ) {
            if (
              !state.active
            ) {
              ctx.ui.notify(
                "No active loop cycle.",
                "error",
              );

              return;
            }

            state.softStopRequested =
              true;

            persistState(
              pi,
            );

            ctx.ui.notify(
              "Current atomic turn will finish and then stop.",
              "info",
            );

            return;
          }

          if (
            command ===
            "stop"
          ) {
            runToken++;

            clearPendingTimer();

            state.active =
              false;

            state.softStopRequested =
              false;

            state.status =
              "stopped";

            state.lastNotice =
              "Stopped by operator; state preserved.";

            persistState(
              pi,
            );

            if (
              !ctx.isIdle()
            ) {
              ctx.abort();
            }

            ctx.ui.notify(
              "Loop stopped.",
              "info",
            );

            return;
          }

          if (
            command ===
              "end" ||
            command ===
              "clear"
          ) {
            runToken++;

            clearPendingTimer();

            state =
              defaultState();

            persistState(
              pi,
            );

            ctx.ui.notify(
              "Loop state cleared.",
              "info",
            );

            return;
          }

          if (
            command ===
            "status"
          ) {
            ctx.ui.notify(
              `Loop state:\n${statusText(
                ctx,
              )}`,
              "info",
            );

            return;
          }

          if (
            command ===
            "stats"
          ) {
            ctx.ui.notify(
              formatLoopStats(
                readLogEntries(
                  LOG_FILE,
                ),
                state.startTime,
                LOG_FILE,
              ),
              "info",
            );

            return;
          }

          if (
            command ===
            "help"
          ) {
            ctx.ui.notify(
              "Loop workflow:\n" +
                "/loop goal <goal>\n" +
                "/loop prepare [--model M]\n" +
                "/loop run [--model M] — one supervised atom\n" +
                "/loop run --until-done [--model M] [--max N] — autonomous atoms in fresh Pi sessions\n" +
                "/loop resume — next supervised cycle / autonomous session\n" +
                "/loop status | /loop stats | /loop finish | /loop stop | /loop end\n\n" +
                "Every implementation atom requires focused tests.\n" +
                "Prefer 2–3 distinct positive and 2–3 distinct negative/error scenarios when meaningful.\n" +
                "A regression in an older atom suspends the current atom until affected completed atoms are retested.",
              "info",
            );

            return;
          }

          /**
           * Convenience:
           * /loop <goal>
           */
          const parsed =
            parseStartArgs(
              trimmed,
            );

          applyGoalConfig(
            parsed,
          );

          const gitReady =
            await ensureGitRepository(
              ctx,
            );

          if (!gitReady.ok) {
            ctx.ui.notify(
              `Loop stopped: ${gitReady.reason}`,
              "error",
            );
            return;
          }

          if (
            state.loopModel &&
            !(
              await switchModel(
                pi,
                ctx,
                state.loopModel,
              )
            )
          ) {
            return;
          }

          if (
            state.untilDone
          ) {
            await startFreshAutonomousSession(
              ctx,
            );
          } else {
            runLoop(
              pi,
              ctx,
              "start",
            );
          }
        },
    },
  );

  pi.on(
    "session_start",
    async (
      event,
      ctx,
    ) => {
      clearPendingTimer();

      emergencyCompactionPending =
        false;

      restoreState(
        ctx,
      );

      /**
       * A controller-created replacement session carries this durable marker.
       * The extension runtime is recreated for /new, so module-level flags
       * cannot be used to recognize an autonomous handoff.
       */
      if (
        state.autonomousHandoffPending &&
        event.reason === "new"
      ) {
        state.autonomousHandoffPending =
          false;
        state.active = true;
        state.atomCycleClosed = false;
        state.status =
          state.regressionActive
            ? "regression"
            : "running";
        persistState(pi);
        ctx.ui.setStatus(
          "loop",
          statusBarText(),
        );
        return;
      }

      /**
       * Important:
       *
       * We do NOT auto-start a new cycle here.
       *
       * Autonomous continuation is driven by the command-level
       * newSession()/withSession chain.
       *
       * This prevents a process restart from unexpectedly resurrecting
       * an old overnight run.
       */
      if (
        state.active
      ) {
        state.active =
          false;

        state.status =
          "paused";

        state.softStopRequested =
          false;

        state.lastNotice =
          "Cycle paused after session restart. Use /loop resume.";

        persistState(
          pi,
        );

        ctx.ui.notify(
          "Loop paused after session restart. Use /loop resume.",
          "warning",
        );
      }

      ctx.ui.setStatus(
        "loop",
        statusBarText(),
      );
    },
  );

  pi.on(
    "session_shutdown",
    async () => {
      clearPendingTimer();

      emergencyCompactionPending =
        false;
    },
  );

  pi.on(
    "agent_settled",
    async (
      _event,
      ctx,
    ) => {
      if (
        state.active &&
        state.softStopRequested
      ) {
        finalizeCurrentCycle(
          pi,
          ctx,
          "Current atomic cycle finished and was stopped.",
          "soft_stop",
          false,
        );
      }
    },
  );

  pi.on(
    "before_agent_start",
    async (
      event,
      ctx,
    ) => {
      if (
        state.atomCycleClosed
      ) {
        ctx.abort();
        return {
          systemPrompt:
            `${event.systemPrompt}\n\n` +
            "This atomic session is already closed. Do not perform any more work. The controller will create the next session if autonomous mode is active.",
        };
      }

      if (
        !state.active
      ) {
        return;
      }

      return {
        systemPrompt:
          `${event.systemPrompt}\n\n` +
          `Atomic loop mode is active: ${loopModeText()}.\n` +
          `Read ${state.goalFile}, PROGRESS.md and TESTMANUAL.md when present.\n` +
          `Work on exactly ONE atomic task.\n` +
          `Every implementation atom requires focused automated tests.\n` +
          `Prefer 2–3 distinct positive and 2–3 distinct negative/error scenarios when meaningful.\n` +
          `If an older completed atom contains a bug, suspend the current atom and repair the regression first.\n` +
          `Retest the origin atom and every affected completed atom before resuming.\n` +
          `Update PROGRESS.md and TESTMANUAL.md before finishing.`,
      };
    },
  );

  pi.on(
    "before_provider_request",
    async (
      event,
      ctx,
    ) => {
      if (
        !state.active ||
        state.penaltyTurnsRemaining <=
          0
      ) {
        return;
      }

      const api =
        String(
          (
            ctx.model as {
              api?: string;
            } | undefined
          )?.api ?? "",
        );

      if (
        api !==
        "openai-completions"
      ) {
        return;
      }

      const payload =
        event.payload;

      if (
        !payload ||
        typeof payload !==
          "object"
      ) {
        return;
      }

      const currentTemperature =
        (
          payload as {
            temperature?: number;
          }
        ).temperature;

      return {
        ...(payload as object),

        frequency_penalty:
          0.5,

        presence_penalty:
          0.5,

        temperature:
          Math.min(
            1.3,
            (
              currentTemperature ??
              0.7
            ) + 0.2,
          ),
      };
    },
  );

  pi.on(
    "context",
    async (
      event,
    ) => {
      if (
        !state.active
      ) {
        return;
      }

      let changed =
        false;

      const messages =
        event.messages.map(
          (
            message,
          ) => {
            if (
              (
                message as {
                  role?: string;
                }
              ).role !==
              "assistant"
            ) {
              return message;
            }

            const sanitized =
              sanitizeDegenerateMessage(
                message as {
                  content?: unknown;
                },
              );

            if (!sanitized) {
              return message;
            }

            changed =
              true;

            return sanitized as typeof message;
          },
        );

      return changed
        ? {
            messages,
          }
        : undefined;
    },
  );

  pi.on(
    "message_start",
    async (
      event,
    ) => {
      if (
        (
          event.message as {
            role?: string;
          }
        ).role ===
        "assistant"
      ) {
        lastDegenerateCheckLength =
          0;
      }
    },
  );

  pi.on(
    "message_update",
    async (
      event,
      ctx,
    ) => {
      if (
        !state.active ||
        degenerateAbortPending
      ) {
        return;
      }

      if (
        (
          event.message as {
            role?: string;
          }
        ).role !==
        "assistant"
      ) {
        return;
      }

      const text =
        messageToRepetitionText(
          event.message,
        );

      if (
        text.length -
          lastDegenerateCheckLength <
        DEGENERATE_CHECK_INTERVAL
      ) {
        return;
      }

      lastDegenerateCheckLength =
        text.length;

      const info =
        detectDegenerateRepetition(
          text,
          DEGENERATE_STREAM_REPEATS,
        );

      if (info) {
        degenerateAbortPending =
          true;

        ctx.ui.notify(
          `Loop: degenerate repetition ×${info.repeats} — aborting turn.`,
          "warning",
        );

        ctx.abort();
      }
    },
  );

  pi.on(
    "tool_result",
    async (
      event,
    ) => {
      if (
        !state.active
      ) {
        return;
      }

      const anyEvent =
        event as unknown as {
          toolName: string;
          content?: unknown;
          result?: {
            content?: unknown;
          };
          isError?: boolean;
        };

      const text =
        contentToText(
          anyEvent.content ??
            anyEvent.result
              ?.content,
        );

      recordToolResult(
        anyEvent.toolName,
        text,
        Boolean(
          anyEvent.isError,
        ),
      );

      state.toolCallsThisTurn++;
    },
  );

  pi.on(
    "message_end",
    async (
      event,
    ) => {
      if (
        !state.active ||
        event.message.role !==
          "assistant"
      ) {
        return;
      }

      const stopReason =
        (
          event.message as {
            stopReason?: string;
          }
        ).stopReason;

      if (
        stopReason ===
          "error" ||
        stopReason ===
          "aborted"
      ) {
        return;
      }

      const sanitized =
        sanitizeDegenerateMessage(
          event.message as {
            content?: unknown;
          },
        );

      const trackedMessage =
        sanitized ??
        event.message;

      const tracked =
        messageToText(
          trackedMessage,
        ) ||
        messageToRepetitionText(
          trackedMessage,
        );

      if (
        !tracked.trim()
      ) {
        return;
      }

      pushLimited(
        state.lastAssistantFingerprints,
        fingerprint(
          tracked,
        ),
        8,
      );

      pushLimited(
        state.lastAssistantSnippets,
        snippet(
          tracked,
        ),
        5,
      );

      pushLimited(
        state.lastAssistantTexts,
        tracked.slice(
          0,
          1500,
        ),
        4,
      );

      if (
        sanitized
      ) {
        return {
          message:
            sanitized as typeof event.message,
        };
      }
    },
  );

  pi.on(
    "agent_end",
    async (
      event,
      ctx,
    ) => {
      /**
       * Preparation.
       */
      if (
        !state.active
      ) {
        if (
          state.status ===
          "preparing"
        ) {
          const assistant =
            [
              ...event.messages,
            ]
              .reverse()
              .find(
                (
                  message,
                ) =>
                  message.role ===
                  "assistant",
              );

          const text =
            messageToText(
              assistant,
            );

          if (
            /\bGOAL_READY\s*:/i.test(
              text,
            )
          ) {
            state.preparedAt =
              Date.now();

            state.status =
              "stopped";

            state.lastNotice =
              "Goal prepared.";

            persistState(
              pi,
            );

            ctx.ui.notify(
              `Goal preparation complete. Review ${state.goalFile}.`,
              "info",
            );
          }
        }

        return;
      }

      clearPendingTimer();

      const token =
        runToken;

      const lastAssistant =
        [
          ...event.messages,
        ]
          .reverse()
          .find(
            (
              message,
            ) =>
              message.role ===
              "assistant",
          ) as
          | {
              role: string;
              content?: unknown;
              stopReason?: string;
              errorMessage?: string;
              usage?: {
                output?: number;
              };
            }
          | undefined;

      const lastAssistantText =
        messageToText(
          lastAssistant,
        );

      const repetitionText =
        messageToRepetitionText(
          lastAssistant,
        );

      const stopReason =
        lastAssistant?.stopReason;

      if (
        state.softStopRequested
      ) {
        finalizeCurrentCycle(
          pi,
          ctx,
          "Current atomic cycle finished and was stopped.",
          "soft_stop",
          false,
        );

        return;
      }

      const contextPercent =
        ctx.getContextUsage()
          ?.percent ??
        null;

      if (
        lastAssistant &&
        isContextPressure({
          stopReason,
          errorMessage:
            lastAssistant.errorMessage,
          outputTokens:
            lastAssistant.usage
              ?.output,
          contextPercent,
        })
      ) {
        state.consecutiveErrorCount++;
        state.totalErrorCount++;

        const reason =
          snippet(
            lastAssistant.errorMessage ??
              `stop reason ${stopReason}`,
            140,
          );

        if (
          state.consecutiveErrorCount >=
          3
        ) {
          state.active =
            false;

          state.status =
            "paused";

          state.lastNotice =
            `Context recovery stopped the current atom: ${reason}`;

          persistState(
            pi,
          );

          logIteration(
            "context_circuit_open",
            {
              reason,
            },
          );

          return;
        }

        state.status =
          "retrying";

        state.lastNotice =
          `Emergency context recovery: ${reason}`;

        persistState(
          pi,
        );

        emergencyCompactionPending =
          true;

        ctx.compact({
          customInstructions:
            "Preserve current atomic task, regression state, acceptance criterion, focused tests, GOAL.md, PROGRESS.md and TESTMANUAL.md. Do not introduce unrelated work.",

          onComplete:
            () => {
              emergencyCompactionPending =
                false;

              if (
                !state.active ||
                token !==
                  runToken
              ) {
                return;
              }

              scheduleLoopTurn(
                pi,
                "recover",
                0,
                ctx,
              );
            },

          onError:
            () => {
              emergencyCompactionPending =
                false;

              if (
                !state.active ||
                token !==
                  runToken
              ) {
                return;
              }

              scheduleLoopTurn(
                pi,
                "recover",
                1000,
                ctx,
              );
            },
        });

        return;
      }

      if (
        !lastAssistant ||
        stopReason ===
          "error"
      ) {
        state.consecutiveErrorCount++;
        state.totalErrorCount++;

        state.status =
          "retrying";

        const delay =
          backoffSeconds();

        state.lastNotice =
          `Model/provider error; retrying current atom in ${delay}s.`;

        persistState(
          pi,
        );

        logIteration(
          "error",
          {
            reason:
              snippet(
                lastAssistant?.errorMessage ??
                  lastAssistantText ??
                  "no assistant message",
                160,
              ),
          },
        );

        scheduleLoopTurn(
          pi,
          "recover",
          delay * 1000,
        );

        return;
      }

      if (
        stopReason ===
          "aborted" &&
        degenerateAbortPending
      ) {
        degenerateAbortPending =
          false;

        await interveneStuck(
          pi,
          ctx,
          "degenerate response repetition",
        );

        return;
      }

      if (
        stopReason ===
        "aborted"
      ) {
        state.active =
          false;

        state.status =
          "paused";

        state.lastNotice =
          "Turn aborted by operator.";

        persistState(
          pi,
        );

        return;
      }

      state.consecutiveErrorCount =
        0;

      state.iterationCount++;

      if (
        state.toolCallsThisTurn ===
        0
      ) {
        state.turnsWithoutTools++;
      } else {
        state.turnsWithoutTools =
          0;
      }

      state.toolCallsThisTurn =
        0;

      const startedAtom =
        parseAtomStarted(
          lastAssistantText,
        );

      if (
        startedAtom
      ) {
        state.currentAtomId =
          startedAtom;
      }

      /**
       * Regression discovery ALWAYS has priority.
       */
      const regression =
        parseRegressionFound(
          lastAssistantText,
        );

      if (
        regression
      ) {
        state.regressionActive =
          true;

        state.status =
          "regression";

        state.regressionOriginAtomId =
          regression.originAtomId;

        state.regressionFoundDuringAtomId =
          state.currentAtomId;

        state.suspendedAtomId =
          state.currentAtomId;

        state.regressionAffectedAtomIds =
          [
            ...new Set(
              regression.affectedAtomIds,
            ),
          ];

        state.regressionDescription =
          regression.reason;

        state.regressionPassStreak =
          0;

        state.regressionRetestRequired =
          true;

        state.lastNotice =
          `Regression found in ${
            regression.originAtomId
          } while working on ${
            state.regressionFoundDuringAtomId ||
            "-"
          }.`;

        persistState(
          pi,
        );

        logIteration(
          "regression_found",
          {
            originAtomId:
              regression.originAtomId,

            affectedAtomIds:
              regression.affectedAtomIds,

            reason:
              regression.reason,
          },
        );

        state.active =
          false;

        return;
      }

      /**
       * Regression resolution.
       */
      const resolved =
        parseRegressionResolved(
          lastAssistantText,
        );

      if (
        resolved &&
        state.regressionActive
      ) {
        const required =
          new Set<string>(
            state.regressionAffectedAtomIds,
          );

        const retested =
          new Set<string>(
            resolved.retestedAtomIds,
          );

        const allRequired =
          [
            ...required,
          ].every(
            (atomId) =>
              retested.has(
                atomId,
              ),
          );

        if (
          allRequired
        ) {
          state.regressionActive =
            false;

          state.regressionRetestRequired =
            false;

          const gitCommit =
            await commitAtomicChanges(
              ctx,
              `loop: resolve regression ${resolved.originAtomId}`,
            );

          if (!gitCommit.ok) {
            state.active = false;
            state.status = "paused";
            state.lastNotice = gitCommit.reason;
            persistState(pi);
            logIteration("git_blocked", { reason: gitCommit.reason });
            return;
          }

          state.regressionPassStreak =
            1;

          state.atomCycleClosed =
            true;

          state.status =
            "stopped";

          state.lastNotice =
            `Regression ${resolved.originAtomId} resolved and affected atoms retested.`;

          persistState(
            pi,
          );

          logIteration(
            "regression_resolved",
            {
              originAtomId:
                resolved.originAtomId,

              retestedAtomIds:
                resolved.retestedAtomIds,
            },
          );

          state.active =
            false;

          return;
        }

        state.active =
          false;

        state.status =
          "regression";

        state.lastNotice =
          "Regression resolution reported without all required retests.";

        persistState(
          pi,
        );

        logIteration(
          "regression_retest",
          {
            originAtomId:
              resolved.originAtomId,

            retestedAtomIds:
              resolved.retestedAtomIds,
          },
        );

        return;
      }

      /**
       * Global check.
       */
      let scoreRegressed =
        false;

      if (
        state.checkCommand
      ) {
        const outcome =
          await runGoalCheck(
            pi,
          );

        if (
          !state.active ||
          token !== runToken
        ) {
          return;
        }

        scoreRegressed =
          applyCheckOutcome(
            state,
            outcome,
          );
      }

      if (
        scoreRegressed
      ) {
        state.active =
          false;

        state.status =
          "paused";

        state.lastNotice =
          `Verification score regressed to ${state.lastCheckScore}.`;

        persistState(
          pi,
        );

        logIteration(
          "regression",
        );

        return;
      }

      /**
       * Overall completion.
       */
      if (
        state.untilDone &&
        state.checkCommand &&
        state.lastCheckPassed ===
          true
      ) {
        state.atomsCompletedThisRun++;

        state.atomCycleClosed =
          true;

        state.active =
          false;

        state.status =
          "completed";

        state.lastNotice =
          "Goal check passed.";

        persistState(
          pi,
        );

        logIteration(
          "completed_by_check",
        );

        ctx.ui.notify(
          "Autonomous loop complete: goal check passed.",
          "info",
        );

        return;
      }

      if (
        MVP_READY_RE.test(
          lastAssistantText,
        )
      ) {
        const gitCommit =
          await commitAtomicChanges(
            ctx,
            `loop: MVP ready${state.currentAtomId ? ` (${state.currentAtomId})` : ""}`,
          );

        if (!gitCommit.ok) {
          state.active = false;
          state.status = "paused";
          state.lastNotice = gitCommit.reason;
          persistState(pi);
          logIteration("git_blocked", { reason: gitCommit.reason });
          return;
        }

        state.atomsCompletedThisRun++;

        state.atomCycleClosed =
          true;

        state.active =
          false;

        state.status =
          "completed";

        state.lastNotice =
          "MVP ready for user testing.";

        persistState(
          pi,
        );

        logIteration(
          "mvp_ready",
        );

        ctx.ui.notify(
          "MVP is ready for user testing. Loop stopped.",
          "info",
        );

        return;
      }

      if (
        LOOP_DONE_RE.test(
          lastAssistantText,
        )
      ) {
        const gitCommit =
          await commitAtomicChanges(
            ctx,
            `loop: completed${state.currentAtomId ? ` (${state.currentAtomId})` : ""}`,
          );

        if (!gitCommit.ok) {
          state.active = false;
          state.status = "paused";
          state.lastNotice = gitCommit.reason;
          persistState(pi);
          logIteration("git_blocked", { reason: gitCommit.reason });
          return;
        }

        state.atomsCompletedThisRun++;

        state.atomCycleClosed =
          true;

        state.active =
          false;

        state.status =
          "completed";

        state.lastNotice =
          "Overall completion reported.";

        persistState(
          pi,
        );

        logIteration(
          "completed_by_marker",
        );

        ctx.ui.notify(
          "Loop completed.",
          "info",
        );

        return;
      }

      /**
       * Blocking stops the whole chain.
       */
      if (
        LOOP_BLOCKED_RE.test(
          lastAssistantText,
        )
      ) {
        state.blockedSignalCount++;

        state.active =
          false;

        state.status =
          "paused";

        state.lastNotice =
          `Atomic task blocked: ${snippet(
            lastAssistantText,
            240,
          )}`;

        persistState(
          pi,
        );

        logIteration(
          "blocked",
        );

        ctx.ui.notify(
          state.lastNotice,
          "warning",
        );

        return;
      }

      const stuckReason =
        detectStuck(
          lastAssistantText,
          repetitionText,
        );

      if (
        stuckReason
      ) {
        await interveneStuck(
          pi,
          ctx,
          stuckReason,
        );

        return;
      }

      /**
       * ONE ATOM IS DONE.
       */
      const completedAtom =
        parseCycleDoneAtom(
          lastAssistantText,
        ) ||
        state.currentAtomId;

      if (
        completedAtom
      ) {
        state.lastCompletedAtomId =
          completedAtom;

        state.currentAtomId =
          "";

        state.atomsCompletedThisRun++;

        state.lastNotice =
          `Atomic task ${completedAtom} completed.`;

        const gitCommit =
          await commitAtomicChanges(
            ctx,
            `loop: ${completedAtom}`,
          );

        if (!gitCommit.ok) {
          state.active =
            false;

          state.status =
            "paused";

          state.lastNotice =
            gitCommit.reason;

          persistState(pi);

          logIteration(
            "git_blocked",
            {
              reason:
                gitCommit.reason,
              atomId:
                completedAtom,
            },
          );

          ctx.ui.notify(
            `Loop stopped: ${gitCommit.reason}`,
            "error",
          );

          return;
        }

        logIteration(
          "atom_checkpoint",
          {
            atomId:
              completedAtom,
            gitCommitted:
              gitCommit.committed,
          },
        );
      }

      state.active =
        false;

      state.status =
        "stopped";

      persistState(
        pi,
      );

      logIteration(
        "atomic_cycle_complete",
        {
          atomId:
            completedAtom ||
            undefined,
        },
      );

      ctx.ui.notify(
        state.untilDone
          ? `Atom ${
              completedAtom ||
              "-"
            } completed. Autonomous controller will create a fresh Pi session for the next atom.`
          : `Atom ${
              completedAtom ||
              "-"
            } completed. Test the current version and use /loop resume for the next cycle.`,
        "info",
      );

      ctx.ui.setStatus(
        "loop",
        state.untilDone
          ? "Atom complete — next fresh session"
          : "Atom complete — waiting",
      );
    },
  );
}

function detectStuck(
  lastAssistantText: string,
  repetitionText =
    lastAssistantText,
): string | undefined {
  const prints =
    state.lastAssistantFingerprints;

  const degenerate =
    detectDegenerateRepetition(
      repetitionText,
      DEGENERATE_REPEATS,
    );

  if (degenerate) {
    return (
      `response degenerated: same ${degenerate.kind} repeated ${degenerate.repeats}×`
    );
  }

  if (
    state.turnsWithoutTools >=
    MAX_TOOLLESS_TURNS
  ) {
    return (
      `no tool usage for ${state.turnsWithoutTools} turns`
    );
  }

  const lastTwo =
    prints.slice(-2);

  if (
    lastTwo.length === 2 &&
    lastTwo[0] ===
      lastTwo[1] &&
    normalizeText(
      lastAssistantText,
    ).length > 80
  ) {
    return "assistant repeated the same response";
  }

  const lastThree =
    prints.slice(-3);

  if (
    lastThree.length ===
      3 &&
    lastThree.every(
      (value) =>
        value ===
        lastThree[0],
    )
  ) {
    return "assistant repeated the same response three times";
  }

  const texts =
    state.lastAssistantTexts;

  const previous =
    texts.length >= 2
      ? texts[
          texts.length - 2
        ]
      : undefined;

  if (
    previous &&
    normalizeText(
      lastAssistantText,
    ).length > 60
  ) {
    const similarity =
      textSimilarity(
        lastAssistantText,
        previous,
      );

    if (
      similarity >=
      SIMILARITY_THRESHOLD
    ) {
      return (
        `assistant response ~${Math.round(
          similarity * 100,
        )}% similar to previous`
      );
    }
  }

  const currentPrint =
    prints[
      prints.length - 1
    ];

  if (
    currentPrint &&
    prints.filter(
      (value) =>
        value ===
        currentPrint,
    ).length >=
      REPEAT_WINDOW_COUNT
  ) {
    return (
      `same response repeated ${REPEAT_WINDOW_COUNT}+ times`
    );
  }

  const recentTools =
    state.recentToolResults.slice(
      -3,
    );

  if (
    recentTools.length ===
      3 &&
    recentTools.every(
      (result) =>
        result.tool ===
          recentTools[0].tool &&
        result.fingerprint ===
          recentTools[0].fingerprint,
    )
  ) {
    return recentTools.every(
      (result) =>
        result.isError,
    )
      ? `same ${recentTools[0].tool} error repeated`
      : `same ${recentTools[0].tool} result repeated`;
  }

  const asksQuestion =
    /\?\s*$/.test(
      lastAssistantText.trim(),
    );

  const recentSnippets =
    state.lastAssistantSnippets.slice(
      -2,
    );

  if (
    asksQuestion &&
    recentSnippets.length ===
      2 &&
    recentSnippets[0] ===
      recentSnippets[1]
  ) {
    return "same question repeated";
  }

  return undefined;
}
