/**
 * Pool-equity analysis: the orchestration layer.
 *
 * Loads the field, fits the opponent model from the pool's own history,
 * projects this week's ownership, runs the tournament for every legal candidate
 * and stress-tests the winner against alternative assumptions about how the
 * other entries behave.
 *
 * The survival optimizer is untouched by all of this. Both recommendations are
 * produced independently and shown side by side; the disagreement between them
 * is itself information.
 */

import "../server-guard";
import { now } from "../clock";
import { TEAM_ABBRS } from "../teams";
import type { GameProbability } from "../types";
import { buildSlotIndex } from "../optimizer/survivor";
import {
  buildBehaviorModel,
  entryPickDistribution,
  type FeatureContext,
  type Observation,
} from "./opponentModel";
import { buildFeatureContext, summariseEntryBehavior, type EntryBehaviorSummary } from "./context";
import {
  computeFutureInventoryEdges,
  computeInventoryEdges,
  computeRelativeFutureValue,
  projectOwnership,
  type FutureInventoryCell,
  type RelativeFutureValue,
} from "./inventory";
import { runTournament } from "./tournament";
import { activeEntries } from "./entries";
import {
  objectiveValue,
  resolveObjective,
  type BehaviorModel,
  type CandidateTournamentResult,
  type ChoiceCoefficients,
  type EntryPickDistribution,
  type EntryState,
  type FieldScenarioResult,
  type GameTheorySettings,
  type InventoryEdge,
  type ProjectedOwnershipRow,
  type SensitivityReport,
  type TournamentSummary,
} from "./types";

export interface PoolEquityInput {
  season: number;
  currentWeek: number;
  weeks: number[];
  probabilities: GameProbability[];
  states: EntryState[];
  settings: GameTheorySettings;
  candidates: string[];
  observations: Observation[];
  isPickable: (team: string, week: number, p: GameProbability) => boolean;
  /** Reduce cost for the sensitivity pass; defaults to a quarter budget. */
  sensitivitySimulations?: number;
  runSensitivity?: boolean;
}

export interface HeadToHeadAnalysis {
  opponentName: string;
  sharedTeams: string[];
  userExclusiveTeams: string[];
  opponentExclusiveTeams: string[];
  /** Exact enumeration of this week's joint outcomes, not sampled. */
  jointOutcomes: {
    userTeam: string;
    opponentTeam: string;
    probability: number;
    userSurvivesOpponentOut: number;
    bothSurvive: number;
    bothOut: number;
    userOutOpponentSurvives: number;
  }[];
  note: string;
}

export interface PoolEquityAnalysis {
  generatedAt: string;
  season: number;
  week: number;
  behaviorModel: BehaviorModel;
  entryBehavior: EntryBehaviorSummary[];
  currentDistributions: EntryPickDistribution[];
  projectedOwnership: ProjectedOwnershipRow[];
  inventoryEdges: InventoryEdge[];
  relativeFutureValue: RelativeFutureValue[];
  futureInventoryEdges: FutureInventoryCell[];
  tournament: TournamentSummary;
  sensitivity: SensitivityReport | null;
  headToHead: HeadToHeadAnalysis | null;
  confidence: {
    football: "HIGH" | "MEDIUM" | "LOW";
    opponentModel: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    poolEquity: "HIGH" | "MEDIUM" | "LOW";
    rationale: string[];
  };
  activeEntries: number;
  activeOpponents: number;
}

/** Coefficient variants for the §25 sensitivity scenarios. */
function scenarioCoefficients(
  base: ChoiceCoefficients,
  scenario: string,
): { coefficients: ChoiceCoefficients; temperature: number } {
  switch (scenario) {
    case "ANALYTICAL":
      return {
        coefficients: {
          ...base,
          winProbability: base.winProbability * 1.15,
          futureValueCost: Math.min(base.futureValueCost, -1.8),
          scheduleScarcity: base.scheduleScarcity + 0.4,
        },
        temperature: 0.7,
      };
    case "SAFETY_FIRST":
      return {
        coefficients: {
          ...base,
          winProbability: base.winProbability * 1.5,
          safetyRank: base.safetyRank + 2.2,
          futureValueCost: 0,
          scheduleScarcity: 0,
        },
        temperature: 0.55,
      };
    case "RANDOM":
      return { coefficients: base, temperature: 2.6 };
    case "PUBLIC":
      return {
        coefficients: { ...base, publicPopularity: base.publicPopularity + 3.5 },
        temperature: 1,
      };
    default:
      return { coefficients: base, temperature: 1 };
  }
}

