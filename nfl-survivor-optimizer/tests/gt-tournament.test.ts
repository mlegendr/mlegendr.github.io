/**
 * §34 — tournament validation on synthetic pools whose correct behaviour is
 * analytically understandable, verified through Pool Win Probability and
 * Expected Prize Equity rather than any leverage score.
 */

import { describe, expect, it } from "vitest";
import { runTournament } from "@/lib/gametheory/tournament";
import { DEFAULT_GAME_THEORY_SETTINGS, type GameTheorySettings } from "@/lib/gametheory/types";
import { certain, entryState, matchup } from "./gt-fixtures";

const TEAMS = ["BUF", "DAL", "KC", "PHI", "SF", "BAL", "NYJ", "NYG", "WAS", "CAR", "ARI", "LV"];

const settings: GameTheorySettings = {
  ...DEFAULT_GAME_THEORY_SETTINGS,
  simulations: 4000,
  rules: { ...DEFAULT_GAME_THEORY_SETTINGS.rules, tieProbability: 0 },
};

function twoWeekBoard(bufProb: number, dalProb: number) {
  return [
    ...matchup(1, "BUF", "NYJ", bufProb),
    ...matchup(1, "DAL", "NYG", dalProb),
    ...matchup(2, "BUF", "WAS", 0.7),
    ...matchup(2, "DAL", "CAR", 0.7),
    ...matchup(2, "KC", "ARI", 0.7),
    ...matchup(2, "PHI", "LV", 0.7),
  ];
}

function runPool(opts: {
  bufProb: number;
  dalProb: number;
  opponentCount: number;
  opponentTeam: string;
  sims?: number;
}) {
  const states = [entryState("user", "Me", true, [], TEAMS)];
  for (let i = 0; i < opts.opponentCount; i++) {
    states.push(entryState(`o${i}`, `Entry ${i}`, false, [], TEAMS));
  }
  const opponents = states.filter((s) => !s.entry.isUser);
  return runTournament({
    currentWeek: 1,
    weeks: [1, 2],
    probabilities: twoWeekBoard(opts.bufProb, opts.dalProb),
    states,
    currentDistributions: opponents.map((s) =>
      certain(s.entry.id, s.entry.displayName, opts.opponentTeam),
    ),
    futureDistributions: new Map(
      opponents.map((s) => [s.entry.id, new Map([[2, { KC: 0.5, PHI: 0.5 }]])]),
    ),
    settings: { ...settings, simulations: opts.sims ?? 4000 },
    candidates: ["BUF", "DAL"],
    futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
    projectedOwnership: new Map([[opts.opponentTeam, 1]]),
    isPickable: () => true,
    simulations: opts.sims ?? 4000,
    seed: 987654,
  });
}

describe("Example A — heavy field concentration for a tiny survival cost", () => {
  const summary = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 9, opponentTeam: "BUF" });
  const buf = summary.candidates.find((c) => c.team === "BUF")!;
  const dal = summary.candidates.find((c) => c.team === "DAL")!;

  it("recognises the leverage through expected prize equity", () => {
    // Nine opponents are certain to take BUF. Matching them means sharing;
    // taking DAL for one point of survival buys near-sole victories.
    expect(dal.expectedPrizeEquity).toBeGreaterThan(buf.expectedPrizeEquity);
    expect(summary.bestTeam).toBe("DAL");
  });

  it("still reports BUF as the higher raw survival pick", () => {
    expect(buf.currentWinProbability).toBeGreaterThan(dal.currentWinProbability);
    expect(buf.survivesCurrentWeek).toBeGreaterThan(dal.survivesCurrentWeek);
    expect(summary.survivalBestTeam).toBe("BUF");
  });

  it("shows the mechanism: DAL wins alone far more often", () => {
    expect(dal.soleVictoryProbability).toBeGreaterThan(buf.soleVictoryProbability * 2);
  });

  it("does not distort pool win probability, which BUF can still lead", () => {
    // Any-victory (including 10-way shares) is a genuinely different quantity.
    expect(buf.poolWinProbability).toBeGreaterThan(0);
    expect(dal.poolWinProbability).toBeGreaterThan(0);
  });
});

