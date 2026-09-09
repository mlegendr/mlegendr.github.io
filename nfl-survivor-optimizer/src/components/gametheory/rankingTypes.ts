/** Re-exported shapes so client components avoid importing server modules. */
export type {
  CandidateTournamentResult,
  PoolObjective,
  ProjectedOwnershipRow,
  SensitivityReport,
} from "@/lib/gametheory/types";

export interface RelativeFutureValueLike {
  team: string;
  ownFutureValue: number;
  opponentAccessRate: number;
  relativeFutureValue: number;
  interpretation: string;
}