const SCENARIO_META: Record<string, { label: string; description: string }> = {
  FIELD: {
    label: "Field model",
    description: "Behaviour learned from this pool's own observed decisions.",
  },
  ANALYTICAL: {
    label: "More analytical field",
    description: "Entries place greater probability on analytically strong picks.",
  },
  SAFETY_FIRST: {
    label: "Safety-first field",
    description: "Entries disproportionately take the week's obvious favourites.",
  },
  RANDOM: {
    label: "Higher randomness",
    description: "Entry pick distributions are flatter and less predictable.",
  },
  PUBLIC: {
    label: "Public-popularity field",
    description: "Entries follow national survivor ownership, within their own inventories.",
  },
};

function buildDistributions(
  states: EntryState[],
  weeks: number[],
  currentWeek: number,
  ctx: FeatureContext,
  model: BehaviorModel,
  settings: GameTheorySettings,
  isPickable: (team: string, week: number, p: GameProbability) => boolean,
  override?: { coefficients: ChoiceCoefficients; temperature: number },
): {
  current: EntryPickDistribution[];
  future: Map<string, Map<number, Record<string, number>>>;
} {
  const active = activeEntries(states).filter((s) => !s.entry.isUser);
  const current: EntryPickDistribution[] = [];
  const future = new Map<string, Map<number, Record<string, number>>>();

  for (const state of active) {
    current.push(
      entryPickDistribution({
        state,
        week: currentWeek,
        ctx,
        model,
        settings,
        isLegal: isPickable,
        coefficientOverride: override?.coefficients,
        temperatureOverride: override?.temperature,
      }),
    );

    const perWeek = new Map<number, Record<string, number>>();
    for (const w of weeks) {
      if (w <= currentWeek) continue;
      const d = entryPickDistribution({
        state,
        week: w,
        ctx,
        model,
        settings,
        // Future weeks have not kicked off; only inventory and byes constrain.
        isLegal: (team, week, p) => !p.completed && isPickableStructural(team, week, p),
        coefficientOverride: override?.coefficients,
        temperatureOverride: override?.temperature,
      });
      perWeek.set(w, d.distribution);
    }
    future.set(state.entry.id, perWeek);
  }

  return { current, future };
}

/** Future weeks: a team is legal if it has a game that has not been played. */
function isPickableStructural(_team: string, _week: number, p: GameProbability): boolean {
  return !p.completed;
}

