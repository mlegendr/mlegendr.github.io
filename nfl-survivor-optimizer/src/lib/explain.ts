/**
 * Explanation engine.
 *
 * "Dallas score = 7.46" tells a user nothing. This module turns the optimiser's
 * output back into the argument a thoughtful pool player would make, and — just
 * as important — separates what is *known* (a posted line, a home game, an
 * official OUT) from what is *modelled* (a rating edge) and what is *assumed*
 * (a Week 14 forecast made in Week 5).
 */

import { safeLog } from "./probability";
import { teamName, teamShort } from "./teams";
import type {
  CandidateEvaluation,
  HorizonKey,
  ProbabilityFactor,
  ScoredInjury,
} from "./types";
import type { SlotIndex } from "./optimizer/survivor";

export interface Explanation {
  headline: string;
  why: ProbabilityFactor[];
  whyNot: { team: string; lines: ProbabilityFactor[] } | null;
  comparison: string | null;
  caveats: string[];
}

export interface ExplainInput {
  best: CandidateEvaluation;
  runnerUp: CandidateEvaluation | null;
  preserve: CandidateEvaluation | null;
  index: SlotIndex;
  remainingWeeks: number[];
  defaultHorizon: HorizonKey;
  injuries: Map<string, ScoredInjury[]>;
  usedTeams: Set<string>;
}

