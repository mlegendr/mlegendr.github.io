/**
 * Fallback "market": the reference moneylines that ship inside the nflverse
 * schedule file.
 *
 * These are a single set of numbers (not a live multi-book consensus) and they
 * stop updating once a game is close, so the app labels this provider DEGRADED
 * and the blend gives it markedly less weight than a fresh Odds API consensus.
 * It exists so that a user with no API key still gets a usable market anchor
 * instead of nothing.
 */

import { buildConsensus } from "../../probability";
import type { CanonicalGame, CanonicalOdds } from "../../types";
import type { OddsProvider, ProviderResult } from "../types";

export function scheduleReferenceOdds(games: CanonicalGame[]): CanonicalOdds[] {
  const out: CanonicalOdds[] = [];
  for (const g of games) {
    if (g.refHomeMoneyline == null || g.refAwayMoneyline == null) continue;
    const consensus = buildConsensus({
      gameId: g.id,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      source: "schedule-reference",
      quotes: [
        {
          book: "nflverse reference line",
          homeMoneyline: g.refHomeMoneyline,
          awayMoneyline: g.refAwayMoneyline,
          spread: g.refSpreadLine != null ? -g.refSpreadLine : null,
          total: null,
          lastUpdate: null,
        },
      ],
    });
    if (consensus) out.push(consensus);
  }
  return out;
}

export class ScheduleReferenceOddsProvider implements OddsProvider {
  readonly id = "schedule-reference";
  readonly label = "nflverse reference line";

  isConfigured(): boolean {
    return true;
  }

  async getOdds(
    _season: number,
    games: CanonicalGame[],
  ): Promise<ProviderResult<CanonicalOdds[]>> {
    const data = scheduleReferenceOdds(games);
    return {
      data,
      source: "nflverse reference line (single book)",
      lastUpdated: new Date().toISOString(),
      dataQuality: "DEGRADED",
      fromCache: true,
      stale: false,
      message:
        "No live odds provider configured — using the single reference line shipped with the schedule.",
    };
  }
}
