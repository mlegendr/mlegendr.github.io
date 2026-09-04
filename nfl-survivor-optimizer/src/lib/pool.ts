/**
 * Pool state: settings, confirmed picks and the used-team set.
 *
 * The critical invariant of the whole app lives here: a team is unavailable if
 * and only if it appears on a **confirmed** pick. A recommendation is never
 * treated as used.
 */

import "./server-guard";
import { prisma } from "./db";
import { DEFAULT_SETTINGS, type PoolSettings } from "./types";

export const DEFAULT_POOL_ID = "default";

export async function getOrCreatePool(season: number): Promise<{
  id: string;
  name: string;
  season: number;
  settings: PoolSettings;
}> {
  let pool = await prisma.pool.findFirst({ where: { isActive: true } });
  if (!pool) {
    pool = await prisma.pool.create({
      data: {
        id: DEFAULT_POOL_ID,
        name: "My Survivor Pool",
        season,
        settingsJson: JSON.stringify({ ...DEFAULT_SETTINGS, season }),
      },
    });
  }
  return {
    id: pool.id,
    name: pool.name,
    season: pool.season,
    settings: parseSettings(pool.settingsJson, pool.season),
  };
}

export function parseSettings(json: string, season: number): PoolSettings {
  try {
    const parsed = JSON.parse(json) as Partial<PoolSettings>;
    return { ...DEFAULT_SETTINGS, season, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS, season };
  }
}

export async function updateSettings(
  poolId: string,
  patch: Partial<PoolSettings>,
): Promise<PoolSettings> {
  const pool = await prisma.pool.findUniqueOrThrow({ where: { id: poolId } });
  const current = parseSettings(pool.settingsJson, pool.season);
  const next: PoolSettings = { ...current, ...patch };
  await prisma.pool.update({
    where: { id: poolId },
    data: { settingsJson: JSON.stringify(next), season: next.season },
  });
  return next;
}

