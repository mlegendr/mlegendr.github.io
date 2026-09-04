/**
 * The Odds API provider (https://the-odds-api.com).
 *
 * Endpoint: GET /v4/sports/americanfootball_nfl/odds
 *   regions=us, markets=h2h,spreads,totals, oddsFormat=american
 *
 * We deliberately aggregate *all* returned books rather than trusting one: a
 * single stale or outlier book can move a de-vigged probability by several
 * points, and survivor decisions are made on probability magnitudes.
 *
 * The API key is read from the server environment and never leaves the server.
 */

import "../../server-guard";
import { buildConsensus } from "../../probability";
import { normalizeTeam } from "../../teams";
import type { BookQuote, CanonicalGame, CanonicalOdds } from "../../types";
import { cached, TTL } from "../../cache";
import { env, hasOddsApi } from "../../env";
import { fetchWithTimeout, ProviderError, type OddsProvider, type ProviderResult } from "../types";
import { isGameDay } from "../../schedule-utils";

const BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}
interface OddsApiMarket {
  key: string;
  last_update?: string;
  outcomes: OddsApiOutcome[];
}
interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets: OddsApiMarket[];
}
export interface OddsApiEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

/** Turn one API event into the per-book quotes the consensus builder wants. */
export function eventToQuotes(event: OddsApiEvent): {
  home: string | null;
  away: string | null;
  quotes: BookQuote[];
} {
  const home = normalizeTeam(event.home_team);
  const away = normalizeTeam(event.away_team);
  const quotes: BookQuote[] = [];

  for (const bk of event.bookmakers ?? []) {
    let homeMl: number | null = null;
    let awayMl: number | null = null;
    let spread: number | null = null;
    let total: number | null = null;

    for (const m of bk.markets ?? []) {
      if (m.key === "h2h") {
        for (const o of m.outcomes ?? []) {
          const t = normalizeTeam(o.name);
          if (t && t === home) homeMl = o.price;
          else if (t && t === away) awayMl = o.price;
        }
      } else if (m.key === "spreads") {
        for (const o of m.outcomes ?? []) {
          const t = normalizeTeam(o.name);
          if (t && t === home && o.point != null) spread = o.point;
        }
      } else if (m.key === "totals") {
        const over = (m.outcomes ?? []).find((o) => o.name?.toLowerCase() === "over");
        if (over?.point != null) total = over.point;
      }
    }

    quotes.push({
      book: bk.title || bk.key,
      homeMoneyline: homeMl,
      awayMoneyline: awayMl,
      spread,
      total,
      lastUpdate: bk.last_update ?? null,
    });
  }

  return { home, away, quotes };
}

/** Join API events onto our schedule by (home, away) plus a 3-day kickoff window. */
export function matchEventsToGames(events: OddsApiEvent[], games: CanonicalGame[]): CanonicalOdds[] {
  const out: CanonicalOdds[] = [];
  for (const ev of events) {
    const { home, away, quotes } = eventToQuotes(ev);
    if (!home || !away) continue;
    const commence = Date.parse(ev.commence_time);
    const game = games.find(
      (g) =>
        g.homeTeam === home &&
        g.awayTeam === away &&
        Math.abs(Date.parse(g.kickoff) - commence) < 3 * 24 * 3600 * 1000,
    );
    if (!game) continue;
    const consensus = buildConsensus({
      gameId: game.id,
      homeTeam: home,
      awayTeam: away,
      quotes,
      source: "the-odds-api",
      method: "median",
    });
    if (consensus) out.push(consensus);
  }
  return out;
}

export class TheOddsApiProvider implements OddsProvider {
  readonly id = "the-odds-api";
  readonly label = "The Odds API";

  isConfigured(): boolean {
    return hasOddsApi();
  }

  async getOdds(
    season: number,
    games: CanonicalGame[],
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalOdds[]>> {
    if (!this.isConfigured()) {
      throw new ProviderError("ODDS_API_KEY is not configured", this.id);
    }
    const ttl = isGameDay(games) ? TTL.oddsGameDay : TTL.odds;

    const res = await cached<{ events: OddsApiEvent[]; remaining: string | null }>(
      `odds:the-odds-api:${season}`,
      ttl,
      async () => {
        const url = new URL(BASE);
        url.searchParams.set("apiKey", env.oddsApiKey);
        url.searchParams.set("regions", "us");
        url.searchParams.set("markets", "h2h,spreads,totals");
        url.searchParams.set("oddsFormat", "american");
        url.searchParams.set("dateFormat", "iso");
        const r = await fetchWithTimeout(url.toString(), { timeoutMs: 30_000 });
        if (!r.ok) {
          throw new ProviderError(
            `The Odds API HTTP ${r.status}${r.status === 401 ? " (bad API key)" : ""}`,
            this.id,
            r.status,
          );
        }
        return {
          events: (await r.json()) as OddsApiEvent[],
          remaining: r.headers.get("x-requests-remaining"),
        };
      },
      { force: opts?.force },
    );

    const odds = matchEventsToGames(res.value.events ?? [], games);
    const latest = odds.reduce<number>(
      (acc, o) => Math.max(acc, Date.parse(o.oddsLastUpdated) || 0),
      0,
    );

    return {
      data: odds,
      source: "The Odds API",
      lastUpdated: new Date(latest || res.createdAt.getTime()).toISOString(),
      dataQuality: res.stale ? "DEGRADED" : odds.length === 0 ? "MISSING" : "OK",
      fromCache: res.fromCache,
      stale: res.stale,
      message: res.value.remaining ? `${res.value.remaining} API requests remaining` : undefined,
    };
  }
}
