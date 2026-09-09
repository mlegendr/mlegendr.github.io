/**
 * Domain types for multi-entry pool game theory.
 *
 * Vocabulary is deliberate and used consistently: the competitive unit is a
 * **pool entry**, never a "player" (that word is reserved for NFL athletes).
 * One human owner may control several entries; each keeps its own independent
 * pick history and remaining-team inventory.
 */

export type EntryStatus = "ACTIVE" | "ELIMINATED" | "UNKNOWN" | "WINNER";
export type PickStatus = "PENDING" | "WIN" | "LOSS" | "TIE";
export type PickSource = "USER_ENTERED" | "CSV_IMPORT" | "MANUAL_OVERRIDE";

export interface PoolEntryRecord {
  id: string;
  poolId: string;
  season: number;
  displayName: string;
  ownerName: string | null;
  isUser: boolean;
  status: EntryStatus;
  eliminatedWeek: number | null;
  eliminationReason: string | null;
  manualStatusOverride: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntryPickRecord {
  id: string;
  poolEntryId: string;
  season: number;
  week: number;
  team: string;
  gameId: string | null;
  pickSource: PickSource;
  pickStatus: PickStatus;
  isKnown: boolean;
}

/** An entry plus everything derived from its pick history. */
export interface EntryState {
  entry: PoolEntryRecord;
  picks: EntryPickRecord[];
  /** Teams this entry has already spent. Never shared between entries. */
  usedTeams: string[];
  /** All 32 teams minus `usedTeams`. */
  remainingTeams: string[];
  /** Known selection for the current week, if the user has observed it. */
  knownCurrentPick: string | null;
}

/* ------------------------------------------------------------------ import */

export interface ImportRow {
  entry: string;
  owner: string | null;
  week: number;
  team: string;
  /** Original spelling, before alias normalisation. */
  rawTeam: string;
  sourceLine: number;
}

export type ImportIssueKind =
  | "UNKNOWN_TEAM"
  | "INVALID_WEEK"
  | "DUPLICATE_PICK"
  | "TEAM_REUSED_BY_ENTRY"
  | "PICK_AFTER_ELIMINATION"
  | "CONFLICTING_SELECTION"
  | "MISSING_ENTRY"
  | "MALFORMED_ROW"
  | "TEAM_ON_BYE";

export interface ImportIssue {
  kind: ImportIssueKind;
  severity: "ERROR" | "WARNING";
  message: string;
  entry?: string;
  week?: number;
  team?: string;
  sourceLine?: number;
}

export interface ImportPreview {
  format: "long" | "wide";
  rows: ImportRow[];
  issues: ImportIssue[];
  entries: { name: string; owner: string | null; weeks: number[]; teams: string[] }[];
  /** True when nothing blocking was found; warnings alone do not block. */
  committable: boolean;
  totals: { rows: number; entries: number; errors: number; warnings: number };
}

/* --------------------------------------------------------- opponent model */

/** Features describing one candidate team for one entry in one week. */
export interface ChoiceFeatures {
  /** Blended win probability for the team that week. */
  winProbability: number;
  /** 1.0 for the week's safest available option, falling toward 0. */
  safetyRank: number;
  /** Season log-probability the entry gives up by spending this team now. */
  futureValueCost: number;
  /** How scarce this team's strong future weeks are, 0..1. */
  scheduleScarcity: number;
  /** Optional national survivor ownership for the team, 0..1, else 0. */
  publicPopularity: number;
  /** 1 when the team is at home. */
  isHome: number;
}

export const CHOICE_FEATURE_ORDER: (keyof ChoiceFeatures)[] = [
  "winProbability",
  "safetyRank",
  "futureValueCost",
  "scheduleScarcity",
  "publicPopularity",
  "isHome",
];

export type ChoiceCoefficients = Record<keyof ChoiceFeatures, number>;

export interface BehaviorModel {
  /** Pool-wide coefficients, fitted from every observed historical decision. */
  poolCoefficients: ChoiceCoefficients;
  /** Per-entry coefficients, shrunk toward the pool model. */
  entryCoefficients: Record<string, ChoiceCoefficients>;
  /** Softmax temperature; higher is flatter/noisier. */
  temperature: number;
  /** Observed decisions used to fit the pool model. */
  observations: number;
  /** entryId -> decisions observed for that entry. */
  entryObservations: Record<string, number>;
  /** entryId -> shrinkage weight actually applied (0 = pure pool model). */
  entryShrinkage: Record<string, number>;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  /** True when no historical picks existed and cold-start priors are in use. */
  isColdStart: boolean;
  fitNote: string;
}

/** One entry's predicted selection distribution for one week. */
export interface EntryPickDistribution {
  entryId: string;
  entryName: string;
  /** team -> probability. Always sums to 1 over legal teams. */
  distribution: Record<string, number>;
  /** True when the user supplied the actual pick instead of predicting it. */
  isKnown: boolean;
  legalTeams: string[];
}

export interface ProjectedOwnershipRow {
  team: string;
  /** Sum of per-entry probabilities across active opposing entries. */
  expectedEntries: number;
  /** expectedEntries / number of active opposing entries. */
  share: number;
  /** Active opposing entries that still hold the team at all. */
  entriesWithAccess: number;
  /** entriesWithAccess / active opposing entries — the §7 metric. */
  opponentAccessRate: number;
  known: number;
}

/* ---------------------------------------------------------- inventory edge */

export interface InventoryEdge {
  team: string;
  userHasTeam: boolean;
  /** Active opposing entries that can still use the team. */
  opponentsWithTeam: number;
  activeOpponents: number;
  opponentAccessRate: number;
  /** 1 - opponentAccessRate, when the user still holds the team. */
  inventoryAdvantage: number;
  scarcity: "EXCLUSIVE" | "SCARCE" | "COMMON" | "UNAVAILABLE";
}

/* -------------------------------------------------------------- tournament */

export type PoolObjective =
  | "EXPECTED_PRIZE_EQUITY"
  | "POOL_WIN_PROBABILITY"
  | "SOLE_VICTORY"
  | "ANY_VICTORY";

export type AllLoseRule = "REINSTATE_ALL" | "SHARE_AMONG_LAST" | "POOL_ENDS_NO_WINNER";

export interface PoolRules {
  tieCountsAsLoss: boolean;
  /** Contest ends the moment a single entry is left standing. */
  continueUntilOneRemains: boolean;
  allLoseRule: AllLoseRule;
  /** Winners split the prize equally; the only mode currently modelled. */
  splitPrizeEqually: boolean;
  /** Probability an NFL game ends in a tie. ~0.2% historically. */
  tieProbability: number;
}

export interface CandidateTournamentResult {
  team: string;
  gameId: string;
  opponent: string;
  isHome: boolean;
  currentWinProbability: number;
  /** Fraction of simulations in which the user survived the current week. */
  survivesCurrentWeek: number;
  /** P(user is among the winners) — any victory, shared or sole. */
  poolWinProbability: number;
  soleVictoryProbability: number;
  sharedVictoryProbability: number;
  /** E[1 / number of co-winners], 0 when the user does not win. */
  expectedPrizeEquity: number;
  averageFinishingPosition: number;
  /** E[opposing entries still alive | user survived this week]. */
  expectedOpponentsRemaining: number;
  medianEliminationWeek: number | null;
  milestones: Record<string, number>;
  /* ---- explanation metrics (never used for ranking) ---- */
  expectedPickOverlap: number;
  projectedPoolOwnership: number;
  expectedFieldEliminationGivenSurvival: number;
  popularAlternativeFadeLeverage: number;
  inventoryEdgeAfterPick: number;
  /* ---- bookkeeping ---- */
  simulations: number;
  /** Monte Carlo standard error on the objective value. */
  standardError: number;
}

export interface TournamentSummary {
  objective: PoolObjective;
  simulations: number;
  seed: number;
  candidates: CandidateTournamentResult[];
  /** Best candidate under the configured objective. */
  bestTeam: string | null;
  /** Best candidate under pure survival, for the side-by-side comparison. */
  survivalBestTeam: string | null;
  activeOpponents: number;
  activeEntries: number;
  weeksSimulated: number;
  elapsedMs: number;
  approximations: string[];
}

export interface FieldScenarioResult {
  scenario: string;
  label: string;
  description: string;
  bestTeam: string | null;
  byTeam: Record<string, { poolWinProbability: number; expectedPrizeEquity: number }>;
}

export interface SensitivityReport {
  scenarios: FieldScenarioResult[];
  /** Share of scenarios that agree with the primary recommendation. */
  agreement: number;
  robustness: "HIGH" | "MEDIUM" | "LOW";
  primaryTeam: string | null;
}

/* ----------------------------------------------------------- gt settings */

export interface GameTheorySettings {
  enabled: boolean;
  simulations: number;
  seed: number;
  objective: PoolObjective;
  /** Softmax temperature for opponent choice. Higher = flatter. */
  opponentTemperature: number;
  /** Pseudo-count controlling shrinkage of entry deviations toward the pool. */
  entryShrinkageStrength: number;
  publicPopularityWeight: number;
  futureValueWeight: number;
  behaviorMode: "LEARNED" | "POOL_AVERAGE" | "COLD_START";
  rules: PoolRules;
  /** team -> national ownership share, manually supplied. */
  publicPopularity: Record<string, number>;
  /** Rollout weights for the user's simulated future decisions. */
  rolloutFutureValueWeight: number;
  rolloutDifferentiationWeight: number;
  /** Below this many active entries, spend a larger simulation budget. */
  smallFieldThreshold: number;
  smallFieldSimulationMultiplier: number;
}

export const DEFAULT_GAME_THEORY_SETTINGS: GameTheorySettings = {
  enabled: true,
  simulations: 20000,
  seed: 20260101,
  // Expected prize equity is the default because most pools split a tie.
  // `resolveObjective` promotes this to POOL_WIN_PROBABILITY when the rules
  // guarantee play continues until exactly one entry remains.
  objective: "EXPECTED_PRIZE_EQUITY",
  opponentTemperature: 1,
  entryShrinkageStrength: 6,
  publicPopularityWeight: 1,
  futureValueWeight: 1,
  behaviorMode: "LEARNED",
  rules: {
    tieCountsAsLoss: true,
    continueUntilOneRemains: false,
    allLoseRule: "SHARE_AMONG_LAST",
    splitPrizeEqually: true,
    tieProbability: 0.002,
  },
  publicPopularity: {},
  rolloutFutureValueWeight: 1,
  rolloutDifferentiationWeight: 0.35,
  smallFieldThreshold: 5,
  smallFieldSimulationMultiplier: 2.5,
};

/**
 * The configured objective, with the one documented promotion: when the pool
 * plays on until a single entry remains there are no shared prizes, so
 * maximising prize equity and maximising win probability coincide — we report
 * the latter because it is the clearer statement of the goal.
 */
export function resolveObjective(settings: GameTheorySettings): PoolObjective {
  if (settings.objective === "EXPECTED_PRIZE_EQUITY" && settings.rules.continueUntilOneRemains) {
    return "POOL_WIN_PROBABILITY";
  }
  return settings.objective;
}

export function objectiveValue(
  result: CandidateTournamentResult,
  objective: PoolObjective,
): number {
  switch (objective) {
    case "POOL_WIN_PROBABILITY":
      return result.poolWinProbability;
    case "SOLE_VICTORY":
      return result.soleVictoryProbability;
    case "ANY_VICTORY":
      return result.poolWinProbability;
    case "EXPECTED_PRIZE_EQUITY":
    default:
      return result.expectedPrizeEquity;
  }
}

export const OBJECTIVE_LABEL: Record<PoolObjective, string> = {
  EXPECTED_PRIZE_EQUITY: "Expected prize equity",
  POOL_WIN_PROBABILITY: "Pool win probability",
  SOLE_VICTORY: "Probability of sole victory",
  ANY_VICTORY: "Probability of any victory",
};
