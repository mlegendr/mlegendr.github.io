/**
 * Open-Meteo weather provider (no API key required).
 *
 * Only outdoor stadiums are queried, and only inside a reliable forecast window
 * (Open-Meteo's hourly forecast runs ~16 days out). Beyond that the app reports
 * weather as unavailable rather than inventing a number.
 */

import "../../server-guard";
import { getTeam } from "../../teams";
import type { CanonicalGame, CanonicalWeather } from "../../types";
import { cached, TTL } from "../../cache";
import { env } from "../../env";
import { now } from "../../clock";
import { fetchWithTimeout, ProviderError, type ProviderResult, type WeatherProvider } from "../types";
import { isGameDay } from "../../schedule-utils";

const BASE = "https://api.open-meteo.com/v1/forecast";

/** Open-Meteo publishes ~16 days of hourly forecast. */
export const FORECAST_HORIZON_DAYS = 15;

/** Roof is taken from the schedule feed when present, else from stadium metadata. */
export function isIndoorGame(game: CanonicalGame): boolean {
  const roof = (game.roof ?? "").toLowerCase();
  if (roof === "dome" || roof === "closed") return true;
  if (roof === "outdoors" || roof === "open") return false;
  const meta = game.neutralSite ? null : getTeam(game.homeTeam);
  if (!meta) return false;
  // A retractable roof with no stated state is treated as open: assuming "closed"
  // would silently delete real weather risk.
  return meta.roofType === "dome";
}

export function isInsideForecastWindow(game: CanonicalGame, reference: Date = now()): boolean {
  const k = Date.parse(game.kickoff);
  if (!Number.isFinite(k)) return false;
  const days = (k - reference.getTime()) / 86_400_000;
  return days >= -1 && days <= FORECAST_HORIZON_DAYS;
}

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
    wind_gusts_10m?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
  };
}

function nearestHourIndex(times: string[], targetIso: string): number {
  const target = Date.parse(targetIso);
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns naive local-time strings; we request UTC explicitly.
    const t = Date.parse(`${times[i]}:00Z`.replace(/(:\d{2})?:00Z$/, ":00Z"));
    const d = Math.abs(t - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return bestDiff <= 3 * 3600 * 1000 ? best : -1;
}

export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly id = "open-meteo";
  readonly label = "Open-Meteo";

  isConfigured(): boolean {
    return env.weatherEnabled && !env.offline;
  }

  async getWeather(
    games: CanonicalGame[],
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalWeather[]>> {
    if (!this.isConfigured()) throw new ProviderError("Weather disabled", this.id);

    const reference = now();
    const eligible = games.filter((g) => isInsideForecastWindow(g, reference));
    const ttl = isGameDay(games, reference) ? TTL.weatherGameDay : TTL.weather;
    const out: CanonicalWeather[] = [];
    let observedAt = reference.toISOString();

    for (const game of eligible) {
      const indoor = isIndoorGame(game);
      if (indoor) {
        out.push({
          gameId: game.id,
          temperatureF: null,
          windMph: null,
          windGustMph: null,
          precipChance: null,
          precipInches: null,
          isIndoor: true,
          source: "stadium metadata",
          observedAt: reference.toISOString(),
        });
        continue;
      }

      const meta = getTeam(game.homeTeam);
      const day = game.kickoff.slice(0, 10);
      try {
        const res = await cached<OpenMeteoResponse>(
          `weather:${game.id}:${day}`,
          ttl,
          async () => {
            const url = new URL(BASE);
            url.searchParams.set("latitude", meta.stadiumLat.toFixed(4));
            url.searchParams.set("longitude", meta.stadiumLon.toFixed(4));
            url.searchParams.set(
              "hourly",
              "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation",
            );
            url.searchParams.set("temperature_unit", "fahrenheit");
            url.searchParams.set("wind_speed_unit", "mph");
            url.searchParams.set("precipitation_unit", "inch");
            url.searchParams.set("timezone", "UTC");
            url.searchParams.set("start_date", day);
            url.searchParams.set("end_date", day);
            const r = await fetchWithTimeout(url.toString(), { timeoutMs: 20_000 });
            if (!r.ok) throw new ProviderError(`Open-Meteo HTTP ${r.status}`, this.id, r.status);
            return (await r.json()) as OpenMeteoResponse;
          },
          { force: opts?.force },
        );
        observedAt = res.createdAt.toISOString();
        const h = res.value.hourly;
        const idx = h?.time ? nearestHourIndex(h.time, game.kickoff) : -1;
        if (idx < 0 || !h) continue;
        out.push({
          gameId: game.id,
          temperatureF: h.temperature_2m?.[idx] ?? null,
          windMph: h.wind_speed_10m?.[idx] ?? null,
          windGustMph: h.wind_gusts_10m?.[idx] ?? null,
          precipChance: h.precipitation_probability?.[idx] ?? null,
          precipInches: h.precipitation?.[idx] ?? null,
          isIndoor: false,
          source: "open-meteo",
          observedAt,
        });
      } catch {
        // One stadium failing must not blank the whole weather panel.
        continue;
      }
    }

    return {
      data: out,
      source: "Open-Meteo",
      lastUpdated: observedAt,
      dataQuality: out.length === 0 ? "MISSING" : "OK",
      fromCache: false,
      stale: false,
      message:
        eligible.length < games.length
          ? `${games.length - eligible.length} games are beyond the ${FORECAST_HORIZON_DAYS}-day forecast window.`
          : undefined,
    };
  }
}
