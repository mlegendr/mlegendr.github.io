/**
 * Pool entries: persistence, per-entry inventory and automatic elimination.
 *
 * Every entry owns an independent used-team set. Two entries belonging to the
 * same human are as separate here as two entries belonging to strangers — the
 * only thing `ownerName` does is group them for display.
 */

import "../server-guard";
import { prisma } from "../db";
import { now } from "../clock";
import { TEAM_ABBRS, normalizeTeam } from "../teams";
import { getOrCreatePool, listPicks } from "../pool";
import type {
  EntryPickRecord,
  EntryState,
  EntryStatus,
  PickSource,
  PickStatus,
  PoolEntryRecord,
} from "./types";

type EntryRow = Awaited<ReturnType<typeof prisma.poolEntry.findFirstOrThrow>>;
type PickRow = Awaited<ReturnType<typeof prisma.entryPick.findFirstOrThrow>>;

function toEntry(row: EntryRow): PoolEntryRecord {
  return {
    id: row.id,
    poolId: row.poolId,
    season: row.season,
    displayName: row.displayName,
    ownerName: row.ownerName,
    isUser: row.isUser,
    status: row.status as EntryStatus,
    eliminatedWeek: row.eliminatedWeek,
    eliminationReason: row.eliminationReason,
    manualStatusOverride: row.manualStatusOverride,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPick(row: PickRow): EntryPickRecord {
  return {
    id: row.id,
    poolEntryId: row.poolEntryId,
    season: row.season,
    week: row.week,
    team: row.teamAbbr,
    gameId: row.gameId,
    pickSource: row.pickSource as PickSource,
    pickStatus: row.pickStatus as PickStatus,
    isKnown: row.isKnown,
  };
}

export const USER_ENTRY_NAME = "My Entry";

/** Create (or fetch) the entry that represents the user's own survivor position. */
export async function ensureUserEntry(poolId: string, season: number): Promise<PoolEntryRecord> {
  const existing = await prisma.poolEntry.findFirst({
    where: { poolId, season, isUser: true },
  });
  if (existing) return toEntry(existing);
  const created = await prisma.poolEntry.create({
    data: { poolId, season, displayName: USER_ENTRY_NAME, isUser: true, status: "ACTIVE" },
  });
  return toEntry(created);
}

/**
 * Mirror the legacy `Pick` table into the user's PoolEntry.
 *
 * The survival optimizer still reads `Pick` as its single source of truth, so
 * this is a one-way projection: nothing here can change what the naive
 * optimizer sees. It exists so the tournament simulator can treat the user as
 * just another entry.
 */
export async function syncUserEntryFromPicks(poolId: string, season: number): Promise<number> {
  const entry = await ensureUserEntry(poolId, season);
  const picks = await listPicks(poolId, season);
  const confirmed = picks.filter((p) => p.confirmed);

  await prisma.entryPick.deleteMany({
    where: {
      poolEntryId: entry.id,
      season,
      week: { notIn: confirmed.map((p) => p.week) },
      pickSource: { not: "MANUAL_OVERRIDE" },
    },
  });

  for (const p of confirmed) {
    const status: PickStatus =
      p.result === "WIN" || p.result === "LOSS" || p.result === "TIE" ? p.result : "PENDING";
    await prisma.entryPick.upsert({
      where: { poolEntryId_season_week: { poolEntryId: entry.id, season, week: p.week } },
      create: {
        poolEntryId: entry.id,
        season,
        week: p.week,
        teamAbbr: p.team,
        gameId: p.gameId,
        pickSource: "USER_ENTERED",
        pickStatus: status,
        isKnown: true,
      },
      update: { teamAbbr: p.team, gameId: p.gameId, pickStatus: status, isKnown: true },
    });
  }
  return confirmed.length;
}

export interface UpsertEntryInput {
  poolId: string;
  season: number;
  displayName: string;
  ownerName?: string | null;
  isUser?: boolean;
  notes?: string | null;
}

export async function upsertEntry(input: UpsertEntryInput): Promise<PoolEntryRecord> {
  const row = await prisma.poolEntry.upsert({
    where: {
      poolId_season_displayName: {
        poolId: input.poolId,
        season: input.season,
        displayName: input.displayName,
      },
    },
    create: {
      poolId: input.poolId,
      season: input.season,
      displayName: input.displayName,
      ownerName: input.ownerName ?? null,
      isUser: input.isUser ?? false,
      notes: input.notes ?? null,
    },
    update: { ownerName: input.ownerName ?? null, notes: input.notes ?? null },
  });
  return toEntry(row);
}

export async function deleteEntry(id: string): Promise<void> {
  await prisma.poolEntry.delete({ where: { id } }).catch(() => undefined);
}

export interface SetEntryPickInput {
  entryId: string;
  season: number;
  week: number;
  team: string;
  source?: PickSource;
  isKnown?: boolean;
}

export async function setEntryPick(input: SetEntryPickInput): Promise<EntryPickRecord> {
  const team = normalizeTeam(input.team);
  if (!team) throw new Error(`Unrecognised team: ${input.team}`);
  const game = await prisma.game.findFirst({
    where: {
      season: input.season,
      week: input.week,
      seasonType: "REG",
      OR: [{ homeTeamAbbr: team }, { awayTeamAbbr: team }],
    },
  });
  const row = await prisma.entryPick.upsert({
    where: {
      poolEntryId_season_week: {
        poolEntryId: input.entryId,
        season: input.season,
        week: input.week,
      },
    },
    create: {
      poolEntryId: input.entryId,
      season: input.season,
      week: input.week,
      teamAbbr: team,
      gameId: game?.id ?? null,
      pickSource: input.source ?? "USER_ENTERED",
      isKnown: input.isKnown ?? true,
    },
    update: {
      teamAbbr: team,
      gameId: game?.id ?? null,
      pickSource: input.source ?? "USER_ENTERED",
      isKnown: input.isKnown ?? true,
      pickStatus: "PENDING",
    },
  });
  return toPick(row);
}

export async function deleteEntryPick(entryId: string, season: number, week: number) {
  await prisma.entryPick
    .delete({ where: { poolEntryId_season_week: { poolEntryId: entryId, season, week } } })
    .catch(() => undefined);
}

/* ------------------------------------------------------------ elimination */

export interface GradeResult {
  gradedPicks: number;
  eliminated: number;
  entries: PoolEntryRecord[];
}

/**
 * Grade every entry pick against real NFL results and derive alive/eliminated.
 *
 * An entry is eliminated at the FIRST week it lost — later picks do not
 * resurrect it, and the reason records the actual scoreline. Entries flagged
 * `manualStatusOverride` are graded but never re-statused.
 */
export async function gradeEntries(
  poolId: string,
  season: number,
  tieCountsAsLoss: boolean,
): Promise<GradeResult> {
  const entries = await prisma.poolEntry.findMany({ where: { poolId, season } });
  const picks = await prisma.entryPick.findMany({
    where: { season, poolEntryId: { in: entries.map((e) => e.id) } },
    orderBy: { week: "asc" },
  });
  const gameIds = [...new Set(picks.map((p) => p.gameId).filter(Boolean))] as string[];
  const games = await prisma.game.findMany({
    where: { OR: [{ id: { in: gameIds } }, { season, seasonType: "REG" }] },
  });
  const gameById = new Map(games.map((g) => [g.id, g]));
  const gameFor = (week: number, team: string) =>
    games.find(
      (g) =>
        g.season === season &&
        g.week === week &&
        g.seasonType === "REG" &&
        (g.homeTeamAbbr === team || g.awayTeamAbbr === team),
    ) ?? null;

  let gradedPicks = 0;
  let eliminated = 0;
  const out: PoolEntryRecord[] = [];

  for (const entry of entries) {
    const mine = picks.filter((p) => p.poolEntryId === entry.id).sort((a, b) => a.week - b.week);
    let elimWeek: number | null = null;
    let elimReason: string | null = null;

    for (const pick of mine) {
      const game = (pick.gameId ? gameById.get(pick.gameId) : null) ?? gameFor(pick.week, pick.teamAbbr);
      let status: PickStatus = "PENDING";
      if (game?.completed && game.homeScore != null && game.awayScore != null) {
        const isHome = game.homeTeamAbbr === pick.teamAbbr;
        const mineScore = isHome ? game.homeScore : game.awayScore;
        const theirs = isHome ? game.awayScore : game.homeScore;
        status = mineScore > theirs ? "WIN" : mineScore < theirs ? "LOSS" : "TIE";

        const isElimination = status === "LOSS" || (status === "TIE" && tieCountsAsLoss);
        if (isElimination && elimWeek == null) {
          elimWeek = pick.week;
          const opponent = isHome ? game.awayTeamAbbr : game.homeTeamAbbr;
          elimReason =
            status === "TIE"
              ? `Picked ${pick.teamAbbr}; ${pick.teamAbbr} tied ${opponent} ${mineScore}–${theirs} (a tie counts as a loss in this pool)`
              : `Picked ${pick.teamAbbr}; ${pick.teamAbbr} lost to ${opponent} ${mineScore}–${theirs}`;
        }
      }
      if (status !== pick.pickStatus) {
        await prisma.entryPick.update({ where: { id: pick.id }, data: { pickStatus: status } });
        gradedPicks += 1;
      }
      if (game && !pick.gameId) {
        await prisma.entryPick.update({ where: { id: pick.id }, data: { gameId: game.id } });
      }
    }

    if (entry.manualStatusOverride) {
      out.push(toEntry(entry));
      continue;
    }

    const status: EntryStatus = elimWeek != null ? "ELIMINATED" : "ACTIVE";
    if (
      status !== entry.status ||
      elimWeek !== entry.eliminatedWeek ||
      elimReason !== entry.eliminationReason
    ) {
      const updated = await prisma.poolEntry.update({
        where: { id: entry.id },
        data: { status, eliminatedWeek: elimWeek, eliminationReason: elimReason },
      });
      out.push(toEntry(updated));
    } else {
      out.push(toEntry(entry));
    }
    if (status === "ELIMINATED") eliminated += 1;
  }

  return { gradedPicks, eliminated, entries: out };
}

export async function setEntryStatusOverride(
  id: string,
  status: EntryStatus,
  eliminatedWeek: number | null,
  reason: string | null,
): Promise<PoolEntryRecord> {
  const row = await prisma.poolEntry.update({
    where: { id },
    data: {
      status,
      eliminatedWeek,
      eliminationReason: reason,
      manualStatusOverride: true,
      updatedAt: now(),
    },
  });
  return toEntry(row);
}

export async function clearEntryStatusOverride(id: string): Promise<PoolEntryRecord> {
  const row = await prisma.poolEntry.update({
    where: { id },
    data: { manualStatusOverride: false },
  });
  return toEntry(row);
}

/* -------------------------------------------------------------- inventory */

/**
 * Load every entry with its independent inventory.
 *
 * `currentWeek` matters only for `knownCurrentPick`: a pick recorded for the
 * current week is a *known* selection rather than a spent team, so it is
 * excluded from `usedTeams` until that week resolves.
 */
export async function loadEntryStates(
  poolId: string,
  season: number,
  currentWeek: number,
): Promise<EntryState[]> {
  const entries = await prisma.poolEntry.findMany({
    where: { poolId, season },
    orderBy: [{ isUser: "desc" }, { displayName: "asc" }],
  });
  const picks = await prisma.entryPick.findMany({
    where: { season, poolEntryId: { in: entries.map((e) => e.id) } },
    orderBy: { week: "asc" },
  });

  return entries.map((row) => {
    const entry = toEntry(row);
    const mine = picks.filter((p) => p.poolEntryId === row.id).map(toPick);
    // Teams spent in weeks already played. The current week's pick is known but
    // not yet "used up" from the simulator's point of view — it is this week's
    // decision, and the simulator applies it itself.
    const used = [...new Set(mine.filter((p) => p.week < currentWeek).map((p) => p.team))].sort();
    const usedSet = new Set(used);
    const current = mine.find((p) => p.week === currentWeek) ?? null;
    return {
      entry,
      picks: mine,
      usedTeams: used,
      remainingTeams: TEAM_ABBRS.filter((t) => !usedSet.has(t)),
      knownCurrentPick: current?.isKnown ? current.team : null,
    };
  });
}

export function activeEntries(states: EntryState[]): EntryState[] {
  return states.filter((s) => s.entry.status === "ACTIVE" || s.entry.status === "WINNER");
}

export function activeOpponents(states: EntryState[]): EntryState[] {
  return activeEntries(states).filter((s) => !s.entry.isUser);
}

/** Convenience wrapper used by API routes and the engine. */
export async function loadPoolField(season: number, currentWeek: number) {
  const pool = await getOrCreatePool(season);
  await ensureUserEntry(pool.id, season);
  await syncUserEntryFromPicks(pool.id, season);
  await gradeEntries(pool.id, season, pool.settings.tieCountsAsLoss);
  const states = await loadEntryStates(pool.id, season, currentWeek);
  return { pool, states };
}
