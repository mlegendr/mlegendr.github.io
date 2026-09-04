import { describe, expect, it } from "vitest";
import { computeRobustness, robustnessLabel, uncertaintySigma } from "@/lib/optimizer/montecarlo";
import { matchup, gp } from "./fixtures";

describe("uncertainty sizing", () => {
  it("grows with the forecast horizon", () => {
    const near = uncertaintySigma(gp("A", 1, "X", 0.7, { horizonWeeks: 0 }));
    const far = uncertaintySigma(gp("A", 12, "X", 0.7, { horizonWeeks: 11 }));
    expect(far).toBeGreaterThan(near * 2);
  });

  it("shrinks when a deep market exists", () => {
    const modelOnly = uncertaintySigma(gp("A", 3, "X", 0.7, { horizonWeeks: 2 }));
    const marketBacked = uncertaintySigma(
      gp("A", 3, "X", 0.7, { horizonWeeks: 2, marketProb: 0.7, bookCount: 10 }),
    );
    expect(marketBacked).toBeLessThan(modelOnly);
  });

  it("grows when confidence is low", () => {
    const high = uncertaintySigma(gp("A", 3, "X", 0.7, { horizonWeeks: 2, confidence: "HIGH" }));
    const low = uncertaintySigma(gp("A", 3, "X", 0.7, { horizonWeeks: 2, confidence: "LOW" }));
    expect(low).toBeGreaterThan(high);
  });
});

describe("Monte Carlo robustness", () => {
  const probabilities = [
    ...matchup(1, "A", "X", 0.88),
    ...matchup(1, "B", "Y", 0.84),
    ...matchup(2, "A", "Z", 0.92),
    ...matchup(2, "B", "W", 0.86),
  ].map((p) => ({ ...p, horizonWeeks: p.week - 1 }));

  const opts = {
    probabilities,
    currentWeek: 1,
    remainingWeeks: [1, 2],
    availableTeams: new Set(["A", "B"]),
    usedTeams: new Set<string>(),
    horizon: "season" as const,
    simulations: 500,
  };

  it("produces shares that sum to one", () => {
    const r = computeRobustness(opts);
    const total = Object.values(r.shares).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("is deterministic for a fixed seed", () => {
    const a = computeRobustness({ ...opts, seed: 42 });
    const b = computeRobustness({ ...opts, seed: 42 });
    expect(a.shares).toEqual(b.shares);
  });

  it("still favours the team the deterministic optimiser picks", () => {
    const r = computeRobustness({ ...opts, seed: 7, simulations: 800 });
    // Deterministically B is best (0.84*0.92 = 0.773 vs 0.88*0.86 = 0.757), but the
    // margin is thin, so a well-behaved robustness run must NOT report certainty.
    expect(r.ranked[0].team).toBe("B");
    expect(r.ranked[0].share).toBeLessThan(0.95);
    expect(r.ranked[0].share).toBeGreaterThan(0.5);
  });

  it("never proposes an already-used team", () => {
    const r = computeRobustness({ ...opts, usedTeams: new Set(["B"]), seed: 3 });
    expect(Object.keys(r.shares)).not.toContain("B");
  });

  it("labels shares honestly", () => {
    expect(robustnessLabel(0.72)).toBe("HIGH");
    expect(robustnessLabel(0.3)).toBe("MEDIUM");
    expect(robustnessLabel(0.05)).toBe("LOW");
    expect(robustnessLabel(null)).toBe("UNKNOWN");
  });
});
