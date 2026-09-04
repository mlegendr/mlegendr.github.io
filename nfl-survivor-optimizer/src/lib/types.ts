/** Shared domain types used by providers, the model, the optimizer and the UI. */

export type SeasonType = "REG" | "POST";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type DataQuality = "OK" | "DEGRADED" | "MISSING";
export type InjuryImpact = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
export type InjuryStatus =
  | "OUT"
  | "DOUBTFUL"
  | "QUESTIONABLE"
  | "IR"
  | "PUP"
  | "PROBABLE"
  | "ACTIVE";

export interface Provenance {
  source: string;
  lastUpdated: string | null;
  dataQuality: DataQuality;
}

export interface CanonicalGame {
  id: string;
  season: number;
  week: number;
  seasonType: SeasonType;
  kickoff: string; // ISO 8601 UTC
  homeTeam: string;
  awayTeam: string;
  neutralSite: boolean;
  stadium: string | null;
  roof: string | null;
  surface: string | null;
  divisionGame: boolean;
  homeRest: number | null;
  awayRest: number | null;
  homeScore: number | null;
  awayScore: number | null;
  completed: boolean;
  overtime: boolean;
  refHomeMoneyline: number | null;
  refAwayMoneyline: number | null;
  refSpreadLine: number | null;
}

export interface BookQuote {
  book: string;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  spread: number | null;
  total: number | null;
  lastUpdate: string | null;
}

export interface CanonicalOdds {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  consensusHomeWinProbability: number;
  consensusAwayWinProbability: number;
  bookCount: number;
  dispersion: number;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  /** Points; negative means the home team is favoured. */
  spread: number | null;
  total: number | null;
  oddsLastUpdated: string;
  source: string;
}

export interface CanonicalInjury {
  season: number;
  week: number;
  team: string;
  playerName: string;
  position: string;
  status: InjuryStatus;
  practiceParticipation: string | null;
  depthChartRank: number | null;
  isStarter: boolean;
  note: string | null;
  source: string;
  manualOverride: boolean;
  observedAt: string;
}

export interface ScoredInjury extends CanonicalInjury {
  impact: InjuryImpact;
  impactScore: number;
}

export interface CanonicalWeather {
  gameId: string;
  temperatureF: number | null;
  windMph: number | null;
  windGustMph: number | null;
  precipChance: number | null;
  precipInches: number | null;
  isIndoor: boolean;
  source: string;
  observedAt: string;
}

export interface TeamWeekStat {
  season: number;
  week: number;
  team: string;
  opponent: string;
  offEpaPerPlay: number;
  plays: number;
  passEpaPerDropback: number;
  rushEpaPerCarry: number;
  successRate: number | null;
}

export interface TeamRatingState {
  team: string;
  elo: number;
  offEpa: number;
  defEpa: number;
  qbAdjustment: number;
  gamesPlayed: number;
}

/** A single team's outlook for a single week. */
export interface GameProbability {
  gameId: string;
  season: number;
  week: number;
  team: string;
  opponent: string;
  isHome: boolean;
  neutralSite: boolean;
  kickoff: string;
  started: boolean;
  completed: boolean;
  /** De-vigged consensus, when a usable market exists. */
  marketProb: number | null;
  modelProb: number;
  finalProb: number;
  marketWeight: number;
  injuryAdjustment: number;
  weatherAdjustment: number;
  horizonWeeks: number;
  confidence: Confidence;
  confidenceScore: number;
  dataQuality: DataQuality;
  bookCount: number;
  spread: number | null;
  moneyline: number | null;
  oddsLastUpdated: string | null;
  manualOverride: boolean;
  factors: ProbabilityFactor[];
}

export interface ProbabilityFactor {
  kind: "fact" | "estimate" | "assumption";
  label: string;
  detail: string;
  /** Signed contribution in probability points, where meaningful. */
  deltaPoints?: number;
}

export type UnavailableReason =
  | "USED"
  | "BYE"
  | "NO_GAME"
  | "STARTED"
  | "COMPLETED"
  | "LOCKED_PICK";

export interface TeamWeekSlot {
  team: string;
  week: number;
  available: boolean;
  reason: UnavailableReason | null;
  probability: GameProbability | null;
}

export interface PathStep {
  week: number;
  team: string;
  opponent: string;
  isHome: boolean;
  probability: number;
  cumulative: number;
  gameId: string;
}

export interface OptimizationResult {
  feasible: boolean;
  steps: PathStep[];
  logSurvival: number;
  survival: number;
  weeksCovered: number;
  weeksRequested: number;
}

export interface CandidateEvaluation {
  team: string;
  gameId: string;
  opponent: string;
  isHome: boolean;
  currentWinProb: number;
  marketProb: number | null;
  modelProb: number;
  confidence: Confidence;
  /** Optimized survival probability of the whole horizon, given this pick. */
  pathSurvival: Record<string, number>;
  /** Best achievable survival over the horizon ignoring which team is forced. */
  bestPathSurvival: number;
  /** How much season value this pick burns, in log-probability points. */
  futureValueCost: number;
  recommendationScore: number;
  horizonWinners: Record<string, string | null>;
  robustnessShare: number | null;
  path: PathStep[];
  injuries: ScoredInjury[];
  reasons: ProbabilityFactor[];
  verdict: "BEST PICK" | "STRONG" | "VIABLE" | "PRESERVE" | "AVOID";
}

export interface PoolSettings {
  season: number;
  currentWeekOverride: number | null;
  tieCountsAsLoss: boolean;
  includePostseason: boolean;
  totalRegularSeasonWeeks: number;
  defaultHorizon: number;
  /** 0 = pure survival maximiser, 1 = maximally contrarian in Pool Strategy mode. */
  riskPreference: number;
  oddsProvider: "auto" | "the-odds-api" | "schedule-reference" | "manual";
  injuryProvider: "auto" | "sportsdataio" | "sleeper" | "manual";
  poolStrategyEnabled: boolean;
  remainingEntries: number | null;
  pickPopularity: Record<string, number>;
}

export const DEFAULT_SETTINGS: PoolSettings = {
  season: 2026,
  currentWeekOverride: null,
  tieCountsAsLoss: true,
  includePostseason: false,
  totalRegularSeasonWeeks: 18,
  defaultHorizon: 6,
  riskPreference: 0,
  oddsProvider: "auto",
  injuryProvider: "auto",
  poolStrategyEnabled: false,
  remainingEntries: null,
  pickPopularity: {},
};

export const HORIZON_KEYS = ["3", "6", "9", "season"] as const;
export type HorizonKey = (typeof HORIZON_KEYS)[number];