export interface PickRecord {
  id: string;
  season: number;
  week: number;
  team: string;
  opponent: string | null;
  gameId: string | null;
  confirmed: boolean;
  result: string;
  winProbAtPick: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listPicks(poolId: string, season: number): Promise<PickRecord[]> {
  const rows = await prisma.pick.findMany({
    where: { poolId, season },
    orderBy: { week: "asc" },
  });
  return rows.map((p) => ({
    id: p.id,
    season: p.season,
    week: p.week,
    team: p.teamAbbr,
    opponent: p.opponentAbbr,
    gameId: p.gameId,
    confirmed: p.confirmed,
    result: p.result,
    winProbAtPick: p.winProbAtPick,
    note: p.note,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

/**
 * Teams that may never be recommended again.
 * Only confirmed picks count — this is the hard constraint the optimiser obeys.
 */
export async function usedTeams(poolId: string, season: number): Promise<Set<string>> {
  const rows = await prisma.pick.findMany({
    where: { poolId, season, confirmed: true },
    select: { teamAbbr: true },
  });
  return new Set(rows.map((r) => r.teamAbbr));
}

export interface ConfirmPickInput {
  poolId: string;
  season: number;
  week: number;
  team: string;
  opponent?: string | null;
  gameId?: string | null;
  confirmed: boolean;
  winProbAtPick?: number | null;
  note?: string | null;
}

export async function upsertPick(input: ConfirmPickInput): Promise<PickRecord> {
  const row = await prisma.pick.upsert({
    where: { poolId_season_week: { poolId: input.poolId, season: input.season, week: input.week } },
    create: {
      poolId: input.poolId,
      season: input.season,
      week: input.week,
      teamAbbr: input.team,
      opponentAbbr: input.opponent ?? null,
      gameId: input.gameId ?? null,
      confirmed: input.confirmed,
      winProbAtPick: input.winProbAtPick ?? null,
      note: input.note ?? null,
    },
    update: {
      teamAbbr: input.team,
      opponentAbbr: input.opponent ?? null,
      gameId: input.gameId ?? null,
      confirmed: input.confirmed,
      winProbAtPick: input.winProbAtPick ?? null,
      note: input.note ?? null,
    },
  });
  return {
    id: row.id,
    season: row.season,
    week: row.week,
    team: row.teamAbbr,
    opponent: row.opponentAbbr,
    gameId: row.gameId,
    confirmed: row.confirmed,
    result: row.result,
    winProbAtPick: row.winProbAtPick,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deletePick(poolId: string, season: number, week: number): Promise<void> {
  await prisma.pick
    .delete({ where: { poolId_season_week: { poolId, season, week } } })
    .catch(() => undefined);
}

/**
 * Grade confirmed picks against final scores.
 * `tieCountsAsLoss` is a pool rule, so it is read from settings rather than assumed.
 */
export async function gradePicks(
  poolId: string,
  season: number,
  tieCountsAsLoss: boolean,
): Promise<number> {
  const picks = await prisma.pick.findMany({ where: { poolId, season, confirmed: true } });
  let updated = 0;
  for (const p of picks) {
    const game = p.gameId
      ? await prisma.game.findUnique({ where: { id: p.gameId } })
      : await prisma.game.findFirst({
          where: {
            season,
            week: p.week,
            OR: [{ homeTeamAbbr: p.teamAbbr }, { awayTeamAbbr: p.teamAbbr }],
          },
        });
    if (!game || !game.completed || game.homeScore == null || game.awayScore == null) continue;
    const isHome = game.homeTeamAbbr === p.teamAbbr;
    const mine = isHome ? game.homeScore : game.awayScore;
    const theirs = isHome ? game.awayScore : game.homeScore;
    const result = mine > theirs ? "WIN" : mine < theirs ? "LOSS" : tieCountsAsLoss ? "LOSS" : "TIE";
    if (result !== p.result) {
      await prisma.pick.update({ where: { id: p.id }, data: { result } });
      updated += 1;
    }
  }
  return updated;
}

export interface PoolExport {
  exportedAt: string;
  app: string;
  pool: { id: string; name: string; season: number; settings: PoolSettings };
  picks: PickRecord[];
  overrides: unknown[];
}

export async function exportPool(poolId: string): Promise<PoolExport> {
  const pool = await prisma.pool.findUniqueOrThrow({ where: { id: poolId } });
  const settings = parseSettings(pool.settingsJson, pool.season);
  const picks = await listPicks(poolId, pool.season);
  const overrides = await prisma.manualOverride.findMany({ where: { season: pool.season } });
  return {
    exportedAt: new Date().toISOString(),
    app: "nfl-survivor-optimizer",
    pool: { id: pool.id, name: pool.name, season: pool.season, settings },
    picks,
    overrides: overrides.map((o) => ({
      season: o.season,
      week: o.week,
      scope: o.scope,
      gameId: o.gameId,
      teamAbbr: o.teamAbbr,
      valueJson: o.valueJson,
      note: o.note,
      active: o.active,
    })),
  };
}

export async function importPool(payload: PoolExport, replace: boolean): Promise<{ picks: number }> {
  const pool = await getOrCreatePool(payload.pool?.season ?? DEFAULT_SETTINGS.season);
  if (payload.pool?.settings) {
    await updateSettings(pool.id, payload.pool.settings);
  }
  if (replace) {
    await prisma.pick.deleteMany({ where: { poolId: pool.id, season: pool.season } });
  }
  let count = 0;
  for (const p of payload.picks ?? []) {
    if (!p?.team || !p?.week) continue;
    await upsertPick({
      poolId: pool.id,
      season: p.season ?? pool.season,
      week: p.week,
      team: p.team,
      opponent: p.opponent ?? null,
      gameId: p.gameId ?? null,
      confirmed: p.confirmed ?? false,
      winProbAtPick: p.winProbAtPick ?? null,
      note: p.note ?? null,
    });
    count += 1;
  }
  return { picks: count };
}
