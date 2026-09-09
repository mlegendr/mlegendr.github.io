/** §32 — entry inventories are independent, and hard constraints always win. */

import { describe, expect, it } from "vitest";
import { runTournament, type TournamentTrace } from "@/lib/gametheory/tournament";
import { entryPickDistribution, COLD_START_COEFFICIENTS } from "@/lib/gametheory/opponentModel";
import { buildSlotIndex } from "@/lib/optimizer/survivor";
import { computeInventoryEdges, projectOwnership } from "@/lib/gametheory/inventory";
import { DEFAULT_GAME_THEORY_SETTINGS, type BehaviorModel } from "@/lib/gametheory/types";
import { certain, entryState, matchup } from "./gt-fixtures";

const TEAMS = ["BUF", "DAL", "KC", "PHI", "SF", "BAL", "NYJ", "NYG", "WAS", "CAR", "ARI", "LV"];

const board = [
  ...matchup(1, "BUF", "NYJ", 0.8),
  ...matchup(1, "DAL", "NYG", 0.75),
  ...matchup(1, "KC", "ARI", 0.7),
  ...matchup(2, "PHI", "LV", 0.72),
  ...matchup(2, "SF", "CAR", 0.7),
  ...matchup(2, "BAL", "WAS", 0.68),
];

const model: BehaviorModel = {
  poolCoefficients: COLD_START_COEFFICIENTS,
  entryCoefficients: {},
  temperature: 1,
  observations: 0,
  entryObservations: {},
  entryShrinkage: {},
  confidence: "NONE",
  isColdStart: true,
  fitNote: "test",
};

function ctxFor(probabilities = board) {
  const index = buildSlotIndex(probabilities);
  return {
    byWeek: index.byWeek,
    futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
    scheduleScarcity: new Map(TEAMS.map((t) => [t, 0])),
    publicPopularity: {},
  };
}

