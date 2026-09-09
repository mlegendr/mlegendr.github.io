/**
 * §9/§10/§33 — behaviour learning: shrinkage, cold start, and no look-ahead.
 */

import { describe, expect, it } from "vitest";
import {
  COLD_START_COEFFICIENTS,
  buildBehaviorModel,
  coefficientsFor,
  fitCoefficients,
  sampleFromDistribution,
  shrinkToward,
  softmax,
  type Observation,
} from "@/lib/gametheory/opponentModel";
import { reconstructObservations, summariseEntryBehavior } from "@/lib/gametheory/context";
import { DEFAULT_GAME_THEORY_SETTINGS, type ChoiceFeatures } from "@/lib/gametheory/types";
import { entryState, matchup } from "./gt-fixtures";

const TEAMS = ["BUF", "DAL", "KC", "PHI", "NYJ", "NYG", "ARI", "LV"];

function feat(win: number, safety: number, extra: Partial<ChoiceFeatures> = {}): ChoiceFeatures {
  return {
    winProbability: win,
    safetyRank: safety,
    futureValueCost: 0,
    scheduleScarcity: 0,
    publicPopularity: 0,
    isHome: 0,
    ...extra,
  };
}

/** A pool that always takes the safest option. */
function chalkObservations(entryId: string, count: number): Observation[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId,
    week: i + 1,
    options: [
      { team: "BUF", features: feat(0.85, 1) },
      { team: "DAL", features: feat(0.7, 0.5) },
      { team: "KC", features: feat(0.6, 0) },
    ],
    chosen: "BUF",
  }));
}

describe("softmax", () => {
  it("normalises to one and is monotone in utility", () => {
    const p = softmax([3, 1, 0], 1);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
  });

  it("flattens as temperature rises and sharpens as it falls", () => {
    const hot = softmax([3, 1, 0], 5);
    const cold = softmax([3, 1, 0], 0.3);
    expect(cold[0]).toBeGreaterThan(hot[0]);
    expect(hot[2]).toBeGreaterThan(cold[2]);
  });

  it("never assigns zero to a legal option", () => {
    for (const p of softmax([10, -10], 1)) expect(p).toBeGreaterThan(0);
  });

  it("survives extreme utilities without overflow", () => {
    const p = softmax([1e6, -1e6], 1);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(Number.isFinite(p[0])).toBe(true);
  });
});

