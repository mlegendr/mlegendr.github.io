import { describe, expect, it } from "vitest";
import {
  hasUnresolvedStarterQb,
  impactLabel,
  notableInjuries,
  scoreInjury,
  shouldApplyInjuryAdjustment,
  teamInjuryBurden,
} from "@/lib/injuries";
import type { CanonicalInjury, InjuryStatus } from "@/lib/types";

function injury(over: Partial<CanonicalInjury> = {}): CanonicalInjury {
  return {
    season: 2026,
    week: 5,
    team: "BUF",
    playerName: "Test Player",
    position: "WR",
    status: "OUT" as InjuryStatus,
    practiceParticipation: null,
    depthChartRank: 1,
    isStarter: true,
    note: null,
    source: "test",
    manualOverride: false,
    observedAt: "2026-10-08T12:00:00.000Z",
    ...over,
  };
}

describe("player impact", () => {
  it("weights a starting quarterback far above a rotational player", () => {
    const qb = scoreInjury(injury({ position: "QB" }));
    const lb = scoreInjury(injury({ position: "LB", isStarter: false, depthChartRank: 3 }));
    expect(qb.impact).toBe("CRITICAL");
    expect(qb.impactScore).toBeGreaterThan(lb.impactScore * 20);
    expect(lb.impact).toBe("LOW");
  });

  it("scales with the designation", () => {
    const out = scoreInjury(injury({ position: "QB", status: "OUT" }));
    const doubtful = scoreInjury(injury({ position: "QB", status: "DOUBTFUL" }));
    const questionable = scoreInjury(injury({ position: "QB", status: "QUESTIONABLE" }));
    expect(out.impactScore).toBeGreaterThan(doubtful.impactScore);
    expect(doubtful.impactScore).toBeGreaterThan(questionable.impactScore);
  });

  it("discounts backups by depth-chart rank", () => {
    const starter = scoreInjury(injury({ position: "WR", depthChartRank: 1, isStarter: true }));
    const second = scoreInjury(injury({ position: "WR", depthChartRank: 2, isStarter: false }));
    const fourth = scoreInjury(injury({ position: "WR", depthChartRank: 4, isStarter: false }));
    expect(starter.impactScore).toBeGreaterThan(second.impactScore);
    expect(second.impactScore).toBeGreaterThan(fourth.impactScore);
  });

  it("nudges a questionable player toward missing when practice was limited", () => {
    const full = scoreInjury(
      injury({ position: "QB", status: "QUESTIONABLE", practiceParticipation: "Full Participation" }),
    );
    const dnp = scoreInjury(
      injury({ position: "QB", status: "QUESTIONABLE", practiceParticipation: "Did Not Participate" }),
    );
    expect(dnp.impactScore).toBeGreaterThan(full.impactScore);
  });

  it("labels impact consistently", () => {
    expect(impactLabel(0.9)).toBe("CRITICAL");
    expect(impactLabel(0.2)).toBe("HIGH");
    expect(impactLabel(0.07)).toBe("MODERATE");
    expect(impactLabel(0.01)).toBe("LOW");
  });
});

describe("team burden", () => {
  it("combines injuries with diminishing returns", () => {
    const one = teamInjuryBurden([scoreInjury(injury({ position: "WR" }))]);
    const five = teamInjuryBurden(
      Array.from({ length: 5 }, (_, i) =>
        scoreInjury(injury({ position: "WR", playerName: `P${i}` })),
      ),
    );
    expect(five).toBeGreaterThan(one);
    expect(five).toBeLessThan(one * 5);
  });

  it("caps the total so no injury list turns a game into a certainty", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      scoreInjury(injury({ position: "QB", playerName: `QB${i}` })),
    );
    expect(teamInjuryBurden(many)).toBeLessThanOrEqual(1.4);
  });

  it("keeps the notable list short and QB-aware", () => {
    const list = [
      scoreInjury(injury({ position: "P", playerName: "Punter", status: "QUESTIONABLE" })),
      scoreInjury(injury({ position: "QB", playerName: "Starter QB" })),
      ...Array.from({ length: 10 }, (_, i) =>
        scoreInjury(injury({ position: "CB", playerName: `CB${i}` })),
      ),
    ];
    const notable = notableInjuries(list, 5);
    expect(notable).toHaveLength(5);
    expect(notable[0].playerName).toBe("Starter QB");
    expect(notable.some((n) => n.position === "P")).toBe(false);
  });
});

describe("double-counting guard", () => {
  it("does not adjust when the market updated after the injury news", () => {
    expect(
      shouldApplyInjuryAdjustment("2026-10-08T18:00:00Z", "2026-10-08T12:00:00Z"),
    ).toBe(false);
  });

  it("does adjust when the injury news is newer than the market", () => {
    expect(
      shouldApplyInjuryAdjustment("2026-10-08T12:00:00Z", "2026-10-08T18:00:00Z"),
    ).toBe(true);
  });

  it("adjusts freely when there is no market at all", () => {
    expect(shouldApplyInjuryAdjustment(null, "2026-10-08T18:00:00Z")).toBe(true);
  });

  it("does not adjust when there is no injury timestamp", () => {
    expect(shouldApplyInjuryAdjustment("2026-10-08T12:00:00Z", null)).toBe(false);
  });
});

describe("unresolved quarterback detection", () => {
  it("flags a questionable starting QB", () => {
    expect(
      hasUnresolvedStarterQb([scoreInjury(injury({ position: "QB", status: "QUESTIONABLE" }))]),
    ).toBe(true);
  });

  it("does not flag a QB who is definitively out", () => {
    expect(hasUnresolvedStarterQb([scoreInjury(injury({ position: "QB", status: "OUT" }))])).toBe(
      false,
    );
  });
});
