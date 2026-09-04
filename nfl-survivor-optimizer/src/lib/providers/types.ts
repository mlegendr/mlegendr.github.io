/**
 * Provider contracts.
 *
 * Every external feed is reached through one of these interfaces and returns
 * canonical objects only. Nothing outside `src/lib/providers` may know that a
 * given number came from The Odds API rather than a CSV — swapping a provider is
 * meant to be a one-file change.
 */

import type {
  CanonicalGame,
  CanonicalInjury,
  CanonicalOdds,
  CanonicalWeather,
  DataQuality,
  TeamWeekStat,
} from "../types";

export interface ProviderResult<T> {
  data: T;
  source: string;
  /** When the underlying observation was made (not when we asked for it). */
  lastUpdated: string;
  dataQuality: DataQuality;
  fromCache: boolean;
  stale: boolean;
  message?: string;
}

export interface ScheduleProvider {
  readonly id: string;
  readonly label: string;
  getSchedule(season: number, opts?: { force?: boolean }): Promise<ProviderResult<CanonicalGame[]>>;
}

export interface OddsProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  getOdds(
    season: number,
    games: CanonicalGame[],
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalOdds[]>>;
}

export interface InjuryProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  getInjuries(
    season: number,
    week: number,
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalInjury[]>>;
}

export interface WeatherProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  getWeather(
    games: CanonicalGame[],
    opts?: { force?: boolean },
  ): Promise<ProviderResult<CanonicalWeather[]>>;
}

export interface StatsProvider {
  readonly id: string;
  readonly label: string;
  getTeamWeekStats(
    season: number,
    opts?: { force?: boolean },
  ): Promise<ProviderResult<TeamWeekStat[]>>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Small fetch wrapper with a timeout — a hung provider must not hang the page. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}
