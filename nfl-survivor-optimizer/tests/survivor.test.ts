import { describe, expect, it } from "vitest";
import {
  buildSlotIndex,
  evaluateCandidates,
  horizonWeeks,
  optimizePath,
} from "@/lib/optimizer/survivor";
import { matchup } from "./fixtures";

describe("survivor path optimiser", () => {
  it("prefers the slightly less safe team now when that preserves a strong future", () => {
    // Week 1: A is 88%, B is 84%.
    // Week 2: A is 92% against a terrible opponent, B is only 60%.
    // Taking A now forces B (60%) in week 2  -> 0.88 * 0.60 = 0.528
    // Taking B now leaves A (92%) for week 2 -> 0.84 * 0.92 = 0.773
    const probabilities = [
      ...matchup(1, "A", "X", 0.88),
      ...matchup(1, "B", "Y", 0.84),
      ...matchup(2, "A", "Z", 0.92),
      ...matchup(2, "B", "W", 0.6),
    ];
    const index = buildSlotIndex(probabilities);
    const { candidates } = evaluateCandidates({
      index,
      currentWeek: 1,
      remainingWeeks: [1, 2],
      availableTeams: new Set(["A", "B"]),
      usedTeams: new Set(),
      candidates: ["A", "B"],
      horizons: ["3", "6", "9", "season"],
      defaultHorizon: "season",
    });

    expect(candidates[0].team).toBe("B");
    expect(candidates[0].pathSurvival["season"]).toBeCloseTo(0.84 * 0.92, 10);
    const a = candidates.find((c) => c.team === "A")!;
    expect(a.pathSurvival["season"]).toBeCloseTo(0.88 * 0.6, 10);
    // ...and it is honest that B is the less safe pick this week.
    expect(candidates[0].probability.finalProb).toBeLessThan(a.probability.finalProb);
  });

  it("takes the safest team now when doing so really is optimal", () => {
    // Now A is better this week AND B is better next week: no conflict.
    const probabilities = [
      ...matchup(1, "A", "X", 0.9),
      ...matchup(1, "B", "Y", 0.7),
      ...matchup(2, "A", "Z", 0.55),
      ...matchup(2, "B", "W", 0.9),
    ];
    const index = buildSlotIndex(probabilities);
    const { candidates } = evaluateCandidates({
      index,
      currentWeek: 1,
      remainingWeeks: [1, 2],
      availableTeams: new Set(["A", "B"]),
      usedTeams: new Set(),
      candidates: ["A", "B"],
      horizons: ["season"],
      defaultHorizon: "season",
    });
    expect(candidates[0].team).toBe("A");
    expect(candidates[0].pathSurvival["season"]).toBeCloseTo(0.9 * 0.9, 10);
  });

  it("charges a future-value cost for burning a team the path wanted later", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.88),
      ...matchup(1, "B", "Y", 0.84),
      ...matchup(2, "A", "Z", 0.92),
      ...matchup(2, "B", "W", 0.6),
    ];
    const index = buildSlotIndex(probabilities);
    const { candidates } = evaluateCandidates({
      index,
      currentWeek: 1,
      remainingWeeks: [1, 2],
      availableTeams: new Set(["A", "B"]),
      usedTeams: new Set(),
      candidates: ["A", "B"],
      horizons: ["season"],
      defaultHorizon: "season",
    });
    const best = candidates.find((c) => c.team === "B")!;
    const costly = candidates.find((c) => c.team === "A")!;
    expect(best.futureValueCost).toBeCloseTo(0, 10);
    expect(costly.futureValueCost).toBeGreaterThan(0.3);
  });

  it("never uses the same team twice in a path", () => {
    const probabilities = [];
    for (let w = 1; w <= 6; w++) {
      probabilities.push(...matchup(w, "A", "X", 0.9));
      probabilities.push(...matchup(w, "B", "Y", 0.85));
      probabilities.push(...matchup(w, "C", "Z", 0.8));
      probabilities.push(...matchup(w, "D", "W", 0.75));
      probabilities.push(...matchup(w, "E", "V", 0.7));
      probabilities.push(...matchup(w, "F", "U", 0.65));
    }
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2, 3, 4, 5, 6],
      availableTeams: new Set(["A", "B", "C", "D", "E", "F"]),
    });
    expect(res.feasible).toBe(true);
    expect(res.steps).toHaveLength(6);
    expect(new Set(res.steps.map((s) => s.team)).size).toBe(6);
  });

  it("excludes already-used teams entirely", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.95),
      ...matchup(1, "B", "Y", 0.6),
      ...matchup(2, "A", "Z", 0.95),
      ...matchup(2, "B", "W", 0.6),
    ];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2],
      availableTeams: new Set(["A", "B", "X", "Y", "Z", "W"]),
      excludedTeams: new Set(["A"]),
    });
    expect(res.steps.some((s) => s.team === "A")).toBe(false);
  });

  it("cannot pick a team that has no game that week (bye)", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.9),
      // B has no week-1 game at all.
      ...matchup(2, "B", "W", 0.9),
    ];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2],
      availableTeams: new Set(["A", "B"]),
    });
    expect(res.steps.find((s) => s.week === 1)!.team).toBe("A");
    expect(res.steps.find((s) => s.week === 2)!.team).toBe("B");
  });

  it("respects the isPickable gate (kickoff already passed)", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.95).map((p) => ({ ...p, started: p.team === "A" })),
      ...matchup(1, "B", "Y", 0.6),
    ];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1],
      availableTeams: new Set(["A", "B"]),
      isPickable: (_team, _week, p) => !p.started,
    });
    expect(res.steps[0].team).toBe("B");
  });

  it("computes cumulative survival as the running product", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.9),
      ...matchup(2, "B", "Y", 0.8),
      ...matchup(3, "C", "Z", 0.7),
    ];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2, 3],
      availableTeams: new Set(["A", "B", "C"]),
    });
    expect(res.steps.map((s) => s.cumulative)).toEqual([
      0.9,
      expect.closeTo(0.72, 10),
      expect.closeTo(0.504, 10),
    ]);
    expect(res.survival).toBeCloseTo(0.504, 10);
  });

  it("honours a forced week without double-spending the team", () => {
    const probabilities = [
      ...matchup(1, "A", "X", 0.9),
      ...matchup(1, "B", "Y", 0.6),
      ...matchup(2, "A", "Z", 0.9),
      ...matchup(2, "B", "W", 0.6),
    ];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2],
      availableTeams: new Set(["A", "B"]),
      forced: new Map([[1, "A"]]),
    });
    expect(res.steps[0].team).toBe("A");
    expect(res.steps[1].team).toBe("B");
    expect(res.survival).toBeCloseTo(0.54, 10);
  });

  it("flags an infeasible horizon rather than silently shortening it", () => {
    const probabilities = [...matchup(1, "A", "X", 0.9)];
    const index = buildSlotIndex(probabilities);
    const res = optimizePath({
      index,
      weeks: [1, 2],
      availableTeams: new Set(["A"]),
    });
    expect(res.feasible).toBe(false);
    expect(res.weeksCovered).toBe(1);
    expect(res.weeksRequested).toBe(2);
  });
});

describe("horizon selection", () => {
  it("slices the right number of future weeks", () => {
    const weeks = [5, 6, 7, 8, 9, 10, 11, 12];
    expect(horizonWeeks(5, weeks, "3")).toEqual([5, 6, 7]);
    expect(horizonWeeks(5, weeks, "6")).toEqual([5, 6, 7, 8, 9, 10]);
    expect(horizonWeeks(5, weeks, "season")).toEqual(weeks);
  });

  it("ignores weeks already behind the current one", () => {
    expect(horizonWeeks(8, [5, 6, 7, 8, 9], "3")).toEqual([8, 9]);
  });
});
