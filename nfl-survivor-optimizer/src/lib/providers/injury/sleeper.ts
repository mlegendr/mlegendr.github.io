/**
 * Sleeper injury provider — the free fallback when SportsDataIO is absent.
 *
 * GET https://api.sleeper.app/v1/players/nfl returns the entire NFL player
 * database (~10 MB). Sleeper explicitly asks callers to fetch it at most once a
 * day, so it is cached for 24 h and refreshed on an explicit "Refresh Data".
 *
 * Fields used: team, position, status, injury_status, injury_start_date,
 * practice_participation, depth_chart_position, depth_chart_order.
 */

import "../../server-guard";
import { normalizeTeam } from "../../teams";
import type { CanonicalInjury } from "../../types";
import { cached, TTL } from "../../cache";
import { env } from "../../env";
import { fetchWithTimeout, ProviderError, type InjuryProvider, type ProviderResult } from "../types";
import { normalizeStatus } from "./sportsdataio";

const URL_PLAYERS = "https://api.sleeper.app/v1/players/nfl";

export interface SleeperPlayer {
  full_name?: string;
  first_name?: string;
  last_name?: string;
  team?: string | null;
  position?: string | null;
  status?: string | null;
  injury_status?: string | null;
  injury_start_date?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
  active?: boolean;
}

/** Keep only the small subset we need, so the cached blob stays manageable. */
export function condenseSleeper(raw: Record<string, SleeperPlayer>): SleeperPlayer[] {
  const out: SleeperPlayer[] = [];
  for (const p of Object.values(raw ?? {})) {
    if (!p?.team) continue;
    const injured = normalizeStatus(p.injury_status ?? p.status);
    if (!injured || injured === "ACTIVE") continue;
    out.push({
      full_name: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
      team: p.team,
      position: p.position,
      status: p.status,
      injury_status: p.injury_status,
      injury_start_date: p.injury_start_date,
      injury_notes: p.injury_notes,
      practice_participation: p.practice_participation,
      depth_chart_position: p.depth_chart_position,
      depth_chart_order: p.depth_chart_order,
    });
  }
  return out;
}

export function mapSleeper(
  players: SleeperPlayer[],
  season: number,
  week: number,
  observedAt: string,
): CanonicalInjury[] {
  const out: CanonicalInjury[] = [];
  for (const p of players) {
    const team = normalizeTeam(p.team ?? null);
    const status = normalizeStatus(p.injury_status ?? p.status);
    const name = (p.full_name ?? "").trim();
    if (!team || !status || status === "ACTIVE" || !name) continue;
    out.push({
      season,
      week,
      team,
      playerName: name,
      position: (p.position ?? "UNK").toUpperCase(),
      status,
      practiceParticipation: p.practice_participation ?? null,
      depthChartRank: p.depth_chart_order ?? null,
      isStarter: (p.depth_chart_order ?? 99) === 1,
      note: p.injury_notes ?? (p.injury_start_date ? `Since ${p.injury_start_date}` : null),
      source: "sleeper",
      manualOverride: false,
      observedAt,
    });
  }
  return out;
}

export class SleeperInjuryProvider implements InjuryProvider {
  readonly id = "sleeper";
  readonly label = "Sleeper";

  isConfigured(): boolean {
    return env.sleeperEnabled && !env.offline;
  }

  async getInjuries(
    season: number,
    week: number,
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalInjury[]>> {
    if (!this.isConfigured()) throw new ProviderError("Sleeper fallback disabled", this.id);

    const res = await cached<SleeperPlayer[]>(
      "injury:sleeper:players",
      TTL.playerDatabase,
      async () => {
        const r = await fetchWithTimeout(URL_PLAYERS, { timeoutMs: 90_000 });
        if (!r.ok) throw new ProviderError(`Sleeper HTTP ${r.status}`, this.id, r.status);
        return condenseSleeper((await r.json()) as Record<string, SleeperPlayer>);
      },
      { force: opts?.force },
    );

    const observedAt = res.createdAt.toISOString();
    return {
      data: mapSleeper(res.value, season, week, observedAt),
      source: "Sleeper player database",
      lastUpdated: observedAt,
      // Sleeper has no per-week report, so designations can lag the official one.
      dataQuality: res.stale ? "DEGRADED" : "OK",
      fromCache: res.fromCache,
      stale: res.stale,
      message: "Sleeper has no weekly report; designations may lag the official injury report.",
    };
  }
}