/** How many genuinely strong future spots a team still has on its schedule. */
export function futureOpportunities(
  index: SlotIndex,
  team: string,
  weeks: number[],
  threshold = 0.7,
): { week: number; opponent: string; prob: number }[] {
  const out: { week: number; opponent: string; prob: number }[] = [];
  for (const w of weeks) {
    const p = index.byWeek.get(w)?.get(team);
    if (p && !p.completed && p.finalProb >= threshold) {
      out.push({ week: w, opponent: p.opponent, prob: p.finalProb });
    }
  }
  return out.sort((a, b) => b.prob - a.prob);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function explainRecommendation(input: ExplainInput): Explanation {
  const { best, runnerUp, preserve, index, remainingWeeks, defaultHorizon } = input;
  const future = remainingWeeks.filter((w) => w > (best.path[0]?.week ?? 0));
  const why: ProbabilityFactor[] = [];

  if (best.marketProb != null) {
    why.push({
      kind: "fact",
      label: "Market",
      detail: `Consensus sportsbooks imply a ${pct(best.marketProb)} win probability for ${teamName(
        best.team,
      )} after removing the vig.`,
    });
  } else {
    why.push({
      kind: "estimate",
      label: "No market yet",
      detail: `No sportsbook has priced this game, so ${pct(
        best.modelProb,
      )} comes from the team model alone.`,
    });
  }

  why.push({
    kind: best.isHome ? "fact" : "fact",
    label: best.isHome ? "Home game" : "Road game",
    detail: `${teamShort(best.team)} ${best.isHome ? "hosts" : "visits"} ${teamName(best.opponent)}.`,
  });

  const oppInjuries = (input.injuries.get(best.opponent) ?? []).filter(
    (i) => i.impact === "CRITICAL" || i.impact === "HIGH",
  );
  if (oppInjuries.length > 0) {
    const top = oppInjuries[0];
    why.push({
      kind: "fact",
      label: "Opponent injury",
      detail: `${teamShort(best.opponent)} has ${top.playerName} (${top.position}) listed ${top.status.toLowerCase()} — impact ${top.impact}.`,
    });
  }

  const bestFuture = futureOpportunities(index, best.team, future);
  why.push({
    kind: "estimate",
    label: "Future value",
    detail:
      bestFuture.length === 0
        ? `${teamShort(best.team)} has no remaining projected matchup above 70%, so spending it now costs almost nothing later.`
        : `${teamShort(best.team)} has ${bestFuture.length} remaining projected matchup${
            bestFuture.length === 1 ? "" : "s"
          } above 70% (best: Week ${bestFuture[0].week} vs ${teamShort(bestFuture[0].opponent)} at ${pct(
            bestFuture[0].prob,
          )}), which the optimiser can still cover with other teams.`,
  });

  why.push({
    kind: "estimate",
    label: "Optimised path",
    detail: `Using ${teamShort(best.team)} this week leaves a ${pct(
      best.pathSurvival[defaultHorizon] ?? 0,
    )} chance of surviving the next ${
      defaultHorizon === "season" ? "rest of the season" : `${defaultHorizon} weeks`
    } and ${pct(best.pathSurvival["season"] ?? 0)} for the full remaining season.`,
  });

  // ---- "Why not X?" -------------------------------------------------------
  const alternative = preserve ?? runnerUp;
  let whyNot: Explanation["whyNot"] = null;
  let comparison: string | null = null;

  if (alternative && alternative.team !== best.team) {
    const lines: ProbabilityFactor[] = [];
    const safetyGap = alternative.currentWinProb - best.currentWinProb;
    const altFuture = futureOpportunities(index, alternative.team, future);

    if (safetyGap > 0.0005) {
      lines.push({
        kind: "fact",
        label: "Safer this week",
        detail: `${teamShort(alternative.team)} is ${(safetyGap * 100).toFixed(
          1,
        )} percentage points safer this week (${pct(alternative.currentWinProb)} vs ${pct(
          best.currentWinProb,
        )}).`,
      });
    } else {
      lines.push({
        kind: "fact",
        label: "This week",
        detail: `${teamShort(alternative.team)} projects at ${pct(alternative.currentWinProb)} this week.`,
      });
    }

    if (altFuture.length > 0) {
      const weeksList = altFuture
        .slice(0, 3)
        .map((f) => `Week ${f.week} vs ${teamShort(f.opponent)} (${pct(f.prob)})`)
        .join(", ");
      lines.push({
        kind: "estimate",
        label: "Better saved",
        detail: `${teamShort(alternative.team)} has unusually favourable future spots — ${weeksList}. Preserving it materially improves the rest of the path.`,
      });
    }

    const lossPoints =
      (safeLog(best.pathSurvival[defaultHorizon] ?? 1e-9) -
        safeLog(alternative.pathSurvival[defaultHorizon] ?? 1e-9)) *
      100;
    lines.push({
      kind: "estimate",
      label: "Net effect",
      detail: `Forcing ${teamShort(alternative.team)} this week lowers the ${
        defaultHorizon === "season" ? "season" : `${defaultHorizon}-week`
      } optimised survival to ${pct(alternative.pathSurvival[defaultHorizon] ?? 0)} (from ${pct(
        best.pathSurvival[defaultHorizon] ?? 0,
      )}).`,
      deltaPoints: -lossPoints,
    });

    whyNot = { team: alternative.team, lines };

    if (safetyGap > 0.0005) {
      comparison = `${teamShort(alternative.team)} is roughly ${(safetyGap * 100).toFixed(
        1,
      )} points safer this week, but ${teamShort(
        alternative.team,
      )} has ${altFuture.length} strong future matchup${altFuture.length === 1 ? "" : "s"} left. Spending ${teamShort(
        best.team,
      )} now produces the higher optimised probability of surviving the next ${
        defaultHorizon === "season" ? "rest of the season" : `${defaultHorizon} weeks`
      }.`;
    } else {
      comparison = `${teamShort(best.team)} is both the safest legal pick this week and the one that costs the least future value.`;
    }
  }

  // ---- Caveats: never let the app look more certain than it is. -----------
  const caveats: string[] = [];
  if (best.confidence !== "HIGH") {
    caveats.push(
      `Confidence for this game is ${best.confidence}: check the market freshness and injury columns before locking it in.`,
    );
  }
  if (best.marketProb == null) {
    caveats.push("No sportsbook market exists for this game yet — the estimate is model-only.");
  }
  const winners = new Set(Object.values(best.horizonWinners).filter(Boolean));
  if (winners.size > 1) {
    caveats.push(
      `The optimal pick differs by horizon (${Object.entries(best.horizonWinners)
        .map(([k, v]) => `${k === "season" ? "season" : `${k}-week`}: ${v ?? "n/a"}`)
        .join(", ")}), so this recommendation is horizon-sensitive.`,
    );
  }
  caveats.push(
    "Future weeks in the path are plans, not commitments — they are recomputed every week as results and lines arrive.",
  );

  const headline = `${teamName(best.team)} ${best.isHome ? "vs" : "at"} ${teamName(best.opponent)}`;

  return { headline, why, whyNot, comparison, caveats };
}

/** Horizon agreement — a pick backed across horizons deserves more trust. */
export function horizonAgreement(winners: Record<string, string | null>): {
  agreement: number;
  label: "HIGH" | "MEDIUM" | "LOW";
} {
  const values = Object.values(winners).filter(Boolean) as string[];
  if (values.length === 0) return { agreement: 0, label: "LOW" };
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const agreement = top / values.length;
  return {
    agreement,
    label: agreement >= 0.99 ? "HIGH" : agreement >= 0.5 ? "MEDIUM" : "LOW",
  };
}