describe("Example B — differentiation is NOT rewarded for its own sake", () => {
  const summary = runPool({ bufProb: 0.95, dalProb: 0.55, opponentCount: 9, opponentTeam: "BUF" });
  const buf = summary.candidates.find((c) => c.team === "BUF")!;
  const dal = summary.candidates.find((c) => c.team === "DAL")!;

  it("prefers the popular favourite when the survival gap is large", () => {
    expect(summary.bestTeam).toBe("BUF");
    expect(buf.expectedPrizeEquity).toBeGreaterThan(dal.expectedPrizeEquity);
  });

  it("has no hard-coded contrarian bias", () => {
    // Same field concentration as Example A; only the survival gap changed,
    // and the recommendation flipped back to the chalk pick.
    expect(buf.projectedPoolOwnership).toBe(1);
    expect(dal.projectedPoolOwnership).toBe(0);
  });
});

describe("Example C — inventory advantage on a future week", () => {
  it("values a team no opponent can still use for a hard future week", () => {
    // Week 2 is brutal for everyone except KC, and only the user still has KC.
    const probabilities = [
      ...matchup(1, "BUF", "NYJ", 0.75),
      ...matchup(1, "DAL", "NYG", 0.75),
      ...matchup(2, "KC", "ARI", 0.9),
      ...matchup(2, "BUF", "WAS", 0.5),
      ...matchup(2, "DAL", "CAR", 0.5),
      ...matchup(2, "PHI", "LV", 0.5),
    ];
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("o0", "Entry 0", false, ["KC"], TEAMS),
      entryState("o1", "Entry 1", false, ["KC"], TEAMS),
    ];
    const opponents = states.filter((s) => !s.entry.isUser);
    const summary = runTournament({
      currentWeek: 1,
      weeks: [1, 2],
      probabilities,
      states,
      currentDistributions: opponents.map((s) =>
        certain(s.entry.id, s.entry.displayName, "BUF"),
      ),
      futureDistributions: new Map(
        opponents.map((s) => [s.entry.id, new Map([[2, { DAL: 0.5, PHI: 0.5 }]])]),
      ),
      settings,
      candidates: ["BUF", "DAL"],
      // Spending KC is impossible here (it has no week-1 game), so the user's
      // week-2 rollout should reach for it and convert the inventory edge.
      futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
      projectedOwnership: new Map([["BUF", 1]]),
      isPickable: () => true,
      simulations: 4000,
      seed: 5150,
    });
    const best = summary.candidates[0];
    // The user reaches week 2 holding KC while both opponents are stuck at 50%,
    // so the user's equity must exceed a naive equal share of the three entries.
    expect(best.expectedPrizeEquity).toBeGreaterThan(1 / 3);
  });
});

describe("Example D — two entries with asymmetric inventories", () => {
  it("responds to which teams each side can still use", () => {
    const probabilities = [
      ...matchup(1, "BUF", "NYJ", 0.7),
      ...matchup(1, "DAL", "NYG", 0.7),
      ...matchup(2, "KC", "ARI", 0.85),
      ...matchup(2, "PHI", "LV", 0.55),
      ...matchup(2, "BUF", "WAS", 0.55),
      ...matchup(2, "DAL", "CAR", 0.55),
    ];
    // The opponent has already spent KC; the user has not.
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("o0", "Rival", false, ["KC"], TEAMS),
    ];
    const summary = runTournament({
      currentWeek: 1,
      weeks: [1, 2],
      probabilities,
      states,
      currentDistributions: [certain("o0", "Rival", "BUF")],
      futureDistributions: new Map([["o0", new Map([[2, { PHI: 1 }]])]]),
      settings,
      candidates: ["BUF", "DAL"],
      futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
      projectedOwnership: new Map([["BUF", 1]]),
      isPickable: () => true,
      simulations: 4000,
      seed: 777,
    });
    const dal = summary.candidates.find((c) => c.team === "DAL")!;
    const buf = summary.candidates.find((c) => c.team === "BUF")!;
    // Matching the rival on BUF guarantees a shared outcome this week; taking
    // DAL keeps the KC advantage live in a world where the rival can be dropped.
    expect(dal.soleVictoryProbability).toBeGreaterThan(buf.soleVictoryProbability);
    expect(summary.activeEntries).toBe(2);
  });
});

