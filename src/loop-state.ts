export const STATE_ENTRY_TYPE =
  "loop-state";

export type LoopStatus =
  | "running"
  | "stuck"
  | "retrying"
  | "regression"
  | "paused"
  | "completed"
  | "stopped"
  | "preparing";

export interface ToolSnapshot {
  tool: string;
  fingerprint: string;
  snippet: string;
  isError: boolean;
  time: number;
}

export interface LoopState {
  active: boolean;
  description: string;
  completionCriteria: string;
  startTime: number;

  /** Number of turns used inside the current Pi session. */
  iterationCount: number;

  /** Maximum number of atoms in one autonomous run; 0 = unlimited. */
  maxIterations: number;

  /** true = autonomous overnight mode; false = supervised one-atom mode. */
  untilDone: boolean;

  delaySeconds: number;

  checkCommand: string;
  checkTimeoutSeconds: number;

  lastCheckPassed?: boolean;
  lastCheckScore?: number;
  bestCheckScore?: number;
  bestScoreIteration: number;
  checkFailStreak: number;
  lastCheckOutput: string;

  goalFile: string;

  loopModel: string;
  rescueModel: string;
  rescueActive: boolean;
  rescueReturnModel: string;

  penaltyTurnsRemaining: number;
  lastCompactIteration: number;
  preparedAt: number;
  softStopRequested: boolean;

  lastAssistantFingerprints: string[];
  lastAssistantSnippets: string[];
  lastAssistantTexts: string[];
  recentToolResults: ToolSnapshot[];

  turnsWithoutTools: number;
  toolCallsThisTurn: number;
  consecutiveStuckCount: number;
  interventionCount: number;
  consecutiveErrorCount: number;
  totalErrorCount: number;
  doneSignalCount: number;
  blockedSignalCount: number;
  lastStateChangeIteration: number;

  /** Atomic task state. */
  currentAtomId: string;
  lastCompletedAtomId: string;
  suspendedAtomId: string;

  /** True after the current atomic session has been closed. */
  atomCycleClosed: boolean;

  /** Regression state. */
  regressionActive: boolean;
  regressionOriginAtomId: string;
  regressionFoundDuringAtomId: string;
  regressionAffectedAtomIds: string[];
  regressionDescription: string;
  regressionPassStreak: number;
  regressionRetestRequired: boolean;

  /** Autonomous run state. */
  atomsCompletedThisRun: number;
  autonomousRunStartedAt: number;

  /**
   * Durable handoff marker written into the replacement session.
   * Unlike a module-level variable, this survives Pi's extension runtime
   * recreation during /new.
   */
  autonomousHandoffPending: boolean;

  status: LoopStatus;
  lastNotice: string;
}

export function defaultState(): LoopState {
  return {
    active: false,
    description: "",
    completionCriteria: "",
    startTime: 0,

    iterationCount: 0,
    maxIterations: 0,
    untilDone: false,
    delaySeconds: 0,

    checkCommand: "",
    checkTimeoutSeconds: 120,

    bestScoreIteration: 0,
    checkFailStreak: 0,
    lastCheckOutput: "",

    goalFile: "GOAL.md",

    loopModel: "",
    rescueModel: "",
    rescueActive: false,
    rescueReturnModel: "",

    penaltyTurnsRemaining: 0,
    lastCompactIteration: 0,
    preparedAt: 0,
    softStopRequested: false,

    lastAssistantFingerprints: [],
    lastAssistantSnippets: [],
    lastAssistantTexts: [],
    recentToolResults: [],

    turnsWithoutTools: 0,
    toolCallsThisTurn: 0,
    consecutiveStuckCount: 0,
    interventionCount: 0,
    consecutiveErrorCount: 0,
    totalErrorCount: 0,
    doneSignalCount: 0,
    blockedSignalCount: 0,
    lastStateChangeIteration: 0,

    currentAtomId: "",
    lastCompletedAtomId: "",
    suspendedAtomId: "",
    atomCycleClosed: false,

    regressionActive: false,
    regressionOriginAtomId: "",
    regressionFoundDuringAtomId: "",
    regressionAffectedAtomIds: [],
    regressionDescription: "",
    regressionPassStreak: 0,
    regressionRetestRequired: false,

    atomsCompletedThisRun: 0,
    autonomousRunStartedAt: 0,
    autonomousHandoffPending: false,

    status: "stopped",
    lastNotice: "",
  };
}

export function restoreLoopState(
  entries: readonly unknown[],
): LoopState {
  const restored =
    [...entries]
      .reverse()
      .find(
        (entry) =>
          Boolean(entry) &&
          typeof entry === "object" &&
          (entry as { type?: string }).type ===
            "custom" &&
          (entry as { customType?: string }).customType ===
            STATE_ENTRY_TYPE,
      ) as
      | { data?: Partial<LoopState> }
      | undefined;

  const result: LoopState = {
    ...defaultState(),
    ...(restored?.data ?? {}),
  };

  if (!Array.isArray(result.regressionAffectedAtomIds)) {
    result.regressionAffectedAtomIds = [];
  }

  if (typeof result.currentAtomId !== "string") {
    result.currentAtomId = "";
  }

  if (typeof result.lastCompletedAtomId !== "string") {
    result.lastCompletedAtomId = "";
  }

  if (typeof result.suspendedAtomId !== "string") {
    result.suspendedAtomId = "";
  }

  if (typeof result.regressionOriginAtomId !== "string") {
    result.regressionOriginAtomId = "";
  }

  if (typeof result.regressionFoundDuringAtomId !== "string") {
    result.regressionFoundDuringAtomId = "";
  }

  if (typeof result.regressionDescription !== "string") {
    result.regressionDescription = "";
  }

  if (typeof result.atomCycleClosed !== "boolean") {
    result.atomCycleClosed = false;
  }

  if (typeof result.autonomousHandoffPending !== "boolean") {
    result.autonomousHandoffPending = false;
  }

  if (typeof result.atomsCompletedThisRun !== "number") {
    result.atomsCompletedThisRun = 0;
  }

  if (typeof result.autonomousRunStartedAt !== "number") {
    result.autonomousRunStartedAt = 0;
  }

  return result;
}

export function persistedLoopState(
  state: LoopState,
): LoopState {
  return {
    ...state,
    lastAssistantFingerprints:
      state.lastAssistantFingerprints.slice(-8),
    lastAssistantSnippets:
      state.lastAssistantSnippets.slice(-5),
    lastAssistantTexts:
      state.lastAssistantTexts.slice(-3),
    recentToolResults:
      state.recentToolResults.slice(-10),
    regressionAffectedAtomIds:
      state.regressionAffectedAtomIds.slice(-50),
  };
}
