/**
 * End-to-end rules test against a synthetic season in the throwaway database.
 * OFFLINE_MODE is set for the whole suite, so no provider is contacted.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { buildAnalysis } from "@/lib/engine";
import { ensureTeams, persistGames } from "@/lib/refresh";
import { getOrCreatePool, updateSettings, upsertPick } from "@/lib/pool";
import { TEAM_ABBRS } from "@/lib/teams";
import type { CanonicalGame } from "@/lib/types";

const SEASON = 2026;
const WEEKS = [1, 2, 3, 4];

/** Round-robin-ish schedule: every team plays every week except one bye pair in week 3. */
function buildSeason(): CanonicalGame[] {
  const games: CanonicalGame[] = [];
  for (const week of WEEKS) {
    const rotated = [...TEAM_ABBRS.slice(week - 1), ...TEAM_ABBRS.slice(0, week - 1)];
    for (let i = 0; i < rotated.length; i += 2) {
      const home = rotated[i];
      const away = rotated[i + 1];
      // Week 3: give the first pair a bye by simply not scheduling their game.
      if (week === 3 && i === 0) continue;
      games.push({
        id: `${SEASON}_${String(week).padStart(2, "0")}_${away}_${home}`,
        season: SEASON,
        week,
        seasonType: "REG",
        // Week 1 kicks off in the past so "already started" is exercised.
        kickoff:
          week === 1
            ? "2026-09-01T17:00:00.000Z"
            : new Date(Date.UTC(2026, 8, 6) + (week - 1) * 7 * 86_400_000).toISOString(),
        homeTeam: home,
        awayTeam: away,
        neutralSite: false,
        stadium: null,
        roof: "dome",
        surface: null,
        divisionGame: false,
        homeRest: 7,
        awayRest: 7,
        homeScore: null,
        awayScore: null,
        completed: false,
        overtime: false,
        refHomeMoneyline: -200,
        refAwayMoneyline: 170,
        refSpreadLine: 4,
      });
    }
  }
  return games;
}

const BYE_TEAMS = [TEAM_ABBRS[2], TEAM_ABBRS[3]]; // week-3 rotation puts these first