describe("fitting", () => {
  it("learns to favour win probability from chalk history", () => {
    const fitted = fitCoefficients(chalkObservations("a", 30), { temperature: 1 });
    expect(fitted.winProbability).toBeGreaterThan(COLD_START_COEFFICIENTS.winProbability * 0.5);
    const p = softmax(
      [
        fitted.winProbability * 0.85 + fitted.safetyRank * 1,
        fitted.winProbability * 0.6 + fitted.safetyRank * 0,
      ],
      1,
    );
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it("returns the prior unchanged with no observations", () => {
    expect(fitCoefficients([], {})).toEqual(COLD_START_COEFFICIENTS);
  });
});

describe("hierarchical shrinkage", () => {
  it("keeps a 3-observation entry close to the pool model", () => {
    const pool = COLD_START_COEFFICIENTS;
    const wild = { ...pool, winProbability: 40 };
    const { coefficients, weight } = shrinkToward(wild, pool, 3, 6);
    expect(weight).toBeCloseTo(3 / 9, 10);
    // Well under halfway to the entry's own wild estimate.
    expect(coefficients.winProbability).toBeLessThan(
      pool.winProbability + (40 - pool.winProbability) * 0.4,
    );
  });

  it("lets an entry deviate more as observations accumulate", () => {
    const pool = COLD_START_COEFFICIENTS;
    const wild = { ...pool, winProbability: 40 };
    const few = shrinkToward(wild, pool, 3, 6);
    const many = shrinkToward(wild, pool, 60, 6);
    expect(many.weight).toBeGreaterThan(few.weight);
    expect(many.coefficients.winProbability).toBeGreaterThan(few.coefficients.winProbability);
  });

  it("falls back to the pool model for an entry with no history", () => {
    const model = buildBehaviorModel(chalkObservations("a", 10), DEFAULT_GAME_THEORY_SETTINGS);
    expect(coefficientsFor(model, "never-seen")).toEqual(model.poolCoefficients);
  });

  it("reports effective sample size and confidence", () => {
    const model = buildBehaviorModel(chalkObservations("a", 3), DEFAULT_GAME_THEORY_SETTINGS);
    expect(model.observations).toBe(3);
    expect(model.entryObservations.a).toBe(3);
    expect(model.confidence).toBe("LOW");
    expect(model.entryShrinkage.a).toBeLessThan(0.4);
  });
});

describe("cold start", () => {
  it("uses priors and says so when there is no history", () => {
    const model = buildBehaviorModel([], DEFAULT_GAME_THEORY_SETTINGS);
    expect(model.isColdStart).toBe(true);
    expect(model.confidence).toBe("NONE");
    expect(model.poolCoefficients).toEqual(COLD_START_COEFFICIENTS);
    expect(model.fitNote).toContain("cold-start");
  });

  it("honours POOL_AVERAGE mode by disabling entry deviations", () => {
    const model = buildBehaviorModel(chalkObservations("a", 20), {
      ...DEFAULT_GAME_THEORY_SETTINGS,
      behaviorMode: "POOL_AVERAGE",
    });
    expect(Object.keys(model.entryCoefficients)).toHaveLength(0);
    expect(coefficientsFor(model, "a")).toEqual(model.poolCoefficients);
  });
});

describe("no look-ahead in historical reconstruction (§33)", () => {
  it("offers only teams the entry had not yet used at that time", () => {
    const state = entryState("a", "A", false, [], TEAMS);
    state.picks = [
      { id: "1", poolEntryId: "a", season: 2026, week: 1, team: "BUF", gameId: null, pickSource: "CSV_IMPORT", pickStatus: "WIN", isKnown: true },
      { id: "2", poolEntryId: "a", season: 2026, week: 2, team: "DAL", gameId: null, pickSource: "CSV_IMPORT", pickStatus: "WIN", isKnown: true },
    ];
    const snapshots = [
      { week: 1, probabilities: [...matchup(1, "BUF", "NYJ", 0.8), ...matchup(1, "DAL", "NYG", 0.75)] },
      { week: 2, probabilities: [...matchup(2, "BUF", "ARI", 0.8), ...matchup(2, "DAL", "LV", 0.75)] },
    ];
    const obs = reconstructObservations(
      [state],
      snapshots,
      DEFAULT_GAME_THEORY_SETTINGS,
      new Map(),
      new Map(),
    );
    expect(obs).toHaveLength(2);

    const week1 = obs.find((o) => o.week === 1)!;
    expect(week1.options.map((o) => o.team).sort()).toEqual(["BUF", "DAL", "NYG", "NYJ"]);

    // By week 2 the entry has spent BUF, so BUF must not be an option.
    const week2 = obs.find((o) => o.week === 2)!;
    expect(week2.options.map((o) => o.team)).not.toContain("BUF");
    expect(week2.chosen).toBe("DAL");
  });

  it("uses only that week's own pre-kickoff probabilities", () => {
    const state = entryState("a", "A", false, [], TEAMS);
    state.picks = [
      { id: "1", poolEntryId: "a", season: 2026, week: 1, team: "DAL", gameId: null, pickSource: "CSV_IMPORT", pickStatus: "LOSS", isKnown: true },
    ];
    const obs = reconstructObservations(
      [state],
      [{ week: 1, probabilities: [...matchup(1, "BUF", "NYJ", 0.8), ...matchup(1, "DAL", "NYG", 0.75)] }],
      DEFAULT_GAME_THEORY_SETTINGS,
      new Map(),
      new Map(),
    );
    const dal = obs[0].options.find((o) => o.team === "DAL")!;
    // The pick lost, but the feature must still be the PRE-game probability.
    expect(dal.features.winProbability).toBeCloseTo(0.75, 10);
  });

  it("skips a week whose history is internally inconsistent rather than training on it", () => {
    const state = entryState("a", "A", false, [], TEAMS);
    state.picks = [
      { id: "1", poolEntryId: "a", season: 2026, week: 1, team: "BUF", gameId: null, pickSource: "CSV_IMPORT", pickStatus: "WIN", isKnown: true },
      { id: "2", poolEntryId: "a", season: 2026, week: 2, team: "BUF", gameId: null, pickSource: "CSV_IMPORT", pickStatus: "WIN", isKnown: true },
    ];
    const obs = reconstructObservations(
      [state],
      [
        { week: 1, probabilities: [...matchup(1, "BUF", "NYJ", 0.8), ...matchup(1, "DAL", "NYG", 0.75)] },
        { week: 2, probabilities: [...matchup(2, "BUF", "ARI", 0.8), ...matchup(2, "DAL", "LV", 0.75)] },
      ],
      DEFAULT_GAME_THEORY_SETTINGS,
      new Map(),
      new Map(),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].week).toBe(1);
  });
});

describe("entry behaviour summary", () => {
  it("describes tendency statistically, without psychological labels", () => {
    const summary = summariseEntryBehavior("a", chalkObservations("a", 3), 0.33);
    expect(summary.decisions).toHaveLength(3);
    expect(summary.decisions[0].safetyRankPosition).toBe(1);
    expect(summary.meanSafetyPercentile).toBeCloseTo(1, 10);
    expect(summary.observedTendency).toMatch(/safest options/i);
    expect(summary.confidence).toBe("LOW");
    for (const banned of ["aggressive", "irrational", "contrarian", "psychology"]) {
      expect(summary.observedTendency.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("sampling", () => {
  it("respects the distribution's cumulative mass", () => {
    const d = { BUF: 0.5, DAL: 0.3, KC: 0.2 };
    expect(sampleFromDistribution(d, 0.1)).toBe("BUF");
    expect(sampleFromDistribution(d, 0.6)).toBe("DAL");
    expect(sampleFromDistribution(d, 0.9)).toBe("KC");
    expect(sampleFromDistribution(d, 0.999999)).toBe("KC");
  });
});
