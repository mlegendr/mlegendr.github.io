/**
 * Explanation engine for the pool-equity recommendation.
 *
 * Every sentence here is generated from a number the simulator actually
 * produced. Nothing is manufactured, and there is no "contrarian bonus" to
 * explain — when the popular favourite is also the highest-equity pick, the
 * explanation says so plainly.
 */

import { teamName, teamShort } from "../teams";
import type {
  CandidateTournamentResult,
  InventoryEdge,
  PoolObjective,
  ProjectedOwnershipRow,
  SensitivityReport,
} from "./types";
import { OBJECTIVE_LABEL, objectiveValue } from "./types";

export interface PoolEquityExplanation {
  headline: string;
  agreesWithSurvival: boolean;
  lines: string[];
  tradeoff: {
    immediateCostPoints: number;
    poolWinGainPoints: number;
    prizeEquityGainPoints: number;
  } | null;
  comparison: ComparisonRow[] | null;
  robustnessNote: string;
}

export interface ComparisonRow {
  label: string;
  survival: string;
  poolEquity: string;
  highlight?: "survival" | "poolEquity" | null;
}

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export interface ExplainPoolEquityInput {
  poolPick: CandidateTournamentResult;
  survivalPick: CandidateTournamentResult | null;
  objective: PoolObjective;
  ownership: ProjectedOwnershipRow[];
  inventoryEdges: InventoryEdge[];
  sensitivity: SensitivityReport | null;
  activeOpponents: number;
  simulations: number;
  /** Best future weeks for the survival pick, from the season heatmap. */
  survivalPickFutureWeeks: { week: number; opponent: string; prob: number }[];
}

