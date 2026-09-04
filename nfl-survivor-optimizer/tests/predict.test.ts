import { describe, expect, it } from "vitest";
import {
  baseModelProbability,
  computeMarketWeight,
  predictGame,
  scoreConfidence,
  weatherDamping,
} from "@/lib/model/predict";
import { FALLBACK_ARTIFACT } from "@/lib/model/artifact";
import { buildRatings } from "@/lib/model/ratings";
import { scoreInjury } from "@/lib/injuries";
import type { CanonicalGame, CanonicalOdds, TeamRatingState } from "@/lib/types";

const NOW = new Date("2026-10-08T12:00:00Z");

const artifact = {
  ...FALLBACK_ARTIFACT,
  priors: { KC: { elo: 1600, offEpa: 0.08, defEpa: -0.03 }, DEN: { elo: 1450, offEpa: -0.02, defEpa: 0.01 } },
};

function game(over: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: "2026_06_DEN_KC",
    season: 2026,
    week: 6,
    seasonType: "REG",
    kickoff: "2026-10-11T17:00:00.000Z",
    homeTeam: "KC",
    awayTeam: "DEN",
    neutralSite: false,
    stadium: "GEHA Field at Arrowhead Stadium",
    roof: "outdoors",
    surface: "grass",
    divisionGame: true,
    homeRest: 7,
    awayRest: 7,
    homeScore: null,
    awayScore: null,
    completed: false,
    overtime: false,
    refHomeMoneyline: null,
    refAwayMoneyline: null,
    refSpreadLine: null,
    ...over,
  };
}

function ratings(): Map<string, TeamRatingState> {
  return buildRatings(artifact, [], [], [1, 2, 3, 4, 5, 6]).current;
}

function odds(over: Partial<CanonicalOdds> = {}): CanonicalOdds {
  return {
    gameId: "2026_06_DEN_KC",
    homeTeam: "KC",
    awayTeam: "DEN",
    consensusHomeWinProbability: 0.79,
    consensusAwayWinProbability: 0.21,
    bookCount: 12,
    dispersion: 0.005,
    homeMoneyline: -380,
    awayMoneyline: 300,
    spread: -8.5,
    total: 44.5,
    oddsLastUpdated: "2026-10-08T11:00:00Z",
    source: "the-odds-api",
    ...over,
  };
}

describe("base model probability", () => {
  it("favours the stronger, rested, home team", () => {
    const { prob, eloDiff } = baseModelProbability(artifact, game(), ratings());
    expect(eloDiff).toBeGreaterThan(150); // 150 rating points + home field
    expect(prob).toBeGreaterThan(0.65);
    expect(prob).toBeLessThan(1);
  });

  it("removes home field at a neutral site", () => {
    const home = baseModelProbability(artifact, game(), ratings()).prob;
    const neutral = baseModelProbability(artifact, game({ neutralSite: true }), ratings()).prob;
    expect(neutral).toBeLessThan(home);
  });

  it("gives the rested team a small edge", () => {
    const even = baseModelProbability(artifact, game(), ratings()).prob;
    const rested = baseModelProbability(
      artifact,
      game({ homeRest: 14, awayRest: 6 }),
      ratings(),
    ).prob;
    expect(rested).toBeGreaterThan(even);
    expect(rested - even).toBeLessThan(0.1); // and only a small one
  });

  it("stays inside [0,1] for absurd rating gaps", () => {
    const wild = {
      ...artifact,
      priors: { KC: { elo: 3000, offEpa: 1, defEpa: -1 }, DEN: { elo: 100, offEpa: -1, defEpa: 1 } },
    };
    const { prob } = baseModelProbability(wild, game(), buildRatings(wild, [], [], [6]).current);
    expect(prob).toBeGreaterThan(0);
    expect(prob).toBeLessThan(1);
  });
});