describe("opponent pick distributions", () => {
  it("never offers a team the entry has already used", () => {
    const state = entryState("a", "Entry A", false, ["BUF", "DAL"], TEAMS);
    const d = entryPickDistribution({
      state,
      week: 1,
      ctx: ctxFor(),
      model,
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      isLegal: () => true,
    });
    expect(d.distribution.BUF).toBeUndefined();
    expect(d.distribution.DAL).toBeUndefined();
    expect(Object.keys(d.distribution).length).toBeGreaterThan(0);
  });

  it("always normalises to exactly 1", () => {
    for (const used of [[], ["BUF"], ["BUF", "DAL", "KC"]]) {
      const d = entryPickDistribution({
        state: entryState("a", "A", false, used, TEAMS),
        week: 1,
        ctx: ctxFor(),
        model,
        settings: DEFAULT_GAME_THEORY_SETTINGS,
        isLegal: () => true,
      });
      const total = Object.values(d.distribution).reduce((x, y) => x + y, 0);
      expect(total).toBeCloseTo(1, 10);
      for (const p of Object.values(d.distribution)) {
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("cannot select a team on bye", () => {
    // Week 2 has no BUF game in this board, so BUF is on bye.
    const d = entryPickDistribution({
      state: entryState("a", "A", false, [], TEAMS),
      week: 2,
      ctx: ctxFor(),
      model,
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      isLegal: () => true,
    });
    expect(d.distribution.BUF).toBeUndefined();
    expect(d.legalTeams).not.toContain("BUF");
  });

  it("respects the kickoff gate", () => {
    const d = entryPickDistribution({
      state: entryState("a", "A", false, [], TEAMS),
      week: 1,
      ctx: ctxFor(),
      model,
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      isLegal: (team) => team !== "BUF",
    });
    expect(d.distribution.BUF).toBeUndefined();
  });

  it("a known current pick overrides the predicted distribution", () => {
    const d = entryPickDistribution({
      state: entryState("a", "A", false, [], TEAMS, { knownCurrentPick: "KC" }),
      week: 1,
      ctx: ctxFor(),
      model,
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      isLegal: () => true,
    });
    expect(d.isKnown).toBe(true);
    expect(d.distribution).toEqual({ KC: 1 });
  });

  it("does not zero out every non-optimal option", () => {
    const d = entryPickDistribution({
      state: entryState("a", "A", false, [], TEAMS),
      week: 1,
      ctx: ctxFor(),
      model,
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      isLegal: () => true,
    });
    // The safest team leads, but weaker options keep real probability mass.
    const entries = Object.entries(d.distribution).sort((a, b) => b[1] - a[1]);
    expect(entries[0][0]).toBe("BUF");
    expect(entries[1][1]).toBeGreaterThan(0.01);
  });
});

describe("independent inventories", () => {
  it("different entries keep separate used-team histories", () => {
    const a = entryState("a", "A", false, ["BUF"], TEAMS);
    const b = entryState("b", "B", false, ["DAL"], TEAMS);
    expect(a.remainingTeams).toContain("DAL");
    expect(a.remainingTeams).not.toContain("BUF");
    expect(b.remainingTeams).toContain("BUF");
    expect(b.remainingTeams).not.toContain("DAL");
  });

  it("two entries owned by the same human never share inventory", () => {
    const one = entryState("a1", "Alice Entry 1", false, ["BUF"], TEAMS, { owner: "Alice" });
    const two = entryState("a2", "Alice Entry 2", false, ["KC"], TEAMS, { owner: "Alice" });
    expect(one.entry.ownerName).toBe("Alice");
    expect(two.entry.ownerName).toBe("Alice");
    expect(one.usedTeams).toEqual(["BUF"]);
    expect(two.usedTeams).toEqual(["KC"]);
    expect(one.remainingTeams).toContain("KC");
    expect(two.remainingTeams).toContain("BUF");
  });

  it("computes opponent access rate from active opposing entries only", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, ["BUF"], TEAMS),
      entryState("b", "B", false, ["BUF"], TEAMS),
      entryState("c", "C", false, [], TEAMS),
      entryState("d", "D", false, ["BUF"], TEAMS, { status: "ELIMINATED" }),
    ];
    const edges = computeInventoryEdges(states, states[0]);
    const buf = edges.find((e) => e.team === "BUF")!;
    // Three active opponents; one of them still has BUF.
    expect(buf.activeOpponents).toBe(3);
    expect(buf.opponentsWithTeam).toBe(1);
    expect(buf.opponentAccessRate).toBeCloseTo(1 / 3, 10);
    expect(buf.userHasTeam).toBe(true);
    expect(buf.inventoryAdvantage).toBeCloseTo(2 / 3, 10);
    expect(buf.scarcity).toBe("SCARCE");
  });

  it("marks a team no active opponent can use as EXCLUSIVE", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, ["KC"], TEAMS),
      entryState("b", "B", false, ["KC"], TEAMS),
    ];
    const kc = computeInventoryEdges(states, states[0]).find((e) => e.team === "KC")!;
    expect(kc.opponentAccessRate).toBe(0);
    expect(kc.scarcity).toBe("EXCLUSIVE");
  });
});

describe("projected ownership", () => {
  it("aggregates per-entry distributions into expected entries", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, [], TEAMS),
      entryState("b", "B", false, [], TEAMS),
    ];
    const rows = projectOwnership(
      [certain("a", "A", "BUF"), certain("b", "B", "BUF")],
      states,
    );
    const buf = rows.find((r) => r.team === "BUF")!;
    expect(buf.expectedEntries).toBeCloseTo(2, 10);
    expect(buf.share).toBeCloseTo(1, 10);
  });

  it("excludes eliminated entries from the denominator", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, [], TEAMS),
      entryState("dead", "Dead", false, [], TEAMS, { status: "ELIMINATED" }),
    ];
    const rows = projectOwnership([certain("a", "A", "BUF")], states);
    const buf = rows.find((r) => r.team === "BUF")!;
    expect(buf.share).toBeCloseTo(1, 10); // 1 of 1 active opponent, not 1 of 2
  });
});