export function explainPoolEquity(input: ExplainPoolEquityInput): PoolEquityExplanation {
  const { poolPick, survivalPick, objective, simulations, activeOpponents } = input;
  const agrees = !survivalPick || survivalPick.team === poolPick.team;
  const lines: string[] = [];

  const ownershipOf = (team: string) =>
    input.ownership.find((o) => o.team === team) ?? null;
  const poolOwn = ownershipOf(poolPick.team);
  const survOwn = survivalPick ? ownershipOf(survivalPick.team) : null;

  if (agrees) {
    lines.push(
      `${teamName(poolPick.team)} is both the survival and the pool-equity recommendation this week at a ${pct(poolPick.currentWinProbability)} win probability.`,
    );
    if (poolOwn && poolOwn.share > 0.3) {
      lines.push(
        `It is also projected to be the pool's most popular selection — roughly ${poolOwn.expectedEntries.toFixed(1)} of ${activeOpponents} active opposing entries (${pct(poolOwn.share, 0)}).`,
      );
      lines.push(
        `Fading it would mean giving up immediate survival probability, and across ${simulations.toLocaleString()} tournament simulations no alternative recovered that loss in ${OBJECTIVE_LABEL[objective].toLowerCase()}.`,
      );
    } else {
      lines.push(
        `Projected ownership is only ${pct(poolOwn?.share ?? 0, 0)}, so there is no popularity to fade in the first place.`,
      );
    }
  } else if (survivalPick) {
    const safetyGap = survivalPick.currentWinProbability - poolPick.currentWinProbability;
    lines.push(
      `${teamName(survivalPick.team)} is the safest selection this week at ${pct(survivalPick.currentWinProbability)}.`,
    );
    if (survOwn) {
      lines.push(
        `However, approximately ${survOwn.expectedEntries.toFixed(1)} of ${activeOpponents} active opposing entries (${pct(survOwn.share, 0)}) are projected to select ${teamShort(survivalPick.team)}.`,
      );
    }
    lines.push(
      `${teamName(poolPick.team)} has a ${pct(poolPick.currentWinProbability)} win probability and only ${pct(poolOwn?.share ?? 0, 0)} projected pool ownership.`,
    );
    if (safetyGap > 0) {
      lines.push(
        `Using ${teamShort(poolPick.team)} sacrifices about ${(safetyGap * 100).toFixed(1)} percentage points of immediate survival probability, but creates leverage in the scenarios where ${teamShort(survivalPick.team)} is upset while ${teamShort(poolPick.team)} wins.`,
      );
    }
    if (input.survivalPickFutureWeeks.length > 0) {
      const list = input.survivalPickFutureWeeks
        .slice(0, 2)
        .map((f) => `Week ${f.week} vs ${teamShort(f.opponent)} (${pct(f.prob)})`)
        .join(" and ");
      lines.push(
        `${teamShort(survivalPick.team)} also has strong projected future opportunities — ${list} — which spending it now would forfeit.`,
      );
    }
    lines.push(
      `Across ${simulations.toLocaleString()} tournament simulations: ${teamShort(survivalPick.team)} pool win probability ${pct(survivalPick.poolWinProbability)}, expected prize equity ${pct(survivalPick.expectedPrizeEquity)}; ${teamShort(poolPick.team)} pool win probability ${pct(poolPick.poolWinProbability)}, expected prize equity ${pct(poolPick.expectedPrizeEquity)}.`,
    );
    lines.push(
      `${teamName(poolPick.team)} is therefore the pool-equity recommendation under "${OBJECTIVE_LABEL[objective]}".`,
    );
  }

  const edge = input.inventoryEdges.find((e) => e.team === poolPick.team);
  if (edge && edge.scarcity === "EXCLUSIVE" && activeOpponents > 0) {
    lines.push(
      `No active opposing entry can still use ${teamShort(poolPick.team)}, so spending it costs you nothing in relative inventory.`,
    );
  }
  if (poolPick.popularAlternativeFadeLeverage > 0.15) {
    lines.push(
      `${pct(poolPick.popularAlternativeFadeLeverage, 0)} of this pick's simulated equity comes specifically from worlds where the most popular alternative lost.`,
    );
  }

  const tradeoff =
    survivalPick && survivalPick.team !== poolPick.team
      ? {
          immediateCostPoints:
            (poolPick.currentWinProbability - survivalPick.currentWinProbability) * 100,
          poolWinGainPoints:
            (poolPick.poolWinProbability - survivalPick.poolWinProbability) * 100,
          prizeEquityGainPoints:
            (poolPick.expectedPrizeEquity - survivalPick.expectedPrizeEquity) * 100,
        }
      : null;

  const comparison: ComparisonRow[] | null =
    survivalPick && survivalPick.team !== poolPick.team
      ? [
          { label: "Team", survival: survivalPick.team, poolEquity: poolPick.team },
          {
            label: "Win probability",
            survival: pct(survivalPick.currentWinProbability),
            poolEquity: pct(poolPick.currentWinProbability),
            highlight:
              survivalPick.currentWinProbability > poolPick.currentWinProbability
                ? "survival"
                : "poolEquity",
          },
          {
            label: "Projected ownership",
            survival: pct(survOwn?.share ?? 0, 0),
            poolEquity: pct(poolOwn?.share ?? 0, 0),
          },
          {
            label: "Expected overlap",
            survival: survivalPick.expectedPickOverlap.toFixed(1),
            poolEquity: poolPick.expectedPickOverlap.toFixed(1),
          },
          {
            label: "Pool win probability",
            survival: pct(survivalPick.poolWinProbability),
            poolEquity: pct(poolPick.poolWinProbability),
            highlight:
              poolPick.poolWinProbability > survivalPick.poolWinProbability
                ? "poolEquity"
                : "survival",
          },
          {
            label: "Expected prize equity",
            survival: pct(survivalPick.expectedPrizeEquity),
            poolEquity: pct(poolPick.expectedPrizeEquity),
            highlight:
              poolPick.expectedPrizeEquity > survivalPick.expectedPrizeEquity
                ? "poolEquity"
                : "survival",
          },
          {
            label: "Survives this week",
            survival: pct(survivalPick.survivesCurrentWeek),
            poolEquity: pct(poolPick.survivesCurrentWeek),
          },
          {
            label: "Avg finishing position",
            survival: survivalPick.averageFinishingPosition.toFixed(2),
            poolEquity: poolPick.averageFinishingPosition.toFixed(2),
          },
        ]
      : null;

  let robustnessNote = "Sensitivity analysis was not run for this recommendation.";
  if (input.sensitivity) {
    const agreeCount = input.sensitivity.scenarios.filter(
      (s) => s.bestTeam === poolPick.team,
    ).length;
    robustnessNote = `${poolPick.team} is the recommended pick in ${agreeCount}/${input.sensitivity.scenarios.length} opponent-behaviour scenarios. Robustness: ${input.sensitivity.robustness}.`;
  }

  const objectiveGap = survivalPick
    ? objectiveValue(poolPick, objective) - objectiveValue(survivalPick, objective)
    : 0;
  if (!agrees && objectiveGap > 0 && objectiveGap < 2 * (poolPick.standardError || 0)) {
    lines.push(
      `Caution: the gap between these two picks (${(objectiveGap * 100).toFixed(2)} points) is within Monte Carlo noise at this simulation count. Raise the simulation budget before treating the difference as real.`,
    );
  }

  return {
    headline: agrees
      ? `${teamName(poolPick.team)} — survival and pool equity agree`
      : `${teamName(poolPick.team)} over ${teamName(survivalPick!.team)}`,
    agreesWithSurvival: agrees,
    lines,
    tradeoff,
    comparison,
    robustnessNote,
  };
}
