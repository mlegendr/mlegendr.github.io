import { describe, expect, it } from "vitest";
import {
  americanToImpliedProbability,
  buildConsensus,
  clampProbability,
  median,
  probabilityToAmerican,
  removeVig,
  shrinkToward,
  spreadToWinProbability,
  trimmedMean,
} from "@/lib/probability";

describe("American moneyline conversion", () => {
  it("converts favourites correctly", () => {
    // -200 means risk 200 to win 100 => 200/300
    expect(americanToImpliedProbability(-200)).toBeCloseTo(2 / 3, 10);
    expect(americanToImpliedProbability(-110)).toBeCloseTo(110 / 210, 10);
    expect(americanToImpliedProbability(-1000)).toBeCloseTo(1000 / 1100, 10);
  });

  it("converts underdogs correctly", () => {
    expect(americanToImpliedProbability(200)).toBeCloseTo(1 / 3, 10);
    expect(americanToImpliedProbability(100)).toBeCloseTo(0.5, 10);
    expect(americanToImpliedProbability(154)).toBeCloseTo(100 / 254, 10);
  });

  it("round-trips through probabilityToAmerican", () => {
    for (const ml of [-450, -200, -110, 100, 175, 600]) {
      const p = americanToImpliedProbability(ml);
      const back = probabilityToAmerican(p);
      expect(Math.abs(back - ml)).toBeLessThanOrEqual(1);
    }
  });

  it("rejects a zero moneyline", () => {
    expect(() => americanToImpliedProbability(0)).toThrow();
  });
});

describe("vig removal", () => {
  it("produces fair probabilities summing to exactly one", () => {
    const { fairHome, fairAway } = removeVig(-185, 154);
    expect(fairHome + fairAway).toBeCloseTo(1, 12);
    expect(fairHome).toBeGreaterThan(0.5);
  });

  it("reports the overround and always removes it", () => {
    const { overround, fairHome, fairAway } = removeVig(-110, -110);
    expect(overround).toBeGreaterThan(0); // a -110/-110 market is ~4.8% overround
    expect(fairHome).toBeCloseTo(0.5, 12);
    expect(fairAway).toBeCloseTo(0.5, 12);
  });

  it("leaves a vig-free pair untouched", () => {
    // +100 / -100 is already fair
    const { fairHome, fairAway, overround } = removeVig(-100, 100);
    expect(overround).toBeCloseTo(0, 12);
    expect(fairHome).toBeCloseTo(0.5, 12);
    expect(fairAway).toBeCloseTo(0.5, 12);
  });

  it("keeps every de-vigged probability inside [0,1]", () => {
    for (const [h, a] of [
      [-3000, 1200],
      [-105, -115],
      [900, -1400],
    ] as [number, number][]) {
      const { fairHome, fairAway } = removeVig(h, a);
      expect(fairHome).toBeGreaterThan(0);
      expect(fairHome).toBeLessThan(1);
      expect(fairAway).toBeGreaterThan(0);
      expect(fairAway).toBeLessThan(1);
    }
  });
});

describe("multi-book consensus", () => {
  const quotes = [
    { book: "A", homeMoneyline: -200, awayMoneyline: 170, spread: -4.5, total: 44, lastUpdate: "2026-09-10T12:00:00Z" },
    { book: "B", homeMoneyline: -210, awayMoneyline: 175, spread: -4.5, total: 44.5, lastUpdate: "2026-09-10T12:30:00Z" },
    { book: "C", homeMoneyline: -190, awayMoneyline: 165, spread: -4, total: 44, lastUpdate: "2026-09-10T11:00:00Z" },
  ];

  it("takes the median of the per-book fair probabilities", () => {
    const c = buildConsensus({ gameId: "g", homeTeam: "KC", awayTeam: "DEN", quotes, source: "test" });
    expect(c).not.toBeNull();
    const fair = quotes.map((q) => removeVig(q.homeMoneyline, q.awayMoneyline).fairHome);
    expect(c!.consensusHomeWinProbability).toBeCloseTo(median(fair), 12);
    expect(c!.consensusHomeWinProbability + c!.consensusAwayWinProbability).toBeCloseTo(1, 12);
    expect(c!.bookCount).toBe(3);
  });

  it("uses the newest book update as the market timestamp", () => {
    const c = buildConsensus({ gameId: "g", homeTeam: "KC", awayTeam: "DEN", quotes, source: "test" });
    expect(c!.oddsLastUpdated).toBe("2026-09-10T12:30:00.000Z");
  });

  it("ignores one-sided books but still counts their spread", () => {
    const c = buildConsensus({
      gameId: "g",
      homeTeam: "KC",
      awayTeam: "DEN",
      source: "test",
      quotes: [...quotes, { book: "D", homeMoneyline: -300, awayMoneyline: null, spread: -6, total: null, lastUpdate: null }],
    });
    expect(c!.bookCount).toBe(3);
    expect(c!.spread).toBe(-4.5);
  });

  it("returns null when no book has a two-way market", () => {
    const c = buildConsensus({
      gameId: "g",
      homeTeam: "KC",
      awayTeam: "DEN",
      source: "test",
      quotes: [{ book: "X", homeMoneyline: null, awayMoneyline: null, spread: -3, total: null, lastUpdate: null }],
    });
    expect(c).toBeNull();
  });

  it("reports dispersion so a disagreeing market can be down-weighted", () => {
    const tight = buildConsensus({ gameId: "g", homeTeam: "KC", awayTeam: "DEN", quotes, source: "t" })!;
    const wide = buildConsensus({
      gameId: "g",
      homeTeam: "KC",
      awayTeam: "DEN",
      source: "t",
      quotes: [
        { book: "A", homeMoneyline: -120, awayMoneyline: 100, spread: null, total: null, lastUpdate: null },
        { book: "B", homeMoneyline: -600, awayMoneyline: 450, spread: null, total: null, lastUpdate: null },
      ],
    })!;
    expect(wide.dispersion).toBeGreaterThan(tight.dispersion);
  });
});

describe("robust averages", () => {
  it("median handles even and odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("trimmed mean discards outliers when there are enough samples", () => {
    const values = [0.5, 0.51, 0.52, 0.53, 0.54, 0.99];
    expect(trimmedMean(values, 0.2)).toBeLessThan(
      values.reduce((a, b) => a + b, 0) / values.length,
    );
  });
});

describe("bounds and helpers", () => {
  it("clamps into the open unit interval", () => {
    expect(clampProbability(2)).toBeLessThan(1);
    expect(clampProbability(-5)).toBeGreaterThan(0);
    expect(clampProbability(Number.NaN)).toBe(0.5);
  });

  it("shrinks toward a target", () => {
    expect(shrinkToward(0.9, 0.5, 0)).toBeCloseTo(0.9, 12);
    expect(shrinkToward(0.9, 0.5, 1)).toBeCloseTo(0.5, 12);
    expect(shrinkToward(0.9, 0.5, 0.5)).toBeCloseTo(0.7, 12);
  });

  it("maps spreads to sensible probabilities", () => {
    expect(spreadToWinProbability(0)).toBeCloseTo(0.5, 6);
    expect(spreadToWinProbability(-7)).toBeGreaterThan(0.68);
    expect(spreadToWinProbability(7)).toBeLessThan(0.32);
    expect(spreadToWinProbability(-3) + spreadToWinProbability(3)).toBeCloseTo(1, 6);
  });
});
