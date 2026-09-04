import { describe, expect, it } from "vitest";
import { computePoolStrategy } from "@/lib/pool-strategy";
import type { CandidateEvaluation } from "@/lib/types";

function candidate(team: string, win: number, path: number): CandidateEvaluation {
  return {
    team,
    gameId: `g-${team}`,
    opponent: "OPP",
    isHome: true,
    currentWinProb: win,
    marketProb: win,
    modelProb: win,
    confidence: "HIGH",
    pathSurvival: { "3": path, "6": path, "9": path, season: path },
    bestPathSurvival: path,
    futureValueCost: 0,
    recommendationScore: 100 * path,
    horizonWinners: {},
    robustnessShare: null,
    path: [],
    injuries: [],
    reasons: [],
    verdict: "VIABLE",
  };
}

const candidates = [candidate("CHALK", 0.85, 0.45), candidate("FADE", 0.8, 0.42)];

describe("pool strategy", () => {
  it("refuses to run without user-supplied popularity", () => {
    const r = computePoolStrategy({
      candidates,
      horizon: "6",
      remainingEntries: 500,
      pickPopularity: {},
      riskPreference: 0.5,
    });
    expect(r.usable).toBe(false);
    expect(r.message).toContain("will not invent");
    expect(r.survivalBest).toBe("CHALK");
  });

  it("refuses to run without a field size", () => {
    const r = computePoolStrategy({
      candidates,
      horizon: "6",
      remainingEntries: 0,
      pickPopularity: { CHALK: 0.6 },
      riskPreference: 0.5,
    });
    expect(r.usable).toBe(false);
  });

  it("agrees with pure survival at risk preference 0", () => {
    const r = computePoolStrategy({
      candidates,
      horizon: "6",
      remainingEntries: 500,
      pickPopularity: { CHALK: 0.6, FADE: 0.05 },
      riskPreference: 0,
    });
    expect(r.usable).toBe(true);
    expect(r.best).toBe("CHALK");
    expect(r.best).toBe(r.survivalBest);
  });

  it("prefers the contrarian team at high risk preference", () => {
    const r = computePoolStrategy({
      candidates,
      horizon: "6",
      remainingEntries: 500,
      pickPopularity: { CHALK: 0.6, FADE: 0.05 },
      riskPreference: 1,
    });
    expect(r.best).toBe("FADE");
    expect(r.message).toContain("Leverage mode prefers");
    expect(r.rows.find((x) => x.team === "CHALK")!.leverage).toBe("CHALK");
    expect(r.rows.find((x) => x.team === "FADE")!.leverage).toBe("CONTRARIAN");
  });

  it("reports expected co-survivors above one", () => {
    const r = computePoolStrategy({
      candidates,
      horizon: "6",
      remainingEntries: 500,
      pickPopularity: { CHALK: 0.6, FADE: 0.05 },
      riskPreference: 0.5,
    });
    for (const row of r.rows) expect(row.expectedCoSurvivors).toBeGreaterThanOrEqual(1);
  });
});