describe("market weight", () => {
  it("rises with book count", () => {
    const thin = computeMarketWeight(artifact, odds({ bookCount: 2 }), NOW);
    const deep = computeMarketWeight(artifact, odds({ bookCount: 12 }), NOW);
    expect(deep).toBeGreaterThan(thin);
    expect(deep).toBeLessThanOrEqual(artifact.blend.marketWeightMax);
  });

  it("falls as the market goes stale", () => {
    const fresh = computeMarketWeight(artifact, odds(), NOW);
    const stale = computeMarketWeight(
      artifact,
      odds({ oddsLastUpdated: "2026-10-04T11:00:00Z" }),
      NOW,
    );
    expect(stale).toBeLessThan(fresh);
  });

  it("heavily penalises a single-book reference line", () => {
    const real = computeMarketWeight(artifact, odds(), NOW);
    const ref = computeMarketWeight(
      artifact,
      odds({ bookCount: 1, source: "schedule-reference" }),
      NOW,
    );
    expect(ref).toBeLessThan(real * 0.6);
  });

  it("is zero when there is no market", () => {
    expect(computeMarketWeight(artifact, null, NOW)).toBe(0);
  });
});

describe("weather", () => {
  it("does nothing indoors", () => {
    expect(
      weatherDamping({
        gameId: "g",
        temperatureF: 10,
        windMph: 40,
        windGustMph: 55,
        precipChance: 100,
        precipInches: 1,
        isIndoor: true,
        source: "t",
        observedAt: NOW.toISOString(),
      }).damping,
    ).toBe(0);
  });

  it("does nothing when there is no forecast", () => {
    expect(weatherDamping(null).damping).toBe(0);
  });

  it("compresses outcomes in severe wind but only modestly", () => {
    const { damping, severity } = weatherDamping({
      gameId: "g",
      temperatureF: 34,
      windMph: 28,
      windGustMph: 38,
      precipChance: 20,
      precipInches: 0,
      isIndoor: false,
      source: "t",
      observedAt: NOW.toISOString(),
    });
    expect(damping).toBeGreaterThan(0.05);
    expect(damping).toBeLessThanOrEqual(0.18);
    expect(severity).toContain("mph");
  });

  it("ignores a pleasant day", () => {
    expect(
      weatherDamping({
        gameId: "g",
        temperatureF: 68,
        windMph: 6,
        windGustMph: 9,
        precipChance: 5,
        precipInches: 0,
        isIndoor: false,
        source: "t",
        observedAt: NOW.toISOString(),
      }).damping,
    ).toBe(0);
  });
});