export function buildPoolEquityAnalysis(input: PoolEquityInput): PoolEquityAnalysis {
  const reference = now();
  const { settings, states, probabilities, weeks, currentWeek } = input;

  const userState = states.find((s) => s.entry.isUser) ?? null;
  const availableTeams = new Set(userState?.remainingTeams ?? TEAM_ABBRS);
  const futureWeeks = weeks.filter((w) => w >= currentWeek);

  // ---- Features and behaviour model. -------------------------------------
  const ctx = buildFeatureContext(
    probabilities,
    futureWeeks,
    availableTeams,
    settings,
    input.isPickable,
  );
  const model = buildBehaviorModel(input.observations, settings);

  // ---- Predicted ownership for this week. --------------------------------
  const { current: currentDistributions, future: futureDistributions } = buildDistributions(
    states,
    weeks,
    currentWeek,
    ctx,
    model,
    settings,
    input.isPickable,
  );
  const ownershipRows = projectOwnership(currentDistributions, states);
  const ownershipMap = new Map(ownershipRows.map((r) => [r.team, r.share]));

  // ---- Inventory metrics. -------------------------------------------------
  const inventoryEdges = computeInventoryEdges(states, userState);
  const relativeFutureValue = computeRelativeFutureValue(ctx.futureValueCost, inventoryEdges);
  const futureInventoryEdges = computeFutureInventoryEdges(
    probabilities,
    inventoryEdges,
    futureWeeks.filter((w) => w > currentWeek),
  );

  // ---- The tournament. ----------------------------------------------------
  const tournament = runTournament({
    currentWeek,
    weeks: futureWeeks,
    probabilities,
    states,
    currentDistributions,
    futureDistributions,
    settings,
    candidates: input.candidates,
    futureValueCost: ctx.futureValueCost,
    projectedOwnership: ownershipMap,
    isPickable: input.isPickable,
    simulations: settings.simulations,
    seed: settings.seed,
  });

  // Fill in the inventory-edge explanation metric per candidate.
  const edgeByTeam = new Map(inventoryEdges.map((e) => [e.team, e]));
  const fvTotal = [...ctx.futureValueCost.values()].reduce((a, b) => a + b, 0) || 1;
  for (const c of tournament.candidates) {
    let weighted = 0;
    for (const [team, fv] of ctx.futureValueCost) {
      if (team === c.team) continue; // spent by this pick
      const edge = edgeByTeam.get(team);
      if (!edge?.userHasTeam) continue;
      weighted += (fv / fvTotal) * edge.inventoryAdvantage;
    }
    c.inventoryEdgeAfterPick = weighted;
  }

  // ---- Sensitivity to opponent behaviour. ---------------------------------
  let sensitivity: SensitivityReport | null = null;
  if (input.runSensitivity !== false && tournament.candidates.length > 0) {
    const budget = input.sensitivitySimulations ?? Math.max(400, Math.round(settings.simulations / 4));
    const shortlist = tournament.candidates
      .slice(0, Math.min(8, tournament.candidates.length))
      .map((c) => c.team);
    const scenarios: FieldScenarioResult[] = [];
    const names = ["FIELD", "ANALYTICAL", "SAFETY_FIRST", "RANDOM"];
    if (Object.keys(settings.publicPopularity).length > 0) names.push("PUBLIC");

    for (const scenario of names) {
      // FIELD *is* the primary run. Re-simulating it with a different seed and
      // a smaller budget would let it disagree with itself inside Monte Carlo
      // noise, which is both wrong and confusing.
      if (scenario === "FIELD") {
        scenarios.push({
          scenario,
          label: SCENARIO_META.FIELD.label,
          description: SCENARIO_META.FIELD.description,
          bestTeam: tournament.bestTeam,
          byTeam: Object.fromEntries(
            tournament.candidates
              .filter((c) => shortlist.includes(c.team))
              .map((c) => [
                c.team,
                {
                  poolWinProbability: c.poolWinProbability,
                  expectedPrizeEquity: c.expectedPrizeEquity,
                },
              ]),
          ),
        });
        continue;
      }
      const override = scenarioCoefficients(model.poolCoefficients, scenario);
      const dists = buildDistributions(
        states, weeks, currentWeek, ctx, model, settings, input.isPickable, override,
      );
      const own = new Map(projectOwnership(dists.current, states).map((r) => [r.team, r.share]));
      const summary = runTournament({
        currentWeek,
        weeks: futureWeeks,
        probabilities,
        states,
        currentDistributions: dists.current,
        futureDistributions: dists.future,
        settings,
        candidates: shortlist,
        futureValueCost: ctx.futureValueCost,
        projectedOwnership: own,
        isPickable: input.isPickable,
        simulations: budget,
        seed: settings.seed + scenario.length * 7919,
      });
      scenarios.push({
        scenario,
        label: SCENARIO_META[scenario].label,
        description: SCENARIO_META[scenario].description,
        bestTeam: summary.bestTeam,
        byTeam: Object.fromEntries(
          summary.candidates.map((c) => [
            c.team,
            {
              poolWinProbability: c.poolWinProbability,
              expectedPrizeEquity: c.expectedPrizeEquity,
            },
          ]),
        ),
      });
    }

    const primary = tournament.bestTeam;
    const agree = scenarios.filter((s) => s.bestTeam === primary).length;
    const agreement = scenarios.length === 0 ? 0 : agree / scenarios.length;
    sensitivity = {
      scenarios,
      agreement,
      robustness: agreement >= 0.99 ? "HIGH" : agreement >= 0.6 ? "MEDIUM" : "LOW",
      primaryTeam: primary,
    };
  }

  // ---- Head-to-head endgame. ---------------------------------------------
  const opponents = activeEntries(states).filter((s) => !s.entry.isUser);
  const headToHead =
    opponents.length === 1 && userState
      ? buildHeadToHead(userState, opponents[0], currentDistributions[0] ?? null, probabilities, currentWeek, settings, tournament)
      : null;

  // ---- Confidence, split into its two genuinely different sources (§26). --
  const currentProbs = probabilities.filter((p) => p.week === currentWeek);
  const highConfidenceGames = currentProbs.filter((p) => p.confidence === "HIGH").length;
  const football: "HIGH" | "MEDIUM" | "LOW" =
    currentProbs.length === 0
      ? "LOW"
      : highConfidenceGames / currentProbs.length >= 0.5
        ? "HIGH"
        : highConfidenceGames / currentProbs.length >= 0.2
          ? "MEDIUM"
          : "LOW";
  const opponentModel = model.confidence;
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 } as const;
  const combined = Math.min(rank[football], rank[opponentModel] || 1);
  const poolEquity: "HIGH" | "MEDIUM" | "LOW" =
    combined >= 3 ? "HIGH" : combined >= 2 ? "MEDIUM" : "LOW";

  const rationale: string[] = [];
  rationale.push(
    `Football probabilities: ${highConfidenceGames}/${currentProbs.length} current-week games rated HIGH confidence.`,
  );
  rationale.push(
    model.isColdStart
      ? "Opponent model: no pool history yet, so cold-start priors are in use and predicted ownership is weakly informed."
      : `Opponent model: fitted from ${model.observations} observed decisions across the pool.`,
  );
  if (sensitivity) {
    rationale.push(
      `Recommendation held in ${Math.round(sensitivity.agreement * 100)}% of alternative opponent-behaviour scenarios.`,
    );
  }

  return {
    generatedAt: reference.toISOString(),
    season: input.season,
    week: currentWeek,
    behaviorModel: model,
    entryBehavior: opponents.map((s) =>
      summariseEntryBehavior(s.entry.id, input.observations, model.entryShrinkage[s.entry.id] ?? 0),
    ),
    currentDistributions,
    projectedOwnership: ownershipRows,
    inventoryEdges,
    relativeFutureValue,
    futureInventoryEdges,
    tournament,
    sensitivity,
    headToHead,
    confidence: { football, opponentModel, poolEquity, rationale },
    activeEntries: activeEntries(states).length,
    activeOpponents: opponents.length,
  };
}