beforeEach(async () => {
  await prisma.pick.deleteMany({});
  await prisma.oddsSnapshot.deleteMany({});
  await prisma.game.deleteMany({});
  await prisma.pool.deleteMany({});
  await prisma.manualOverride.deleteMany({});
  await ensureTeams();
  await persistGames(buildSeason(), "test");
  const pool = await getOrCreatePool(SEASON);
  await updateSettings(pool.id, { currentWeekOverride: 2, totalRegularSeasonWeeks: 4 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("survivor rules, end to end", () => {
  it("recommends exactly one team and covers every remaining week", async () => {
    const a = await buildAnalysis({ season: SEASON });
    expect(a.recommendationWeek).toBe(2);
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(a.seasonPath.map((s) => s.week)).toEqual([2, 3, 4]);
    expect(new Set(a.seasonPath.map((s) => s.team)).size).toBe(3);
  });

  it("never recommends a previously used team", async () => {
    const pool = await getOrCreatePool(SEASON);
    const first = (await buildAnalysis({ season: SEASON })).candidates[0].team;
    await upsertPick({ poolId: pool.id, season: SEASON, week: 2, team: first, confirmed: true });

    const after = await buildAnalysis({ season: SEASON });
    expect(after.usedTeams).toContain(first);
    expect(after.teamsRemaining).toBe(31);
    expect(after.candidates.some((c) => c.team === first)).toBe(false);
    expect(after.seasonPath.some((s) => s.team === first)).toBe(false);
    expect(after.recommendationWeek).toBe(3);
    // ...and every remaining path still has one team per week, none repeated.
    expect(new Set(after.seasonPath.map((s) => s.team)).size).toBe(after.seasonPath.length);
  });

  it("never recommends a team on bye", async () => {
    const pool = await getOrCreatePool(SEASON);
    await updateSettings(pool.id, { currentWeekOverride: 3 });
    const a = await buildAnalysis({ season: SEASON });
    expect(a.recommendationWeek).toBe(3);
    for (const t of BYE_TEAMS) {
      expect(a.byeTeams).toContain(t);
      expect(a.candidates.some((c) => c.team === t)).toBe(false);
      const slot = a.slots.find((s) => s.week === 3 && s.team === t)!;
      expect(slot.available).toBe(false);
      expect(slot.reason).toBe("BYE");
    }
  });

  it("never recommends a team whose game has already kicked off", async () => {
    const pool = await getOrCreatePool(SEASON);
    await updateSettings(pool.id, { currentWeekOverride: 1 });
    const a = await buildAnalysis({ season: SEASON });
    expect(a.recommendationWeek).toBe(1);
    // Every week-1 game is in the past in this fixture.
    expect(a.candidates).toHaveLength(0);
    const started = a.slots.filter((s) => s.week === 1 && s.reason === "STARTED");
    expect(started.length).toBe(TEAM_ABBRS.length);
  });

  it("keeps a locked pick visible even after kickoff", async () => {
    const pool = await getOrCreatePool(SEASON);
    await updateSettings(pool.id, { currentWeekOverride: 1 });
    await upsertPick({
      poolId: pool.id,
      season: SEASON,
      week: 1,
      team: TEAM_ABBRS[0],
      confirmed: true,
    });
    const a = await buildAnalysis({ season: SEASON });
    const slot = a.slots.find((s) => s.week === 1 && s.team === TEAM_ABBRS[0])!;
    expect(slot.reason).toBe("LOCKED_PICK");
    expect(a.usedTeams).toContain(TEAM_ABBRS[0]);
  });

  it("keeps every probability inside (0,1) and both sides summing to one", async () => {
    const a = await buildAnalysis({ season: SEASON });
    const byGame = new Map<string, number[]>();
    for (const p of a.probabilities) {
      expect(p.finalProb).toBeGreaterThan(0);
      expect(p.finalProb).toBeLessThan(1);
      expect(p.modelProb).toBeGreaterThan(0);
      expect(p.modelProb).toBeLessThan(1);
      byGame.set(p.gameId, [...(byGame.get(p.gameId) ?? []), p.finalProb]);
    }
    for (const [, sides] of byGame) {
      expect(sides).toHaveLength(2);
      expect(sides[0] + sides[1]).toBeCloseTo(1, 9);
    }
  });

  it("exposes market, model and final probabilities separately", async () => {
    const a = await buildAnalysis({ season: SEASON });
    const c = a.candidates[0];
    expect(c.marketProb).not.toBeNull();
    expect(c.modelProb).toBeGreaterThan(0);
    expect(c.currentWinProb).toBeGreaterThan(0);
    // The blend must sit between its two inputs.
    const lo = Math.min(c.marketProb!, c.modelProb);
    const hi = Math.max(c.marketProb!, c.modelProb);
    expect(c.currentWinProb).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(c.currentWinProb).toBeLessThanOrEqual(hi + 1e-9);
  });

  it("applies a manual win-probability override and labels it", async () => {
    const before = await buildAnalysis({ season: SEASON });
    const team = before.candidates[0].team;
    await prisma.manualOverride.create({
      data: {
        season: SEASON,
        week: 2,
        scope: "WIN_PROBABILITY",
        teamAbbr: team,
        valueJson: JSON.stringify({ probability: 0.999 }),
        note: "test override",
      },
    });
    const after = await buildAnalysis({ season: SEASON });
    const overridden = after.probabilities.find((p) => p.week === 2 && p.team === team)!;
    expect(overridden.finalProb).toBeCloseTo(0.999, 6);
    expect(overridden.manualOverride).toBe(true);
    expect(after.candidates[0].team).toBe(team);
  });

  it("produces an explanation with facts, estimates and caveats", async () => {
    const a = await buildAnalysis({ season: SEASON });
    expect(a.explanation).not.toBeNull();
    expect(a.explanation!.why.length).toBeGreaterThan(2);
    expect(a.explanation!.caveats.length).toBeGreaterThan(0);
    expect(a.explanation!.why.some((f) => f.kind === "fact")).toBe(true);
    expect(a.explanation!.why.some((f) => f.kind === "estimate")).toBe(true);
  });

  it("reports every optimization horizon", async () => {
    const a = await buildAnalysis({ season: SEASON });
    for (const key of ["3", "6", "9", "season"]) {
      expect(a.bestByHorizon[key]).toBeDefined();
      expect(a.bestByHorizon[key].survival).toBeGreaterThan(0);
    }
  });

  it("flags degraded data when running without live providers", async () => {
    const a = await buildAnalysis({ season: SEASON });
    expect(a.providerAvailability.offline).toBe(true);
    expect(a.degraded).toBe(true);
  });
});
