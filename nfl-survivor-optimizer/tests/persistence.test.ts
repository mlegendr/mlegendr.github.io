/**
 * Persistence tests run against a throwaway SQLite file (prisma/test.db) created
 * by tests/global-setup.ts, so they can never touch a real pool.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  deletePick,
  exportPool,
  getOrCreatePool,
  gradePicks,
  importPool,
  listPicks,
  updateSettings,
  upsertPick,
  usedTeams,
} from "@/lib/pool";
import { ensureTeams, persistGames } from "@/lib/refresh";
import { TEAM_ABBRS } from "@/lib/teams";
import type { CanonicalGame } from "@/lib/types";

const SEASON = 2026;

function game(week: number, home: string, away: string, scores?: [number, number]): CanonicalGame {
  return {
    id: `${SEASON}_${String(week).padStart(2, "0")}_${away}_${home}`,
    season: SEASON,
    week,
    seasonType: "REG",
    kickoff: `2026-09-${String(6 + week).padStart(2, "0")}T17:00:00.000Z`,
    homeTeam: home,
    awayTeam: away,
    neutralSite: false,
    stadium: null,
    roof: null,
    surface: null,
    divisionGame: false,
    homeRest: 7,
    awayRest: 7,
    homeScore: scores?.[0] ?? null,
    awayScore: scores?.[1] ?? null,
    completed: scores != null,
    overtime: false,
    refHomeMoneyline: null,
    refAwayMoneyline: null,
    refSpreadLine: null,
  };
}

async function reset() {
  await prisma.pick.deleteMany({});
  await prisma.oddsSnapshot.deleteMany({});
  await prisma.game.deleteMany({});
  await prisma.pool.deleteMany({});
}

beforeEach(async () => {
  await reset();
  await ensureTeams();
  await persistGames(
    [
      game(1, "KC", "DEN", [31, 17]),
      game(2, "BUF", "NYJ", [24, 10]),
      game(3, "PHI", "DAL"),
      game(4, "KC", "LV"),
    ],
    "test",
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("teams", () => {
  it("seeds all 32 franchises idempotently", async () => {
    await ensureTeams();
    await ensureTeams();
    expect(await prisma.team.count()).toBe(TEAM_ABBRS.length);
  });
});

describe("confirmed picks", () => {
  it("persists a confirmed pick and excludes the team", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({
      poolId: pool.id,
      season: SEASON,
      week: 1,
      team: "KC",
      opponent: "DEN",
      gameId: `${SEASON}_01_DEN_KC`,
      confirmed: true,
    });
    expect([...(await usedTeams(pool.id, SEASON))]).toEqual(["KC"]);
  });

  it("survives a simulated restart (fresh read from SQLite)", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({ poolId: pool.id, season: SEASON, week: 1, team: "KC", confirmed: true });
    await upsertPick({ poolId: pool.id, season: SEASON, week: 2, team: "BUF", confirmed: true });

    // Drop every in-process cache the way a server restart would.
    await prisma.$disconnect();
    await prisma.$connect();

    const reopened = await getOrCreatePool(SEASON);
    expect(reopened.id).toBe(pool.id);
    const used = await usedTeams(reopened.id, SEASON);
    expect([...used].sort()).toEqual(["BUF", "KC"]);
    expect((await listPicks(reopened.id, SEASON)).map((p) => p.week)).toEqual([1, 2]);
  });

  it("does NOT treat an unconfirmed pick as used", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({ poolId: pool.id, season: SEASON, week: 3, team: "PHI", confirmed: false });
    expect((await usedTeams(pool.id, SEASON)).size).toBe(0);
    expect(await listPicks(pool.id, SEASON)).toHaveLength(1);
  });

  it("keeps one pick per week (upsert, not duplicate)", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({ poolId: pool.id, season: SEASON, week: 1, team: "KC", confirmed: true });
    await upsertPick({ poolId: pool.id, season: SEASON, week: 1, team: "DEN", confirmed: true });
    const picks = await listPicks(pool.id, SEASON);
    expect(picks).toHaveLength(1);
    expect(picks[0].team).toBe("DEN");
    expect([...(await usedTeams(pool.id, SEASON))]).toEqual(["DEN"]);
  });

  it("frees the team again when a pick is removed", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({ poolId: pool.id, season: SEASON, week: 1, team: "KC", confirmed: true });
    await deletePick(pool.id, SEASON, 1);
    expect((await usedTeams(pool.id, SEASON)).size).toBe(0);
  });
});

describe("grading", () => {
  it("grades wins and losses from final scores", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({
      poolId: pool.id,
      season: SEASON,
      week: 1,
      team: "KC",
      gameId: `${SEASON}_01_DEN_KC`,
      confirmed: true,
    });
    await upsertPick({
      poolId: pool.id,
      season: SEASON,
      week: 2,
      team: "NYJ",
      gameId: `${SEASON}_02_NYJ_BUF`,
      confirmed: true,
    });
    await gradePicks(pool.id, SEASON, true);
    const picks = await listPicks(pool.id, SEASON);
    expect(picks.find((p) => p.week === 1)!.result).toBe("WIN");
    expect(picks.find((p) => p.week === 2)!.result).toBe("LOSS");
  });

  it("honours the tie rule from pool settings", async () => {
    await persistGames([game(5, "SF", "SEA", [20, 20])], "test");
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({
      poolId: pool.id,
      season: SEASON,
      week: 5,
      team: "SF",
      gameId: `${SEASON}_05_SEA_SF`,
      confirmed: true,
    });

    await gradePicks(pool.id, SEASON, true);
    expect((await listPicks(pool.id, SEASON)).find((p) => p.week === 5)!.result).toBe("LOSS");

    await gradePicks(pool.id, SEASON, false);
    expect((await listPicks(pool.id, SEASON)).find((p) => p.week === 5)!.result).toBe("TIE");
  });
});

describe("settings", () => {
  it("round-trips settings through the database", async () => {
    const pool = await getOrCreatePool(SEASON);
    const next = await updateSettings(pool.id, {
      tieCountsAsLoss: false,
      defaultHorizon: 9,
      currentWeekOverride: 7,
    });
    expect(next.tieCountsAsLoss).toBe(false);
    const reread = await getOrCreatePool(SEASON);
    expect(reread.settings.defaultHorizon).toBe(9);
    expect(reread.settings.currentWeekOverride).toBe(7);
    // Unset fields keep their defaults.
    expect(reread.settings.includePostseason).toBe(false);
  });
});

describe("export / import", () => {
  it("round-trips a pool through JSON", async () => {
    const pool = await getOrCreatePool(SEASON);
    await upsertPick({ poolId: pool.id, season: SEASON, week: 1, team: "KC", confirmed: true });
    await upsertPick({ poolId: pool.id, season: SEASON, week: 2, team: "BUF", confirmed: true });
    const dump = await exportPool(pool.id);
    expect(dump.picks).toHaveLength(2);

    await prisma.pick.deleteMany({});
    expect((await usedTeams(pool.id, SEASON)).size).toBe(0);

    const result = await importPool(JSON.parse(JSON.stringify(dump)), true);
    expect(result.picks).toBe(2);
    expect([...(await usedTeams(pool.id, SEASON))].sort()).toEqual(["BUF", "KC"]);
  });
});
