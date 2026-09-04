/**
 * Server-only environment access.
 *
 * Nothing in here may be imported from a client component: these values include
 * third-party API keys, which must never reach browser JavaScript. The UI learns
 * which providers are configured through `/api/status`, which returns booleans
 * only.
 */

import "./server-guard";

export const env = {
  season: Number(process.env.NFL_SEASON ?? 2026),
  oddsApiKey: (process.env.ODDS_API_KEY ?? "").trim(),
  sportsDataIoKey: (process.env.SPORTSDATAIO_API_KEY ?? "").trim(),
  sleeperEnabled: (process.env.ENABLE_SLEEPER_FALLBACK ?? "1") !== "0",
  weatherEnabled: (process.env.ENABLE_WEATHER ?? "1") !== "0",
  offline: (process.env.OFFLINE_MODE ?? "0") === "1",
  appClock: (process.env.APP_CLOCK ?? "").trim(),
};

export function hasOddsApi(): boolean {
  return env.oddsApiKey.length > 0 && !env.offline;
}

export function hasSportsDataIo(): boolean {
  return env.sportsDataIoKey.length > 0 && !env.offline;
}

/** Booleans only — safe to hand to the browser. */
export function providerAvailability() {
  return {
    theOddsApi: hasOddsApi(),
    sportsDataIo: hasSportsDataIo(),
    sleeper: env.sleeperEnabled && !env.offline,
    weather: env.weatherEnabled && !env.offline,
    nflverse: !env.offline,
    offline: env.offline,
  };
}
