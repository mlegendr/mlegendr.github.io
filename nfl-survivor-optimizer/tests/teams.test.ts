import { describe, expect, it } from "vitest";
import { TEAMS, TEAM_ABBRS, getTeam, normalizeTeam, requireTeam } from "@/lib/teams";

describe("canonical team registry", () => {
  it("has exactly 32 franchises with unique abbreviations", () => {
    expect(TEAMS).toHaveLength(32);
    expect(new Set(TEAM_ABBRS).size).toBe(32);
  });

  it("has 16 AFC and 16 NFC teams across 8 divisions", () => {
    expect(TEAMS.filter((t) => t.conference === "AFC")).toHaveLength(16);
    expect(TEAMS.filter((t) => t.conference === "NFC")).toHaveLength(16);
    expect(new Set(TEAMS.map((t) => t.division)).size).toBe(8);
  });

  it("carries usable stadium metadata for every team", () => {
    for (const t of TEAMS) {
      expect(t.stadiumLat).toBeGreaterThan(20);
      expect(t.stadiumLat).toBeLessThan(50);
      expect(t.stadiumLon).toBeLessThan(-65);
      expect(t.stadiumLon).toBeGreaterThan(-130);
      expect(["outdoors", "dome", "retractable"]).toContain(t.roofType);
    }
  });
});

describe("normalizeTeam", () => {
  it("resolves the spellings the task calls out", () => {
    expect(normalizeTeam("KC")).toBe("KC");
    expect(normalizeTeam("Kansas City Chiefs")).toBe("KC");
    expect(normalizeTeam("Kansas City")).toBe("KC");
    expect(normalizeTeam("kansas city chiefs")).toBe("KC");
  });

  it("handles historical and provider-specific abbreviations", () => {
    expect(normalizeTeam("OAK")).toBe("LV");
    expect(normalizeTeam("SD")).toBe("LAC");
    expect(normalizeTeam("STL")).toBe("LA");
    expect(normalizeTeam("LAR")).toBe("LA");
    expect(normalizeTeam("WSH")).toBe("WAS");
    expect(normalizeTeam("JAC")).toBe("JAX");
    expect(normalizeTeam("Washington Football Team")).toBe("WAS");
  });

  it("distinguishes the shared-market teams", () => {
    expect(normalizeTeam("New York Giants")).toBe("NYG");
    expect(normalizeTeam("New York Jets")).toBe("NYJ");
    expect(normalizeTeam("Los Angeles Rams")).toBe("LA");
    expect(normalizeTeam("Los Angeles Chargers")).toBe("LAC");
  });

  it("refuses to guess on ambiguous or unknown input", () => {
    expect(normalizeTeam("New York")).toBeNull();
    expect(normalizeTeam("Toronto Argonauts")).toBeNull();
    expect(normalizeTeam("")).toBeNull();
    expect(normalizeTeam(null)).toBeNull();
    expect(() => requireTeam("Nowhere Football Club")).toThrow();
  });

  it("round-trips every canonical form", () => {
    for (const t of TEAMS) {
      expect(normalizeTeam(t.abbr)).toBe(t.abbr);
      expect(normalizeTeam(t.name)).toBe(t.abbr);
      expect(getTeam(t.abbr).name).toBe(t.name);
    }
  });
});
