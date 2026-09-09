/**
 * Feature context for the opponent model, plus leak-free reconstruction of
 * historical decisions.
 *
 * §33 is the constraint that shapes this file: when we learn from an entry's
 * week-3 selection we may only use information that existed before week 3
 * kicked off. That means ratings snapshotted *entering* that week and odds
 * observed *before* its first kickoff — never final scores, never later lines.
 */

import "../server-guard";
import { prisma } from "../db";
import { safeLog } from "../probability";
import type { CanonicalGame, GameProbability } from "../types";
import { optimizePath, buildSlotIndex, type SlotIndex } from "../optimizer/survivor";
import { TEAM_ABBRS } from "../teams";
import type { EntryState, GameTheorySettings } from "./types";
import { featuresFor, type FeatureContext, type Observation } from "./opponentModel";

/**
 * Season log-probability the optimiser gives up by spending each team now,
 * measured against the unconstrained optimum over the same weeks.
 *
 * This is the generic (all-teams-available) version used as an opponent-model
 * feature — a deliberate approximation, since computing it per entry per week
 * would mean thousands of assignment solves. The user's own future-value
 * numbers elsewhere in the app remain inventory-exact.
 */
export function computeFutureValueCosts(
  index: SlotIndex,
  weeks: number[],
  availableTeams: Set<string>,
  isPickable?: (team: string, week: number, p: GameProbability) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  if (weeks.length === 0) return out;

  const base = optimizePath({ index, weeks, availableTeams, isPickable });
  const baseLog = base.logSurvival;

  for (const team of availableTeams) {
    const without = optimizePath({
      index,
      weeks,
      availableTeams,
      excludedTeams: new Set([team]),
      isPickable,
    });
    // Positive = spending this team costs the remaining path something.
    out.set(team, Math.max(0, baseLog - without.logSurvival));
  }
  return out;
}

/**
 * How concentrated a team's remaining value is. A team with one outstanding
 * future week is "scarce" (worth holding for it); a team that is mediocre every
 * week is not.
 */
export function computeScheduleScarcity(index: SlotIndex, weeks: number[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const team of TEAM_ABBRS) {
    const probs: number[] = [];
    for (const w of weeks) {
      const p = index.byWeek.get(w)?.get(team);
      if (p && !p.completed) probs.push(p.finalProb);
    }
    if (probs.length === 0) {
      out.set(team, 0);
      continue;
    }
    const best = Math.max(...probs);
    const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
    // 0 when every week looks the same, rising as the best week stands out.
    out.set(team, Math.max(0, Math.min(1, (best - mean) * 3)));
  }
  return out;
}

export function buildFeatureContext(
  probabilities: GameProbability[],
  weeks: number[],
  availableTeams: Set<string>,
  settings: GameTheorySettings,
  isPickable?: (team: string, week: number, p: GameProbability) => boolean,
): FeatureContext {
  const index = buildSlotIndex(probabilities);
  return {
    byWeek: index.byWeek,
    futureValueCost: computeFutureValueCosts(index, weeks, availableTeams, isPickable),
    scheduleScarcity: computeScheduleScarcity(index, weeks),
    publicPopularity: settings.publicPopularity,
  };
}

/* -------------------------------------------------- historical reconstruction */

export interface HistoricalWeekSnapshot {
  week: number;
  /** Probabilities as they were knowable before this week kicked off. */
  probabilities: GameProbability[];
}

/**
 * Rebuild what each week looked like *before* it was played.
 *
 * Model probabilities come from the ratings snapshot entering that week (the
 * engine already builds these leak-free). Market probabilities come from the
 * newest odds snapshot recorded before the week's first kickoff. Weeks with
 * neither are skipped rather than guessed.
 */
export async function reconstructHistoricalWeeks(
  season: number,
  games: CanonicalGame[],
  weeks: number[],
  buildWeekProbabilities: (week: number, asOf: Date) => GameProbability[],
): Promise<HistoricalWeekSnapshot[]> {
  const out: HistoricalWeekSnapshot[] = [];
  for (const week of weeks) {
    const inWeek = games.filter((g) => g.week === week && g.seasonType === "REG");
    if (inWeek.length === 0) continue;
    const firstKickoff = new Date(
      Math.min(...inWeek.map((g) => Date.parse(g.kickoff)).filter(Number.isFinite)),
    );
    if (!Number.isFinite(firstKickoff.getTime())) continue;
    const probabilities = buildWeekProbabilities(week, firstKickoff);
    if (probabilities.length > 0) out.push({ week, probabilities });
  }
  void prisma;
  void season;
  return out;
}

/**
 * Turn observed pool history into training observations.
 *
 * For each historical (entry, week) pick we reconstruct the option set that was
 * legally available to that entry at the time — teams it had not yet used, that
 * had a game that week — and score the features of every option from the
 * pre-kickoff snapshot. The chosen team is the label.
 */