describe("inventories inside the tournament", () => {
  it("no entry ever reuses a team across simulated weeks", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, [], TEAMS),
      entryState("b", "B", false, [], TEAMS),
    ];
    const trace: TournamentTrace = { maxSims: 300, records: [] };
    runTournament({
      currentWeek: 1,
      weeks: [1, 2],
      probabilities: board,
      states,
      currentDistributions: [
        { entryId: "a", entryName: "A", distribution: { BUF: 0.5, DAL: 0.5 }, isKnown: false, legalTeams: ["BUF", "DAL"] },
        { entryId: "b", entryName: "B", distribution: { BUF: 0.5, KC: 0.5 }, isKnown: false, legalTeams: ["BUF", "KC"] },
      ],
      futureDistributions: new Map([
        ["a", new Map([[2, { PHI: 0.34, SF: 0.33, BAL: 0.33 }]])],
        ["b", new Map([[2, { PHI: 0.34, SF: 0.33, BAL: 0.33 }]])],
      ]),
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      candidates: ["BUF"],
      futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
      projectedOwnership: new Map(),
      isPickable: () => true,
      simulations: 300,
      seed: 2468,
      trace,
    });

    const bySim = new Map<number, Map<string, string[]>>();
    for (const rec of trace.records) {
      const perEntry = bySim.get(rec.sim) ?? new Map<string, string[]>();
      for (const [entryId, team] of Object.entries(rec.picks)) {
        const list = perEntry.get(entryId) ?? [];
        list.push(team);
        perEntry.set(entryId, list);
      }
      bySim.set(rec.sim, perEntry);
    }
    expect(bySim.size).toBeGreaterThan(50);
    for (const perEntry of bySim.values()) {
      for (const picks of perEntry.values()) {
        expect(new Set(picks).size).toBe(picks.length);
      }
    }
  });

  it("eliminated entries never appear in later simulated weeks", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("doomed", "Doomed", false, [], TEAMS),
    ];
    const probabilities = [
      ...matchup(1, "BUF", "NYJ", 0.999999),
      ...matchup(1, "DAL", "NYG", 0.000001),
      ...matchup(2, "KC", "ARI", 0.7),
      ...matchup(2, "PHI", "LV", 0.7),
    ];
    const trace: TournamentTrace = { maxSims: 200, records: [] };
    runTournament({
      currentWeek: 1,
      weeks: [1, 2],
      probabilities,
      states,
      currentDistributions: [certain("doomed", "Doomed", "DAL")],
      futureDistributions: new Map([["doomed", new Map([[2, { KC: 1 }]])]]),
      settings: { ...DEFAULT_GAME_THEORY_SETTINGS, rules: { ...DEFAULT_GAME_THEORY_SETTINGS.rules, tieProbability: 0 } },
      candidates: ["BUF"],
      futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
      projectedOwnership: new Map(),
      isPickable: () => true,
      simulations: 200,
      seed: 13579,
      trace,
    });
    const week2 = trace.records.filter((r) => r.week === 2);
    expect(week2.length).toBeGreaterThan(50);
    for (const rec of week2) {
      // DAL loses essentially always, so "Doomed" must be gone by week 2.
      expect(rec.picks.doomed).toBeUndefined();
    }
  });

  it("a known current pick is used verbatim in the simulation", () => {
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("a", "A", false, [], TEAMS, { knownCurrentPick: "KC" }),
    ];
    const trace: TournamentTrace = { maxSims: 100, records: [] };
    runTournament({
      currentWeek: 1,
      weeks: [1],
      probabilities: board,
      states,
      // Deliberately contradictory prediction: the known pick must win.
      currentDistributions: [certain("a", "A", "BUF")],
      futureDistributions: new Map(),
      settings: DEFAULT_GAME_THEORY_SETTINGS,
      candidates: ["DAL"],
      futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
      projectedOwnership: new Map(),
      isPickable: () => true,
      simulations: 100,
      seed: 999,
      trace,
    });
    for (const rec of trace.records.filter((r) => r.week === 1)) {
      expect(rec.picks.a).toBe("KC");
    }
  });
});
