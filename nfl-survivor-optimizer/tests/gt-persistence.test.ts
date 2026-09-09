/**
 * Entry persistence against the throwaway test database.
 *
 * Also guards the non-negotiable requirement: the legacy `Pick` table (which
 * the survival optimizer reads) keeps working, and the user's PoolEntry is a
 * one-way projection of it.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ensureTeams, persistGames } from "@/lib/refresh";
import { getOrCreatePool, upsertPick, usedTeams } from "@/lib/pool";
import {
  ensureUserEntry,
  gradeEntries,
  loadEntryStates,
  setEntryPick,
  setEntryStatusOverride,
  syncUserEntryFromPicks,
  upsertEntry,
} from "@/lib/gametheory/entries";
import type { CanonicalGame } from "@/lib/types";

const SEASON = 2026;

function game(week: number, home: string, away: string, scores?: [number, number]): CanonicalGame {
  return {
    id: `${SEASON}_${String(week).padStart(2, "0")}_${away}_${home}`,
    season: SEASON,
    week,
    seasonType: "REG",
    kickoff: new Date(Date.UTC(2026, 8, 6) + (week - 1) * 7 * 86_400_000).toISOString(),
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
    refHomeMoneyline: -200,
    refAwayMoneyline: 170,
    refSpreadLine: 4,
  };
}

async function poolId() {
  return (await getOrCreatePool(SEASON)).id;
}

beforeEach(async () => {
  await prisma.entryPick.deleteMany({});
  await prisma.poolEntry.deleteMany({});
  await prisma.recommendationSnapshot.deleteMany({});
  await prisma.pick.deleteMany({});
  await prisma.game.deleteMany({});
  await prisma.pool.deleteMany({});
  await ensureTeams();
  await persistGames(
    [
      game(1, "BUF", "NYJ", [31, 17]),
      game(1, "DAL", "NYG", [10, 24]),
      game(2, "KC", "DEN", [28, 21]),
      game(2, "PHI", "WAS", [20, 20]),
      game(3, "SF", "ARI"),
    ],
    "test",
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("entry inventories", () => {
  it("persists entries and their independent inventories across a reconnect", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    const b = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry B" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "BUF" });
    await setEntryPick({ entryId: b.id, season: SEASON, week: 1, team: "KC" });

    await prisma.$disconnect();
    await prisma.$connect();

    const states = await loadEntryStates(pid, SEASON, 2);
    const sa = states.find((s) => s.entry.displayName === "Entry A")!;
    const sb = states.find((s) => s.entry.displayName === "Entry B")!;
    expect(sa.usedTeams).toEqual(["BUF"]);
    expect(sb.usedTeams).toEqual(["KC"]);
    expect(sa.remainingTeams).toContain("KC");
    expect(sb.remainingTeams).toContain("BUF");
    expect(sa.remainingTeams).toHaveLength(31);
  });

  it("keeps two entries owned by the same human completely separate", async () => {
    const pid = await poolId();
    const a1 = await upsertEntry({
      poolId: pid, season: SEASON, displayName: "Alice Entry 1", ownerName: "Alice",
    });
    const a2 = await upsertEntry({
      poolId: pid, season: SEASON, displayName: "Alice Entry 2", ownerName: "Alice",
    });
    await setEntryPick({ entryId: a1.id, season: SEASON, week: 1, team: "BUF" });
    await setEntryPick({ entryId: a2.id, season: SEASON, week: 1, team: "DAL" });

    const states = await loadEntryStates(pid, SEASON, 2);
    const one = states.find((s) => s.entry.displayName === "Alice Entry 1")!;
    const two = states.find((s) => s.entry.displayName === "Alice Entry 2")!;
    expect(one.entry.ownerName).toBe("Alice");
    expect(two.entry.ownerName).toBe("Alice");
    expect(one.usedTeams).toEqual(["BUF"]);
    expect(two.usedTeams).toEqual(["DAL"]);
    expect(one.remainingTeams).toContain("DAL");
  });

  it("treats the current week's pick as known, not yet spent", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "BUF" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 2, team: "KC" });

    const states = await loadEntryStates(pid, SEASON, 2);
    const sa = states.find((s) => s.entry.displayName === "Entry A")!;
    expect(sa.usedTeams).toEqual(["BUF"]);
    expect(sa.knownCurrentPick).toBe("KC");
  });
});

describe("automatic elimination", () => {
  it("eliminates on a loss and records the scoreline", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "DAL" }); // DAL lost 10-24
    const result = await gradeEntries(pid, SEASON, true);
    const entry = result.entries.find((e) => e.displayName === "Entry A")!;
    expect(entry.status).toBe("ELIMINATED");
    expect(entry.eliminatedWeek).toBe(1);
    expect(entry.eliminationReason).toContain("DAL");
    expect(entry.eliminationReason).toContain("NYG");
  });

  it("keeps a winner alive", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "BUF" });
    const result = await gradeEntries(pid, SEASON, true);
    expect(result.entries.find((e) => e.displayName === "Entry A")!.status).toBe("ACTIVE");
  });

  it("honours the tie rule in both directions", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 2, team: "PHI" }); // 20-20 tie

    let result = await gradeEntries(pid, SEASON, true);
    expect(result.entries.find((e) => e.displayName === "Entry A")!.status).toBe("ELIMINATED");

    result = await gradeEntries(pid, SEASON, false);
    expect(result.entries.find((e) => e.displayName === "Entry A")!.status).toBe("ACTIVE");
  });

  it("eliminates at the FIRST losing week", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "DAL" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 2, team: "KC" });
    const result = await gradeEntries(pid, SEASON, true);
    expect(result.entries.find((e) => e.displayName === "Entry A")!.eliminatedWeek).toBe(1);
  });

  it("respects a manual status override", async () => {
    const pid = await poolId();
    const a = await upsertEntry({ poolId: pid, season: SEASON, displayName: "Entry A" });
    await setEntryPick({ entryId: a.id, season: SEASON, week: 1, team: "DAL" });
    await setEntryStatusOverride(a.id, "ACTIVE", null, "Pool granted a mulligan");
    const result = await gradeEntries(pid, SEASON, true);
    const entry = result.entries.find((e) => e.displayName === "Entry A")!;
    expect(entry.status).toBe("ACTIVE");
    expect(entry.manualStatusOverride).toBe(true);
    expect(entry.eliminationReason).toBe("Pool granted a mulligan");
  });
});

describe("the user's entry mirrors the legacy Pick table", () => {
  it("projects confirmed picks without altering them", async () => {
    const pid = await poolId();
    await upsertPick({ poolId: pid, season: SEASON, week: 1, team: "BUF", confirmed: true, gameId: `${SEASON}_01_NYJ_BUF` });
    await upsertPick({ poolId: pid, season: SEASON, week: 2, team: "KC", confirmed: false });

    await syncUserEntryFromPicks(pid, SEASON);
    const entry = await ensureUserEntry(pid, SEASON);
    const picks = await prisma.entryPick.findMany({ where: { poolEntryId: entry.id } });

    // Only the CONFIRMED pick is mirrored; the survival optimizer's own rule.
    expect(picks.map((p) => p.teamAbbr)).toEqual(["BUF"]);
    // ...and the legacy table is untouched.
    expect([...(await usedTeams(pid, SEASON))]).toEqual(["BUF"]);
    expect(await prisma.pick.count()).toBe(2);
  });

  it("stays in step when the user's picks change", async () => {
    const pid = await poolId();
    await upsertPick({ poolId: pid, season: SEASON, week: 1, team: "BUF", confirmed: true });
    await syncUserEntryFromPicks(pid, SEASON);
    await upsertPick({ poolId: pid, season: SEASON, week: 1, team: "KC", confirmed: true });
    await syncUserEntryFromPicks(pid, SEASON);

    const entry = await ensureUserEntry(pid, SEASON);
    const picks = await prisma.entryPick.findMany({ where: { poolEntryId: entry.id } });
    expect(picks.map((p) => p.teamAbbr)).toEqual(["KC"]);
  });

  it("marks the user's entry as isUser and never duplicates it", async () => {
    const pid = await poolId();
    await ensureUserEntry(pid, SEASON);
    await ensureUserEntry(pid, SEASON);
    const rows = await prisma.poolEntry.findMany({ where: { poolId: pid, isUser: true } });
    expect(rows).toHaveLength(1);
  });
});