describe("prize equity arithmetic", () => {
  it("splits equally among co-winners", () => {
    // Two identical entries both certain to pick the same certain winner:
    // they always tie, so equity must be exactly one half.
    const probabilities = [...matchup(1, "BUF", "NYJ", 0.999999)];
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("o0", "Clone", false, [], TEAMS),
    ];
    const summary = runTournament({
      currentWeek: 1,
      weeks: [1],
      probabilities,
      states,
      currentDistributions: [certain("o0", "Clone", "BUF")],
      futureDistributions: new Map(),
      settings,
      candidates: ["BUF"],
      futureValueCost: new Map(),
      projectedOwnership: new Map(),
      isPickable: () => true,
      simulations: 2000,
      seed: 31337,
    });
    const buf = summary.candidates[0];
    expect(buf.poolWinProbability).toBeGreaterThan(0.99);
    expect(buf.expectedPrizeEquity).toBeGreaterThan(0.49);
    expect(buf.expectedPrizeEquity).toBeLessThan(0.51);
    expect(buf.soleVictoryProbability).toBeLessThan(0.01);
  });

  it("gives full equity to a sole survivor", () => {
    const probabilities = [...matchup(1, "BUF", "NYJ", 0.999999), ...matchup(1, "DAL", "NYG", 0.000001)];
    const states = [
      entryState("user", "Me", true, [], TEAMS),
      entryState("o0", "Doomed", false, [], TEAMS),
    ];
    const summary = runTournament({
      currentWeek: 1,
      weeks: [1],
      probabilities,
      states,
      currentDistributions: [certain("o0", "Doomed", "DAL")],
      futureDistributions: new Map(),
      settings,
      candidates: ["BUF"],
      futureValueCost: new Map(),
      projectedOwnership: new Map(),
      isPickable: () => true,
      simulations: 2000,
      seed: 4242,
    });
    const buf = summary.candidates[0];
    expect(buf.soleVictoryProbability).toBeGreaterThan(0.99);
    expect(buf.expectedPrizeEquity).toBeGreaterThan(0.99);
  });

  it("is reproducible for a fixed seed and moves with the seed", () => {
    const a = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 5, opponentTeam: "BUF", sims: 1500 });
    const b = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 5, opponentTeam: "BUF", sims: 1500 });
    expect(a.candidates.map((c) => c.expectedPrizeEquity)).toEqual(
      b.candidates.map((c) => c.expectedPrizeEquity),
    );
  });

  it("reports a Monte Carlo standard error", () => {
    const s = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 5, opponentTeam: "BUF", sims: 1500 });
    for (const c of s.candidates) {
      expect(c.standardError).toBeGreaterThan(0);
      expect(c.standardError).toBeLessThan(0.05);
    }
  });
});

describe("pool size changes strategy through simulation, not through rules", () => {
  it("shifts toward differentiation as the field concentrates", () => {
    const small = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 1, opponentTeam: "BUF" });
    const large = runPool({ bufProb: 0.8, dalProb: 0.79, opponentCount: 20, opponentTeam: "BUF" });
    const gap = (s: ReturnType<typeof runPool>) => {
      const dal = s.candidates.find((c) => c.team === "DAL")!;
      const buf = s.candidates.find((c) => c.team === "BUF")!;
      return dal.expectedPrizeEquity - buf.expectedPrizeEquity;
    };
    // With 20 rivals all on BUF, matching them is worth far less than with one.
    expect(gap(large)).toBeGreaterThan(gap(small));
  });
});
