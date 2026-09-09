/** Shared fixtures for the game-theory suites. */

import type { GameProbability } from "@/lib/types";
import type { EntryState, PoolEntryRecord } from "@/lib/gametheory/types";

export function gp(
  team: string,
  week: number,
  opponent: string,
  finalProb: number,
  isHome: boolean,
  gameId: string,
): GameProbability {
  return {
    gameId,
    season: 2026,
    week,
    team,
    opponent,
    isHome,
    neutralSite: false,
    kickoff: `2026-09-${String(6 + week).padStart(2, "0")}T17:00:00.000Z`,
    started: false,
    completed: false,
    marketProb: finalProb,
    modelProb: finalProb,
    finalProb,
    marketWeight: 0.8,
    injuryAdjustment: 0,
    weatherAdjustment: 0,
    horizonWeeks: Math.max(0, week - 1),
    confidence: "HIGH",
    confidenceScore: 0.8,
    dataQuality: "OK",
    bookCount: 8,
    spread: null,
    moneyline: null,
    oddsLastUpdated: null,
    manualOverride: false,
    factors: [],
  };
}

/** Both sides of one game, so the fixture stays internally consistent. */
export function matchup(
  week: number,
  home: string,
  away: string,
  homeProb: number,
): GameProbability[] {
  const id = `2026_${String(week).padStart(2, "0")}_${away}_${home}`;
  return [gp(home, week, away, homeProb, true, id), gp(away, week, home, 1 - homeProb, false, id)];
}

export function entryRecord(
  id: string,
  displayName: string,
  isUser: boolean,
  owner: string | null = null,
): PoolEntryRecord {
  return {
    id,
    poolId: "pool",
    season: 2026,
    displayName,
    ownerName: owner,
    isUser,
    status: "ACTIVE",
    eliminatedWeek: null,
    eliminationReason: null,
    manualStatusOverride: false,
    notes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

export function entryState(
  id: string,
  displayName: string,
  isUser: boolean,
  usedTeams: string[],
  allTeams: string[],
  opts: { owner?: string | null; knownCurrentPick?: string | null; status?: EntryState["entry"]["status"] } = {},
): EntryState {
  const entry = entryRecord(id, displayName, isUser, opts.owner ?? null);
  if (opts.status) entry.status = opts.status;
  return {
    entry,
    picks: [],
    usedTeams,
    remainingTeams: allTeams.filter((t) => !usedTeams.includes(t)),
    knownCurrentPick: opts.knownCurrentPick ?? null,
  };
}

/** A point-mass distribution, for opponents whose pick we want to pin down. */
export function certain(entryId: string, entryName: string, team: string) {
  return {
    entryId,
    entryName,
    distribution: { [team]: 1 },
    isKnown: false,
    legalTeams: [team],
  };
}