export function reconstructObservations(
  states: EntryState[],
  snapshots: HistoricalWeekSnapshot[],
  settings: GameTheorySettings,
  futureValueByWeek: Map<number, Map<string, number>>,
  scarcityByWeek: Map<number, Map<string, number>>,
): Observation[] {
  const observations: Observation[] = [];

  for (const snapshot of snapshots) {
    const index = buildSlotIndex(snapshot.probabilities);
    const ctx: FeatureContext = {
      byWeek: index.byWeek,
      futureValueCost: futureValueByWeek.get(snapshot.week) ?? new Map(),
      scheduleScarcity: scarcityByWeek.get(snapshot.week) ?? new Map(),
      publicPopularity: settings.publicPopularity,
    };

    for (const state of states) {
      const pick = state.picks.find((p) => p.week === snapshot.week);
      if (!pick) continue;

      // Inventory as it stood BEFORE this week — strictly earlier picks only.
      const usedBefore = new Set(
        state.picks.filter((p) => p.week < snapshot.week).map((p) => p.team),
      );
      if (usedBefore.has(pick.team)) continue; // malformed history; skip rather than train on it

      const bucket = index.byWeek.get(snapshot.week);
      if (!bucket) continue;

      const legalTeams = [...bucket.keys()].filter((t) => !usedBefore.has(t)).sort();
      if (legalTeams.length < 2 || !legalTeams.includes(pick.team)) continue;

      const options = legalTeams
        .map((team) => ({ team, features: featuresFor(ctx, snapshot.week, team, legalTeams) }))
        .filter((o): o is { team: string; features: NonNullable<typeof o.features> } =>
          o.features != null,
        );
      if (options.length < 2) continue;

      observations.push({
        entryId: state.entry.id,
        week: snapshot.week,
        options,
        chosen: pick.team,
      });
    }
  }

  return observations;
}

/** Descriptive summary of one entry's observed decisions, for the inspector. */
export interface EntryBehaviorSummary {
  entryId: string;
  decisions: {
    week: number;
    team: string;
    safetyRankPosition: number;
    optionCount: number;
    winProbability: number;
  }[];
  meanSafetyPercentile: number | null;
  observedTendency: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  shrinkageWeight: number;
}

export function summariseEntryBehavior(
  entryId: string,
  observations: Observation[],
  shrinkageWeight: number,
): EntryBehaviorSummary {
  const mine = observations.filter((o) => o.entryId === entryId);
  const decisions = mine
    .map((o) => {
      const sorted = [...o.options].sort(
        (a, b) => b.features.winProbability - a.features.winProbability,
      );
      const idx = sorted.findIndex((x) => x.team === o.chosen);
      const chosen = o.options.find((x) => x.team === o.chosen)!;
      return {
        week: o.week,
        team: o.chosen,
        safetyRankPosition: idx + 1,
        optionCount: o.options.length,
        winProbability: chosen.features.winProbability,
      };
    })
    .sort((a, b) => a.week - b.week);

  const percentiles = decisions.map((d) =>
    d.optionCount <= 1 ? 1 : 1 - (d.safetyRankPosition - 1) / (d.optionCount - 1),
  );
  const meanSafetyPercentile =
    percentiles.length > 0 ? percentiles.reduce((a, b) => a + b, 0) / percentiles.length : null;

  // Descriptive statistical language only — never psychological labels (§9).
  let observedTendency = "No decisions observed yet.";
  if (meanSafetyPercentile != null) {
    const topThree = decisions.filter((d) => d.safetyRankPosition <= 3).length;
    if (meanSafetyPercentile >= 0.9) {
      observedTendency = `Selected among the week's safest options in ${topThree} of ${decisions.length} observed decisions.`;
    } else if (meanSafetyPercentile >= 0.7) {
      observedTendency = `Usually selected from the upper range of available win probabilities (mean safety percentile ${(meanSafetyPercentile * 100).toFixed(0)}%).`;
    } else if (meanSafetyPercentile >= 0.45) {
      observedTendency = `Selected across a wide range of available win probabilities (mean safety percentile ${(meanSafetyPercentile * 100).toFixed(0)}%).`;
    } else {
      observedTendency = `Frequently selected options outside the week's highest win probabilities (mean safety percentile ${(meanSafetyPercentile * 100).toFixed(0)}%).`;
    }
  }

  const n = decisions.length;
  return {
    entryId,
    decisions,
    meanSafetyPercentile,
    observedTendency,
    confidence: n === 0 ? "NONE" : n >= 8 ? "MEDIUM" : n >= 4 ? "LOW" : "LOW",
    shrinkageWeight,
  };
}

export function safeLogOrZero(p: number): number {
  return Number.isFinite(p) ? safeLog(p) : 0;
}