/**
 * Two entries left: enumerate this week's joint outcomes exactly instead of
 * relying only on sampling (§30). The continuation value still comes from the
 * tournament, but the current-week branch probabilities are computed directly.
 */
function buildHeadToHead(
  userState: EntryState,
  opponentState: EntryState,
  distribution: EntryPickDistribution | null,
  probabilities: GameProbability[],
  week: number,
  settings: GameTheorySettings,
  tournament: TournamentSummary,
): HeadToHeadAnalysis {
  const userSet = new Set(userState.remainingTeams);
  const oppSet = new Set(opponentState.remainingTeams);
  const shared = [...userSet].filter((t) => oppSet.has(t)).sort();
  const userExclusive = [...userSet].filter((t) => !oppSet.has(t)).sort();
  const oppExclusive = [...oppSet].filter((t) => !userSet.has(t)).sort();

  const probByTeam = new Map(
    probabilities.filter((p) => p.week === week).map((p) => [p.team, p]),
  );
  const gameOf = new Map<string, string>();
  for (const [team, p] of probByTeam) gameOf.set(team, p.gameId);

  const jointOutcomes: HeadToHeadAnalysis["jointOutcomes"] = [];
  for (const c of tournament.candidates.slice(0, 6)) {
    const userProb = probByTeam.get(c.team);
    if (!userProb) continue;
    for (const [oppTeam, oppP] of Object.entries(distribution?.distribution ?? {})) {
      if (oppP < 0.02) continue;
      const oppProb = probByTeam.get(oppTeam);
      if (!oppProb) continue;
      const sameGame = gameOf.get(c.team) === gameOf.get(oppTeam);
      const pu = userProb.finalProb;
      const po = oppProb.finalProb;

      let bothSurvive: number;
      let userOnly: number;
      let oppOnly: number;
      if (c.team === oppTeam) {
        // Identical pick: perfectly correlated.
        bothSurvive = pu;
        userOnly = 0;
        oppOnly = 0;
      } else if (sameGame) {
        // Opposite sides of one game: mutually exclusive.
        bothSurvive = 0;
        userOnly = pu;
        oppOnly = po;
      } else {
        bothSurvive = pu * po;
        userOnly = pu * (1 - po);
        oppOnly = (1 - pu) * po;
      }
      const bothOut = Math.max(0, 1 - bothSurvive - userOnly - oppOnly);
      jointOutcomes.push({
        userTeam: c.team,
        opponentTeam: oppTeam,
        probability: oppP,
        userSurvivesOpponentOut: userOnly,
        bothSurvive,
        bothOut,
        userOutOpponentSurvives: oppOnly,
      });
    }
  }

  void settings;
  return {
    opponentName: opponentState.entry.displayName,
    sharedTeams: shared,
    userExclusiveTeams: userExclusive,
    opponentExclusiveTeams: oppExclusive,
    jointOutcomes,
    note:
      "Current-week joint outcomes are enumerated exactly rather than sampled. Picking the same team as your opponent guarantees you both advance or both exit; picking opposite sides of one game guarantees exactly one of you survives.",
  };
}

export function bestByObjective(
  tournament: TournamentSummary,
  settings: GameTheorySettings,
): CandidateTournamentResult | null {
  const objective = resolveObjective(settings);
  const sorted = [...tournament.candidates].sort(
    (a, b) => objectiveValue(b, objective) - objectiveValue(a, objective),
  );
  return sorted[0] ?? null;
}

export { buildSlotIndex };
