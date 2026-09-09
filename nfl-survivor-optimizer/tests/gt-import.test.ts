/** §3 — CSV import: both layouts, alias normalisation, and no silent discards. */

import { describe, expect, it } from "vitest";
import { buildImportPreview } from "@/lib/gametheory/import";

const ctx = { season: 2026, maxWeek: 18 };

describe("long format", () => {
  const csv = `entry,week,team
Me,1,PHI
Entry A,1,BAL
Entry B,1,CIN
Entry C,1,BUF
Me,2,DAL
Entry A,2,KC
Entry B,2,DET
Entry C,2,SF`;

  it("parses every row and groups by entry", () => {
    const p = buildImportPreview(csv, ctx);
    expect(p.format).toBe("long");
    expect(p.totals.rows).toBe(8);
    expect(p.totals.entries).toBe(4);
    expect(p.committable).toBe(true);
    const me = p.entries.find((e) => e.name === "Me")!;
    expect(me.weeks).toEqual([1, 2]);
    expect(me.teams).toEqual(["PHI", "DAL"]);
  });
});

describe("wide format", () => {
  const csv = `entry,week1,week2,week3,week4
Me,PHI,DAL,BUF,
Entry A,BAL,KC,,
Entry B,CIN,DET,,
Entry C,BUF,SF,,`;

  it("expands week columns and ignores empty cells", () => {
    const p = buildImportPreview(csv, ctx);
    expect(p.format).toBe("wide");
    expect(p.totals.entries).toBe(4);
    expect(p.totals.errors).toBe(0);
    const me = p.entries.find((e) => e.name === "Me")!;
    expect(me.teams).toEqual(["PHI", "DAL", "BUF"]);
    const a = p.entries.find((e) => e.name === "Entry A")!;
    expect(a.teams).toEqual(["BAL", "KC"]);
  });
});

describe("owner column", () => {
  const csv = `entry,owner,week,team
Alice Entry 1,Alice,1,BAL
Alice Entry 2,Alice,1,BUF
Bob Entry 1,Bob,1,CIN`;

  it("preserves owner identity while keeping entries separate", () => {
    const p = buildImportPreview(csv, ctx);
    expect(p.totals.entries).toBe(3);
    const a1 = p.entries.find((e) => e.name === "Alice Entry 1")!;
    const a2 = p.entries.find((e) => e.name === "Alice Entry 2")!;
    expect(a1.owner).toBe("Alice");
    expect(a2.owner).toBe("Alice");
    expect(a1.teams).toEqual(["BAL"]);
    expect(a2.teams).toEqual(["BUF"]);
  });
});

describe("team alias normalisation", () => {
  it("accepts full names, cities and legacy abbreviations", () => {
    const csv = `entry,week,team
E1,1,Kansas City Chiefs
E2,1,WSH
E3,1,OAK
E4,1,Los Angeles Rams`;
    const p = buildImportPreview(csv, ctx);
    expect(p.totals.errors).toBe(0);
    expect(p.rows.map((r) => r.team)).toEqual(["KC", "WAS", "LV", "LA"]);
  });
});

describe("validation — nothing is silently discarded", () => {
  it("flags an unrecognised team", () => {
    const p = buildImportPreview("entry,week,team\nE1,1,Toronto Argonauts", ctx);
    expect(p.committable).toBe(false);
    expect(p.issues.some((i) => i.kind === "UNKNOWN_TEAM" && i.severity === "ERROR")).toBe(true);
  });

  it("flags an impossible week", () => {
    const p = buildImportPreview("entry,week,team\nE1,25,BUF", ctx);
    expect(p.committable).toBe(false);
    expect(p.issues.some((i) => i.kind === "INVALID_WEEK")).toBe(true);
  });

  it("flags a team reused by the same entry", () => {
    const p = buildImportPreview("entry,week,team\nE1,1,BUF\nE1,3,BUF", ctx);
    expect(p.committable).toBe(false);
    const issue = p.issues.find((i) => i.kind === "TEAM_REUSED_BY_ENTRY")!;
    expect(issue.severity).toBe("ERROR");
    expect(issue.message).toContain("only once");
  });

  it("allows two DIFFERENT entries to use the same team", () => {
    const p = buildImportPreview("entry,week,team\nE1,1,BUF\nE2,1,BUF", ctx);
    expect(p.committable).toBe(true);
    expect(p.totals.errors).toBe(0);
  });

  it("treats an exact duplicate as a warning and keeps one copy", () => {
    const p = buildImportPreview("entry,week,team\nE1,1,BUF\nE1,1,BUF", ctx);
    expect(p.issues.some((i) => i.kind === "DUPLICATE_PICK" && i.severity === "WARNING")).toBe(true);
    expect(p.totals.rows).toBe(1);
    expect(p.committable).toBe(true);
  });

  it("flags conflicting selections for the same entry and week", () => {
    const p = buildImportPreview("entry,week,team\nE1,1,BUF\nE1,1,DAL", ctx);
    expect(p.committable).toBe(false);
    expect(p.issues.some((i) => i.kind === "CONFLICTING_SELECTION")).toBe(true);
  });

  it("flags a missing entry name", () => {
    const p = buildImportPreview("entry,week,team\n,1,BUF", ctx);
    expect(p.issues.some((i) => i.kind === "MISSING_ENTRY")).toBe(true);
  });

  it("flags a bye-week selection when the schedule is supplied", () => {
    const p = buildImportPreview("entry,week,team\nE1,6,BUF", {
      ...ctx,
      byeTeamsByWeek: new Map([[6, new Set(["BUF"])]]),
    });
    expect(p.committable).toBe(false);
    expect(p.issues.some((i) => i.kind === "TEAM_ON_BYE")).toBe(true);
  });

  it("warns about a pick entered after elimination without blocking it", () => {
    const p = buildImportPreview("entry,week,team\nE1,5,BUF", {
      ...ctx,
      eliminatedWeekByEntry: new Map([["E1", 3]]),
    });
    const issue = p.issues.find((i) => i.kind === "PICK_AFTER_ELIMINATION")!;
    expect(issue.severity).toBe("WARNING");
    expect(p.committable).toBe(true);
  });

  it("rejects a file with no usable header", () => {
    const p = buildImportPreview("foo,bar\n1,2", ctx);
    expect(p.committable).toBe(false);
    expect(p.issues.some((i) => i.kind === "MALFORMED_ROW")).toBe(true);
  });

  it("rejects an empty file", () => {
    const p = buildImportPreview("", ctx);
    expect(p.committable).toBe(false);
  });
});