describe("full prediction", () => {
  const injuredQb = scoreInjury({
    season: 2026,
    week: 6,
    team: "DEN",
    playerName: "Starting QB",
    position: "QB",
    status: "OUT",
    practiceParticipation: null,
    depthChartRank: 1,
    isStarter: true,
    note: null,
    source: "test",
    manualOverride: false,
    observedAt: "2026-10-07T12:00:00Z",
  });

  it("blends market and model and exposes all three numbers", () => {
    const out = predictGame({
      artifact,
      game: game(),
      ratings: ratings(),
      odds: odds(),
      homeInjuries: [],
      awayInjuries: [],
      weather: null,
      horizonWeeks: 0,
      now: NOW,
    });
    expect(out.marketProbHome).toBeCloseTo(0.79, 10);
    expect(out.finalProbHome).toBeGreaterThan(Math.min(out.marketProbHome!, out.modelProbHome));
    expect(out.finalProbHome).toBeLessThan(Math.max(out.marketProbHome!, out.modelProbHome));
    expect(out.marketWeight).toBeGreaterThan(0.5);
  });

  it("does not double-count an injury the market has already priced", () => {
    // Market updated at 11:00 on the 8th; the injury was reported on the 7th.
    const out = predictGame({
      artifact,
      game: game(),
      ratings: ratings(),
      odds: odds(),
      homeInjuries: [],
      awayInjuries: [injuredQb],
      weather: null,
      horizonWeeks: 0,
      now: NOW,
    });
    expect(out.injuryAdjustment).toBe(0);
    expect(out.factors.some((f) => f.label === "Injuries already priced")).toBe(true);
  });

  it("applies a reduced adjustment for news that post-dates the market", () => {
    const late = { ...injuredQb, observedAt: "2026-10-08T11:45:00Z" };
    const out = predictGame({
      artifact,
      game: game(),
      ratings: ratings(),
      odds: odds(),
      homeInjuries: [],
      awayInjuries: [late],
      weather: null,
      horizonWeeks: 0,
      now: NOW,
    });
    expect(out.injuryAdjustment).toBeGreaterThan(0);
    expect(out.factors.some((f) => f.label === "Post-market injury news")).toBe(true);
  });

  it("shrinks distant forecasts toward a coin flip", () => {
    const near = predictGame({
      artifact,
      game: game(),
      ratings: ratings(),
      odds: null,
      homeInjuries: [],
      awayInjuries: [],
      weather: null,
      horizonWeeks: 0,
      now: NOW,
    });
    const far = predictGame({
      artifact,
      game: game({ week: 17 }),
      ratings: ratings(),
      odds: null,
      homeInjuries: [],
      awayInjuries: [],
      weather: null,
      horizonWeeks: 11,
      now: NOW,
    });
    expect(far.finalProbHome).toBeLessThan(near.finalProbHome);
    expect(far.finalProbHome).toBeGreaterThan(0.5);
    expect(far.confidenceScore).toBeLessThan(near.confidenceScore);
  });

  it("keeps every output probability in [0,1]", () => {
    for (const horizon of [0, 3, 8, 14]) {
      const out = predictGame({
        artifact,
        game: game(),
        ratings: ratings(),
        odds: odds({ consensusHomeWinProbability: 0.98, consensusAwayWinProbability: 0.02 }),
        homeInjuries: [injuredQb],
        awayInjuries: [injuredQb],
        weather: null,
        horizonWeeks: horizon,
        now: NOW,
      });
      expect(out.finalProbHome).toBeGreaterThan(0);
      expect(out.finalProbHome).toBeLessThan(1);
      expect(out.modelProbHome).toBeGreaterThan(0);
      expect(out.modelProbHome).toBeLessThan(1);
    }
  });
});

describe("confidence scoring", () => {
  const common = {
    horizonWeeks: 0,
    modelProbHome: 0.78,
    injuries: [],
    weather: null,
    now: NOW,
    artifactIsFallback: false,
  };

  it("rates twelve fresh books above one stale line", () => {
    const strong = scoreConfidence({ ...common, odds: odds(), marketProbHome: 0.79 });
    const weak = scoreConfidence({
      ...common,
      odds: odds({
        bookCount: 1,
        source: "schedule-reference",
        oddsLastUpdated: "2026-10-01T00:00:00Z",
      }),
      marketProbHome: 0.79,
    });
    expect(strong.confidenceScore).toBeGreaterThan(weak.confidenceScore);
    expect(strong.confidence).toBe("HIGH");
    expect(weak.dataQuality).toBe("DEGRADED");
  });

  it("drops when the starting quarterback is unresolved", () => {
    const questionableQb = scoreInjury({
      season: 2026,
      week: 6,
      team: "KC",
      playerName: "QB",
      position: "QB",
      status: "QUESTIONABLE",
      practiceParticipation: "Limited",
      depthChartRank: 1,
      isStarter: true,
      note: null,
      source: "t",
      manualOverride: false,
      observedAt: NOW.toISOString(),
    });
    const clean = scoreConfidence({ ...common, odds: odds(), marketProbHome: 0.79 });
    const messy = scoreConfidence({
      ...common,
      odds: odds(),
      marketProbHome: 0.79,
      injuries: [questionableQb],
    });
    expect(messy.confidenceScore).toBeLessThan(clean.confidenceScore);
  });

  it("drops when the model and market disagree sharply", () => {
    const agree = scoreConfidence({ ...common, odds: odds(), marketProbHome: 0.79 });
    const disagree = scoreConfidence({ ...common, odds: odds(), marketProbHome: 0.5 });
    expect(disagree.confidenceScore).toBeLessThan(agree.confidenceScore);
  });

  it("marks a current-week game with no market as degraded", () => {
    const none = scoreConfidence({ ...common, odds: null, marketProbHome: null });
    expect(none.dataQuality).toBe("DEGRADED");
  });
});
