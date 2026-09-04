/**
 * nflverse team statistics provider.
 *
 * Release asset: `stats_team/stats_team_week_{season}.csv` — one row per team per
 * game with EPA already aggregated (passing_epa, rushing_epa, attempts, carries).
 * A team's *defensive* EPA for a game is its opponent's offensive EPA in that
 * same game, so one small file gives both sides of the ball.
 *
 * Docs: https://github.com/nflverse/nflverse-data (release: `stats_team`).
 */

import "../../server-guard";
import { parseCsv, num } from "../../csv";
import { normalizeTeam } from "../../teams";
import type { TeamWeekStat } from "../../types";
import { cached, TTL } from "../../cache";
import { env } from "../../env";
import { fetchWithTimeout, ProviderError, type ProviderResult, type StatsProvider } from "../types";

export function teamStatsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
}

export function parseTeamWeekStats(csv: string, season: number): TeamWeekStat[] {
  const rows = parseCsv(csv);
  const out: TeamWeekStat[] = [];
  for (const r of rows) {
    if ((r.season_type ?? "REG").toUpperCase() !== "REG") continue;
    const team = normalizeTeam(r.team);
    const opponent = normalizeTeam(r.opponent_team);
    if (!team || !opponent) continue;
    const passEpa = num(r.passing_epa) ?? 0;
    const rushEpa = num(r.rushing_epa) ?? 0;
    const attempts = num(r.attempts) ?? 0;
    const sacks = num(r.sacks_suffered) ?? 0;
    const carries = num(r.carries) ?? 0;
    const dropbacks = attempts + sacks;
    const plays = dropbacks + carries;
    if (plays < 20) continue; // guard against partial rows
    out.push({
      season,
      week: Number(r.week) || 0,
      team,
      opponent,
      offEpaPerPlay: (passEpa + rushEpa) / plays,
      plays,
      passEpaPerDropback: dropbacks > 0 ? passEpa / dropbacks : 0,
      rushEpaPerCarry: carries > 0 ? rushEpa / carries : 0,
      successRate: null,
    });
  }
  return out;
}

export class NflverseStatsProvider implements StatsProvider {
  readonly id = "nflverse-stats";
  readonly label = "nflverse team stats";

  async getTeamWeekStats(
    season: number,
    opts?: { force?: boolean },
  ): Promise<ProviderResult<TeamWeekStat[]>> {
    if (env.offline) throw new ProviderError("OFFLINE_MODE is set", this.id);
    const res = await cached<TeamWeekStat[]>(
      `stats:nflverse:${season}`,
      TTL.teamStats,
      async () => {
        const r = await fetchWithTimeout(teamStatsUrl(season), { timeoutMs: 60_000 });
        if (r.status === 404) return []; // season has not started yet
        if (!r.ok) throw new ProviderError(`nflverse stats HTTP ${r.status}`, this.id, r.status);
        return parseTeamWeekStats(await r.text(), season);
      },
      { force: opts?.force },
    );
    return {
      data: res.value,
      source: "nflverse stats_team_week",
      lastUpdated: res.createdAt.toISOString(),
      dataQuality: res.stale ? "DEGRADED" : "OK",
      fromCache: res.fromCache,
      stale: res.stale,
    };
  }
}
