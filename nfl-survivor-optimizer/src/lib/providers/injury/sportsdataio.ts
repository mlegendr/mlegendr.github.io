/**
 * SportsDataIO injury provider (preferred when SPORTSDATAIO_API_KEY is set).
 *
 * Endpoints used:
 *   GET /v3/nfl/scores/json/Injuries/{season}REG/{week}   — weekly injury report
 *   GET /v3/nfl/scores/json/DepthCharts                    — starter identification
 *
 * The weekly report carries practice participation and, close to kickoff,
 * declared-inactive flags — which is exactly the information that arrives *after*
 * the market has settled and therefore still carries signal.
 */

import "../../server-guard";
import { normalizeTeam } from "../../teams";
import type { CanonicalInjury, InjuryStatus } from "../../types";
import { cached, TTL } from "../../cache";
import { env, hasSportsDataIo } from "../../env";
import { fetchWithTimeout, ProviderError, type InjuryProvider, type ProviderResult } from "../types";

const BASE = "https://api.sportsdata.io/v3/nfl/scores/json";

export function normalizeStatus(raw: string | null | undefined): InjuryStatus | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s || s === "NULL" || s === "SCRATCHED") return null;
  if (s.startsWith("OUT")) return "OUT";
  if (s.startsWith("DOUBT")) return "DOUBTFUL";
  if (s.startsWith("QUEST")) return "QUESTIONABLE";
  if (s.includes("INJURED RESERVE") || s === "IR") return "IR";
  if (s.startsWith("PUP") || s.includes("PHYSICALLY UNABLE")) return "PUP";
  if (s.startsWith("PROB")) return "PROBABLE";
  if (s === "ACTIVE" || s === "HEALTHY") return "ACTIVE";
  return "QUESTIONABLE";
}

interface SdioInjury {
  PlayerID?: number;
  Name?: string;
  Position?: string;
  Team?: string;
  Status?: string;
  InjuryStatus?: string;
  BodyPart?: string;
  Practice?: string;
  PracticeDescription?: string;
  DeclaredInactive?: boolean;
  Updated?: string;
}

interface SdioDepthChartEntry {
  Team?: string;
  PlayerID?: number;
  Name?: string;
  Position?: string;
  DepthOrder?: number;
}

export function mapSportsDataIo(
  rows: SdioInjury[],
  depth: Map<string, { rank: number; }>,
  season: number,
  week: number,
  observedAt: string,
): CanonicalInjury[] {
  const out: CanonicalInjury[] = [];
  for (const r of rows) {
    const team = normalizeTeam(r.Team);
    const status = normalizeStatus(r.InjuryStatus ?? r.Status);
    if (!team || !status || status === "ACTIVE") continue;
    const name = (r.Name ?? "").trim();
    if (!name) continue;
    const d = depth.get(`${team}|${name.toUpperCase()}`);
    const notes = [r.BodyPart, r.PracticeDescription].filter(Boolean).join(" — ");
    out.push({
      season,
      week,
      team,
      playerName: name,
      position: (r.Position ?? "UNK").toUpperCase(),
      status: r.DeclaredInactive ? "OUT" : status,
      practiceParticipation: r.Practice ?? null,
      depthChartRank: d?.rank ?? null,
      isStarter: (d?.rank ?? 99) === 1,
      note: notes || null,
      source: "sportsdataio",
      manualOverride: false,
      observedAt,
    });
  }
  return out;
}

export class SportsDataIoInjuryProvider implements InjuryProvider {
  readonly id = "sportsdataio";
  readonly label = "SportsDataIO";

  isConfigured(): boolean {
    return hasSportsDataIo();
  }

  private async fetchJson<T>(path: string, key: string, ttl: number, force?: boolean): Promise<T> {
    const res = await cached<T>(
      key,
      ttl,
      async () => {
        const r = await fetchWithTimeout(`${BASE}/${path}`, {
          timeoutMs: 25_000,
          headers: { "Ocp-Apim-Subscription-Key": env.sportsDataIoKey },
        });
        if (!r.ok) throw new ProviderError(`SportsDataIO HTTP ${r.status} on ${path}`, this.id, r.status);
        return (await r.json()) as T;
      },
      { force },
    );
    return res.value;
  }

  async getInjuries(
    season: number,
    week: number,
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalInjury[]>> {
    if (!this.isConfigured()) throw new ProviderError("SPORTSDATAIO_API_KEY not configured", this.id);

    const depthRows = await this.fetchJson<SdioDepthChartEntry[]>(
      "DepthCharts",
      `injury:sdio:depth:${season}`,
      TTL.playerDatabase,
      opts?.force,
    ).catch(() => [] as SdioDepthChartEntry[]);

    const depth = new Map<string, { rank: number }>();
    for (const d of depthRows ?? []) {
      const t = normalizeTeam(d.Team);
      if (!t || !d.Name) continue;
      depth.set(`${t}|${d.Name.toUpperCase()}`, { rank: d.DepthOrder ?? 99 });
    }

    const rows = await this.fetchJson<SdioInjury[]>(
      `Injuries/${season}REG/${week}`,
      `injury:sdio:${season}:${week}`,
      TTL.injuriesGameDay,
      opts?.force,
    );

    const observedAt = new Date().toISOString();
    const data = mapSportsDataIo(rows ?? [], depth, season, week, observedAt);

    return {
      data,
      source: "SportsDataIO",
      lastUpdated: observedAt,
      dataQuality: data.length === 0 ? "MISSING" : "OK",
      fromCache: false,
      stale: false,
    };
  }
}
