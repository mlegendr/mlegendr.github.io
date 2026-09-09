/**
 * Inventory metrics: who else can still use a team, and what that is worth.
 *
 * The user's own future-value calculation (already in the survival optimizer)
 * asks "what do I give up by spending this team?". These metrics add the
 * competitive half: "and how many rivals could have spent it too?". A team is
 * strategically scarce when the user holds it and most active opposing entries
 * no longer can.
 *
 * None of these are combined into a score. They feed the tournament simulator
 * and the explanations, and the ranking always comes from simulated equity.
 */

import { TEAM_ABBRS } from "../teams";
import type { GameProbability } from "../types";
import type { EntryState, InventoryEdge, ProjectedOwnershipRow, EntryPickDistribution } from "./types";
import { activeEntries } from "./entries";

/** Opponent access rate for every team: §7's core quantity. */
export function computeInventoryEdges(
  states: EntryState[],
  userState: EntryState | null,
): InventoryEdge[] {
  const opponents = activeEntries(states).filter((s) => !s.entry.isUser);
  const activeOpponents = opponents.length;
  const userRemaining = new Set(userState?.remainingTeams ?? TEAM_ABBRS);

  return TEAM_ABBRS.map((team) => {
    const opponentsWithTeam = opponents.filter((s) => !s.usedTeams.includes(team)).length;
    const rate = activeOpponents === 0 ? 0 : opponentsWithTeam / activeOpponents;
    const userHasTeam = userRemaining.has(team);
    const advantage = userHasTeam ? 1 - rate : 0;
    const scarcity: InventoryEdge["scarcity"] = !userHasTeam
      ? "UNAVAILABLE"
      : activeOpponents === 0
        ? "COMMON"
        : rate === 0
          ? "EXCLUSIVE"
          : rate <= 0.35
            ? "SCARCE"
            : "COMMON";
    return {
      team,
      userHasTeam,
      opponentsWithTeam,
      activeOpponents,
      opponentAccessRate: rate,
      inventoryAdvantage: advantage,
      scarcity,
    };
  });
}

/**
 * Relative future value (§7): the user's own future-value figure re-weighted by
 * how exclusive the team is. Reported alongside the raw number, never blended
 * into it.
 */
export interface RelativeFutureValue {
  team: string;
  /** The survival optimizer's own figure: season log-prob given up. */
  ownFutureValue: number;
  opponentAccessRate: number;
  /** ownFutureValue scaled by exclusivity. Higher = more worth preserving. */
  relativeFutureValue: number;
  interpretation: string;
}

export function computeRelativeFutureValue(
  futureValueCost: Map<string, number>,
  edges: InventoryEdge[],
): RelativeFutureValue[] {
  const byTeam = new Map(edges.map((e) => [e.team, e]));
  return [...futureValueCost.entries()]
    .map(([team, own]) => {
      const edge = byTeam.get(team);
      const rate = edge?.opponentAccessRate ?? 1;
      // Exclusivity multiplier in [1, 2]: a team nobody else can use is worth
      // roughly twice as much to hold as one everybody still has.
      const relative = own * (1 + (1 - rate));
      let interpretation: string;
      if (!edge?.userHasTeam) interpretation = "Already used — no inventory value.";
      else if (own < 0.02) interpretation = "Little future value; cheap to spend now.";
      else if (rate <= 0.2)
        interpretation = `High future value and only ${(rate * 100).toFixed(0)}% of active opposing entries still hold it — unusually strong to preserve.`;
      else if (rate >= 0.8)
        interpretation = `High future value, but ${(rate * 100).toFixed(0)}% of opposing entries also still hold it — preserving it buys little unique advantage.`;
      else interpretation = "Moderate future value with partial opponent access.";
      return {
        team,
        ownFutureValue: own,
        opponentAccessRate: rate,
        relativeFutureValue: relative,
        interpretation,
      };
    })
    .sort((a, b) => b.relativeFutureValue - a.relativeFutureValue);
}

/**
 * Aggregate per-entry pick distributions into projected pool ownership (§12).
 * These are EXPECTED selections and must be labelled MODEL-PREDICTED in the UI,
 * except where an entry's pick is known.
 */
export function projectOwnership(
  distributions: EntryPickDistribution[],
  states: EntryState[],
): ProjectedOwnershipRow[] {
  const opponents = activeEntries(states).filter((s) => !s.entry.isUser);
  const total = opponents.length;
  const expected = new Map<string, number>();
  const known = new Map<string, number>();

  for (const d of distributions) {
    for (const [team, p] of Object.entries(d.distribution)) {
      expected.set(team, (expected.get(team) ?? 0) + p);
      if (d.isKnown && p >= 1) known.set(team, (known.get(team) ?? 0) + 1);
    }
  }

  const access = new Map<string, number>();
  for (const team of TEAM_ABBRS) {
    access.set(team, opponents.filter((s) => !s.usedTeams.includes(team)).length);
  }

  return TEAM_ABBRS.map((team) => {
    const e = expected.get(team) ?? 0;
    const withAccess = access.get(team) ?? 0;
    return {
      team,
      expectedEntries: e,
      share: total === 0 ? 0 : e / total,
      entriesWithAccess: withAccess,
      opponentAccessRate: total === 0 ? 0 : withAccess / total,
      known: known.get(team) ?? 0,
    };
  })
    .filter((r) => r.expectedEntries > 0.0005 || r.entriesWithAccess > 0)
    .sort((a, b) => b.expectedEntries - a.expectedEntries);
}

/** Future-week inventory edge for the season heatmap (§24). */
export interface FutureInventoryCell {
  week: number;
  team: string;
  opponent: string;
  winProbability: number;
  userHasTeam: boolean;
  opponentAccessRate: number;
  edge: "STRONG" | "MODERATE" | "NONE";
}

export function computeFutureInventoryEdges(
  probabilities: GameProbability[],
  edges: InventoryEdge[],
  weeks: number[],
  threshold = 0.68,
): FutureInventoryCell[] {
  const byTeam = new Map(edges.map((e) => [e.team, e]));
  const weekSet = new Set(weeks);
  const out: FutureInventoryCell[] = [];
  for (const p of probabilities) {
    if (!weekSet.has(p.week) || p.completed) continue;
    if (p.finalProb < threshold) continue;
    const edge = byTeam.get(p.team);
    if (!edge) continue;
    const rate = edge.opponentAccessRate;
    out.push({
      week: p.week,
      team: p.team,
      opponent: p.opponent,
      winProbability: p.finalProb,
      userHasTeam: edge.userHasTeam,
      opponentAccessRate: rate,
      edge: edge.userHasTeam && rate <= 0.25 ? "STRONG" : edge.userHasTeam && rate <= 0.5 ? "MODERATE" : "NONE",
    });
  }
  return out.sort((a, b) => a.week - b.week || b.winProbability - a.winProbability);
}
