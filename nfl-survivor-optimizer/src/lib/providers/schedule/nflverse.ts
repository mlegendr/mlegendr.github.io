/**
 * nflverse schedule provider.
 *
 * nflverse publishes the canonical `games.csv` (the old "nflfastR schedules"
 * file) as a GitHub release asset that is refreshed continuously through the
 * season — scores, rest days, kickoff times, roof/surface and the reference
 * moneylines that shipped with the schedule.
 *
 * Docs: https://github.com/nflverse/nflverse-data (release: `schedules`).
 */

import "../../server-guard";
import { parseCsv, bool, int, num } from "../../csv";
import { normalizeTeam } from "../../teams";
import type { CanonicalGame, SeasonType } from "../../types";
import { cached, TTL } from "../../cache";
import { env } from "../../env";
import { fetchWithTimeout, ProviderError, type ProviderResult, type ScheduleProvider } from "../types";

export const NFLVERSE_SCHEDULE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

/** Combine nflverse's `gameday` (local date) and `gametime` (ET) into UTC. */
function toKickoffIso(gameday: string, gametime: string): string {
  const date = (gameday || "").trim();
  if (!date) return new Date(0).toISOString();
  const time = (gametime || "").trim() || "13:00";
  // nflverse gametime is US Eastern. EDT (UTC-4) covers weeks 1-9ish, EST
  // (UTC-5) the rest; pick by date so kickoff-lock logic is right year-round.
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const isEdt = month > 3 && (month < 11 || (month === 11 && day < 2));
  const offset = isEdt ? "-04:00" : "-05:00";
  const iso = `${date}T${time.length === 5 ? time : "13:00"}:00${offset}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(`${date}T18:00:00Z`).toISOString();
}

export function parseNflverseGames(csv: string, season: number): CanonicalGame[] {
  const rows = parseCsv(csv);
  const out: CanonicalGame[] = [];
  for (const r of rows) {
    if (int(r.season) !== season) continue;
    const type = (r.game_type || "REG").toUpperCase();
    const seasonType: SeasonType = type === "REG" ? "REG" : "POST";
    const home = normalizeTeam(r.home_team);
    const away = normalizeTeam(r.away_team);
    if (!home || !away) continue; // never guess: an unmapped team is dropped loudly upstream

    const homeScore = int(r.home_score);
    const awayScore = int(r.away_score);
    const location = (r.location || "Home").trim();

    out.push({
      id: r.game_id,
      season,
      week: int(r.week) ?? 0,
      seasonType,
      kickoff: toKickoffIso(r.gameday, r.gametime),
      homeTeam: home,
      awayTeam: away,
      neutralSite: location.toLowerCase() === "neutral",
      stadium: r.stadium || null,
      roof: r.roof || null,
      surface: r.surface || null,
      divisionGame: bool(r.div_game),
      homeRest: int(r.home_rest),
      awayRest: int(r.away_rest),
      homeScore,
      awayScore,
      completed: homeScore != null && awayScore != null,
      overtime: bool(r.overtime),
      refHomeMoneyline: int(r.home_moneyline),
      refAwayMoneyline: int(r.away_moneyline),
      refSpreadLine: num(r.spread_line),
    });
  }
  out.sort((a, b) => a.week - b.week || a.kickoff.localeCompare(b.kickoff));
  return out;
}

export class NflverseScheduleProvider implements ScheduleProvider {
  readonly id = "nflverse";
  readonly label = "nflverse";

  async getSchedule(season: number, opts?: { force?: boolean }): Promise<ProviderResult<CanonicalGame[]>> {
    if (env.offline) {
      throw new ProviderError("OFFLINE_MODE is set; refusing outbound schedule fetch", this.id);
    }
    const res = await cached<CanonicalGame[]>(
      `schedule:nflverse:${season}`,
      TTL.schedule,
      async () => {
        const r = await fetchWithTimeout(NFLVERSE_SCHEDULE_URL, { timeoutMs: 60_000 });
        if (!r.ok) throw new ProviderError(`nflverse schedule HTTP ${r.status}`, this.id, r.status);
        const games = parseNflverseGames(await r.text(), season);
        if (games.length === 0) {
          throw new ProviderError(`nflverse returned no ${season} games`, this.id);
        }
        return games;
      },
      { force: opts?.force },
    );

    return {
      data: res.value,
      source: "nflverse games.csv",
      lastUpdated: res.createdAt.toISOString(),
      dataQuality: res.stale ? "DEGRADED" : "OK",
      fromCache: res.fromCache,
      stale: res.stale,
      message: res.stale ? "Served from a stale cache: nflverse fetch failed." : undefined,
    };
  }
}
