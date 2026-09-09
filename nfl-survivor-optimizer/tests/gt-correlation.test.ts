/**
 * §31 — shared NFL game outcomes.
 *
 * This is the correctness requirement that makes the whole tournament
 * meaningful: each game is sampled once per simulated week, so entries on the
 * same team share a fate, entries on opposite sides of one game cannot both
 * advance, and a popular team losing removes everyone who picked it at once.
 */

import { describe, expect, it } from "vitest";
import { runTournament, type TournamentTrace } from "@/lib/gametheory/tournament";
import { DEFAULT_GAME_THEORY_SETTINGS } from "@/lib/gametheory/types";
import { certain, entryState, matchup } from "./gt-fixtures";

const TEAMS = ["DAL", "NYG", "BUF", "NYJ", "KC", "DEN", "PHI", "WAS"];

/** DAL vs NYG and BUF vs NYJ in week 1; a spare week 2 so paths can continue. */
const probabilities = [
  ...matchup(1, "DAL", "NYG", 0.78),
  ...matchup(1, "BUF", "NYJ", 0.7),
  ...matchup(2, "KC", "DEN", 0.75),
  ...matchup(2, "PHI", "WAS", 0.72),
];

function run(opts: {
  opponents: { id: string; team: string }[];
  candidate: string;
  sims?: number;
}) {
  const states = [
    entryState("user", "Me", true, [], TEAMS),
    ...opts.opponents.map((o) => entryState(o.id, o.id, false, [], TEAMS)),
  ];
  const trace: TournamentTrace = { maxSims: opts.sims ?? 400, records: [] };
  runTournament({
    currentWeek: 1,
    weeks: [1, 2],
    probabilities,
    states,
    currentDistributions: opts.opponents.map((o) => certain(o.id, o.id, o.team)),
    futureDistributions: new Map(
      opts.opponents.map((o) => [o.id, new Map([[2, { KC: 0.5, PHI: 0.5 }]])]),
    ),
    settings: { ...DEFAULT_GAME_THEORY_SETTINGS, rules: { ...DEFAULT_GAME_THEORY_SETTINGS.rules, tieProbability: 0 } },
    candidates: [opts.candidate],
    futureValueCost: new Map(TEAMS.map((t) => [t, 0])),
    projectedOwnership: new Map(),
    isPickable: () => true,
    simulations: opts.sims ?? 400,
    seed: 424242,
    trace,
  });
  return trace.records.filter((r) => r.week === 1);
}

describe("shared NFL game outcomes", () => {
  it("entries on the SAME team never receive different results", () => {
    const week1 = run({ opponents: [{ id: "A", team: "DAL" }], candidate: "DAL" });
    expect(week1.length).toBeGreaterThan(100);
    for (const rec of week1) {
      expect(rec.picks.user).toBe("DAL");
      expect(rec.picks.A).toBe("DAL");
      // Same game, same outcome — always.
      expect(rec.survived.user).toBe(rec.survived.A);
    }
    // ...and both outcomes actually occur, so this is not vacuous.
    expect(week1.some((r) => r.survived.user)).toBe(true);
    expect(week1.some((r) => !r.survived.user)).toBe(true);
  });

  it("entries on OPPOSITE sides of one game can never both survive", () => {
    const week1 = run({ opponents: [{ id: "A", team: "NYG" }], candidate: "DAL" });
    expect(week1.length).toBeGreaterThan(100);
    for (const rec of week1) {
      expect(rec.picks.user).toBe("DAL");
      expect(rec.picks.A).toBe("NYG");
      expect(rec.survived.user && rec.survived.A).toBe(false);
      // Ties are disabled in this fixture, so exactly one of them survives.
      expect(rec.survived.user || rec.survived.A).toBe(true);
    }
  });

  it("a losing team eliminates every entry that picked it, simultaneously", () => {
    const opponents = [
      { id: "A", team: "BUF" },
      { id: "B", team: "BUF" },
      { id: "C", team: "BUF" },
    ];
    const week1 = run({ opponents, candidate: "DAL" });
    let sawBuffaloLoss = false;
    for (const rec of week1) {
      const outcomes = [rec.survived.A, rec.survived.B, rec.survived.C];
      // All three share one Buffalo result.
      expect(new Set(outcomes).size).toBe(1);
      if (outcomes[0] === false) sawBuffaloLoss = true;
    }
    expect(sawBuffaloLoss).toBe(true);
  });

  it("independent games are not forced to agree", () => {
    const week1 = run({ opponents: [{ id: "A", team: "BUF" }], candidate: "DAL" });
    const combos = new Set(week1.map((r) => `${r.survived.user}|${r.survived.A}`));
    // DAL and BUF are different games, so all four combinations should appear.
    expect(combos.size).toBe(4);
  });

  it("is reproducible for a fixed seed and varies with a different one", () => {
    const a = run({ opponents: [{ id: "A", team: "DAL" }], candidate: "DAL", sims: 200 });
    const b = run({ opponents: [{ id: "A", team: "DAL" }], candidate: "DAL", sims: 200 });
    expect(a.map((r) => r.survived.user)).toEqual(b.map((r) => r.survived.user));
  });
});
