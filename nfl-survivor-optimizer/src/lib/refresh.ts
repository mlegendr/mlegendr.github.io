/**
 * Provider refresh orchestration.
 *
 * Every outbound fetch in the app funnels through here so that (a) failures
 * downgrade a single provider instead of breaking the page, and (b) the Data
 * Status panel always reflects what actually happened. A provider that fails is
 * recorded as DEGRADED — we never silently serve stale data as if it were fresh.
 */

import "./server-guard";
import { prisma } from "./db";
import { now } from "./clock";
import { env } from "./env";
import { TEAMS } from "./teams";
import { scoreInjury } from "./injuries";
import type { CanonicalGame, CanonicalInjury } from "./types";
import { NflverseScheduleProvider } from "./providers/schedule/nflverse";
import { TheOddsApiProvider } from "./providers/odds/theOddsApi";
import { ScheduleReferenceOddsProvider } from "./providers/odds/scheduleReference";
import { SportsDataIoInjuryProvider } from "./providers/injury/sportsdataio";
import { SleeperInjuryProvider } from "./providers/injury/sleeper";
import { OpenMeteoWeatherProvider } from "./providers/weather/openMeteo";
import { NflverseStatsProvider } from "./providers/stats/nflverse";
import { detectCurrentWeek } from "./schedule-utils";
import { loadModelArtifact } from "./model/artifact";

export type ProviderKey = "schedule" | "odds" | "injuries" | "weather" | "stats" | "model";

export interface RefreshOutcome {
  key: ProviderKey;
  ok: boolean;
  degraded: boolean;
  provider: string;
  label: string;
  message: string | null;
  detail: Record<string, unknown>;
  records: number;
}

async function recordStatus(o: RefreshOutcome): Promise<void> {
  const ts = now();
  await prisma.providerStatus.upsert({
    where: { id: o.key },
    create: {
      id: o.key,
      provider: o.provider,
      label: o.label,
      ok: o.ok,
      degraded: o.degraded,
      message: o.message,
      detailJson: JSON.stringify(o.detail),
      lastAttempt: ts,
      lastSuccess: o.ok ? ts : null,
    },
    update: {
      provider: o.provider,
      label: o.label,
      ok: o.ok,
      degraded: o.degraded,
      message: o.message,
      detailJson: JSON.stringify(o.detail),
      lastAttempt: ts,
      ...(o.ok ? { lastSuccess: ts } : {}),
    },
  });
}

/** Ensure the 32 canonical teams exist. Idempotent; safe to call on every boot. */
export async function ensureTeams(): Promise<void> {
  const count = await prisma.team.count();
  if (count === TEAMS.length) return;
  for (const t of TEAMS) {
    await prisma.team.upsert({
      where: { abbr: t.abbr },
      create: {
        abbr: t.abbr,
        name: t.name,
        location: t.location,
        nickname: t.nickname,
        conference: t.conference,
        division: t.division,
        primary: t.primary,
        secondary: t.secondary,
        stadium: t.stadium,
        stadiumLat: t.stadiumLat,
        stadiumLon: t.stadiumLon,
        roofType: t.roofType,
      },
      update: {
        name: t.name,
        stadium: t.stadium,
        stadiumLat: t.stadiumLat,
        stadiumLon: t.stadiumLon,
        roofType: t.roofType,
      },
    });
  }
}

export async function persistGames(games: CanonicalGame[], source: string): Promise<number> {
  let n = 0;
  for (const g of games) {
    await prisma.game.upsert({
      where: { id: g.id },
      create: {
        id: g.id,
        season: g.season,
        week: g.week,
        seasonType: g.seasonType,
        kickoff: new Date(g.kickoff),
        homeTeamAbbr: g.homeTeam,
        awayTeamAbbr: g.awayTeam,
        neutralSite: g.neutralSite,
        stadium: g.stadium,
        roof: g.roof,
        surface: g.surface,
        divisionGame: g.divisionGame,
        homeRest: g.homeRest,
        awayRest: g.awayRest,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        completed: g.completed,
        overtime: g.overtime,
        refHomeMoneyline: g.refHomeMoneyline,
        refAwayMoneyline: g.refAwayMoneyline,
        refSpreadLine: g.refSpreadLine,
        source,
        observedAt: now(),
      },
      update: {
        week: g.week,
        kickoff: new Date(g.kickoff),
        neutralSite: g.neutralSite,
        stadium: g.stadium,
        roof: g.roof,
        surface: g.surface,
        homeRest: g.homeRest,
        awayRest: g.awayRest,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        completed: g.completed,
        overtime: g.overtime,
        refHomeMoneyline: g.refHomeMoneyline,
        refAwayMoneyline: g.refAwayMoneyline,
        refSpreadLine: g.refSpreadLine,
        source,
        observedAt: now(),
      },
    });
    n += 1;
  }
  return n;
}

export async function refreshSchedule(season: number, force: boolean): Promise<RefreshOutcome> {
  const provider = new NflverseScheduleProvider();
  try {
    const res = await provider.getSchedule(season, { force });
    await ensureTeams();
    const n = await persistGames(res.data, res.source);
    const outcome: RefreshOutcome = {
      key: "schedule",
      ok: true,
      degraded: res.dataQuality !== "OK",
      provider: provider.id,
      label: provider.label,
      message: res.message ?? null,
      detail: { games: n, lastUpdated: res.lastUpdated, fromCache: res.fromCache },
      records: n,
    };
    await recordStatus(outcome);
    return outcome;
  } catch (err) {
    const existing = await prisma.game.count({ where: { season } });
    const outcome: RefreshOutcome = {
      key: "schedule",
      ok: false,
      degraded: true,
      provider: provider.id,
      label: provider.label,
      message: (err as Error).message,
      detail: { gamesInDatabase: existing },
      records: 0,
    };
    await recordStatus(outcome);
    return outcome;
  }
}

export async function refreshOdds(season: number, force: boolean): Promise<RefreshOutcome> {
  const games = await loadCanonicalGames(season);
  const upcoming = games.filter((g) => !g.completed);
  const live = new TheOddsApiProvider();
  const fallback = new ScheduleReferenceOddsProvider();

  const attempt = async (provider: TheOddsApiProvider | ScheduleReferenceOddsProvider) => {
    const res = await provider.getOdds(season, upcoming, { force });
    let n = 0;
    for (const o of res.data) {
      await prisma.oddsSnapshot.create({
        data: {
          gameId: o.gameId,
          homeWinProbability: o.consensusHomeWinProbability,
          awayWinProbability: o.consensusAwayWinProbability,
          bookCount: o.bookCount,
          homeMoneyline: o.homeMoneyline,
          awayMoneyline: o.awayMoneyline,
          spread: o.spread,
          total: o.total,
          dispersion: o.dispersion,
          source: o.source,
          oddsLastUpdated: new Date(o.oddsLastUpdated),
          observedAt: now(),
        },
      });
      n += 1;
    }
    return { res, n };
  };

  if (live.isConfigured()) {
    try {
      const { res, n } = await attempt(live);
      const outcome: RefreshOutcome = {
        key: "odds",
        ok: true,
        degraded: res.dataQuality !== "OK",
        provider: live.id,
        label: live.label,
        message: res.message ?? null,
        detail: {
          games: n,
          books: res.data[0]?.bookCount ?? 0,
          lastUpdated: res.lastUpdated,
        },
        records: n,
      };
      await recordStatus(outcome);
      return outcome;
    } catch (err) {
      // fall through to the reference line rather than showing no market at all
      const { res, n } = await attempt(fallback);
      const outcome: RefreshOutcome = {
        key: "odds",
        ok: false,
        degraded: true,
        provider: fallback.id,
        label: `${fallback.label} (fallback)`,
        message: `The Odds API failed: ${(err as Error).message}. Using the schedule reference line.`,
        detail: { games: n, lastUpdated: res.lastUpdated },
        records: n,
      };
      await recordStatus(outcome);
      return outcome;
    }
  }

  const { res, n } = await attempt(fallback);
  const outcome: RefreshOutcome = {
    key: "odds",
    ok: true,
    degraded: true,
    provider: fallback.id,
    label: fallback.label,
    message: res.message ?? null,
    detail: { games: n, lastUpdated: res.lastUpdated, reason: "ODDS_API_KEY not configured" },
    records: n,
  };
  await recordStatus(outcome);
  return outcome;
}

export async function refreshInjuries(
  season: number,
  week: number,
  force: boolean,
): Promise<RefreshOutcome> {
  const sdio = new SportsDataIoInjuryProvider();
  const sleeper = new SleeperInjuryProvider();
  const chain = [sdio, sleeper].filter((p) => p.isConfigured());

  const errors: string[] = [];
  for (const provider of chain) {
    try {
      const res = await provider.getInjuries(season, week, { force });
      await persistInjuries(res.data, season, week, provider.id);
      const outcome: RefreshOutcome = {
        key: "injuries",
        ok: true,
        degraded: res.dataQuality !== "OK" || provider.id === "sleeper",
        provider: provider.id,
        label: provider.label,
        message: res.message ?? (errors.length ? errors.join(" ") : null),
        detail: { players: res.data.length, lastUpdated: res.lastUpdated },
        records: res.data.length,
      };
      await recordStatus(outcome);
      return outcome;
    } catch (err) {
      errors.push(`${provider.label}: ${(err as Error).message}`);
    }
  }

  const manual = await prisma.injuryReport.count({
    where: { season, week, manualOverride: true },
  });
  const outcome: RefreshOutcome = {
    key: "injuries",
    ok: false,
    degraded: true,
    provider: "none",
    label: "No injury provider",
    message:
      errors.join(" ") ||
      "No injury provider is configured. Add SPORTSDATAIO_API_KEY, enable Sleeper, or enter injuries manually.",
    detail: { manualOverrides: manual },
    records: manual,
  };
  await recordStatus(outcome);
  return outcome;
}

async function persistInjuries(
  injuries: CanonicalInjury[],
  season: number,
  week: number,
  source: string,
): Promise<void> {
  // Provider rows are replaced wholesale; manual overrides are never touched.
  await prisma.injuryReport.deleteMany({
    where: { season, week, manualOverride: false, source },
  });
  for (const i of injuries) {
    const scored = scoreInjury(i);
    await prisma.injuryReport.create({
      data: {
        season,
        week,
        teamAbbr: scored.team,
        playerName: scored.playerName,
        position: scored.position,
        status: scored.status,
        practiceParticipation: scored.practiceParticipation,
        depthChartRank: scored.depthChartRank,
        isStarter: scored.isStarter,
        note: scored.note,
        impact: scored.impact,
        impactScore: scored.impactScore,
        source,
        manualOverride: false,
        observedAt: new Date(scored.observedAt),
      },
    });
  }
}

export async function refreshWeather(season: number, force: boolean): Promise<RefreshOutcome> {
  const provider = new OpenMeteoWeatherProvider();
  if (!provider.isConfigured()) {
    const outcome: RefreshOutcome = {
      key: "weather",
      ok: true,
      degraded: true,
      provider: provider.id,
      label: provider.label,
      message: "Weather is disabled (ENABLE_WEATHER=0 or OFFLINE_MODE=1).",
      detail: {},
      records: 0,
    };
    await recordStatus(outcome);
    return outcome;
  }
  const games = (await loadCanonicalGames(season)).filter((g) => !g.completed);
  try {
    const res = await provider.getWeather(games, { force });
    for (const w of res.data) {
      await prisma.weatherSnapshot.create({
        data: {
          gameId: w.gameId,
          temperatureF: w.temperatureF,
          windMph: w.windMph,
          windGustMph: w.windGustMph,
          precipChance: w.precipChance,
          precipInches: w.precipInches,
          isIndoor: w.isIndoor,
          source: w.source,
          observedAt: new Date(w.observedAt),
        },
      });
    }
    const outcome: RefreshOutcome = {
      key: "weather",
      ok: true,
      degraded: res.dataQuality !== "OK",
      provider: provider.id,
      label: provider.label,
      message: res.message ?? null,
      detail: { games: res.data.length, lastUpdated: res.lastUpdated },
      records: res.data.length,
    };
    await recordStatus(outcome);
    return outcome;
  } catch (err) {
    const outcome: RefreshOutcome = {
      key: "weather",
      ok: false,
      degraded: true,
      provider: provider.id,
      label: provider.label,
      message: (err as Error).message,
      detail: {},
      records: 0,
    };
    await recordStatus(outcome);
    return outcome;
  }
}

export async function refreshStats(season: number, force: boolean): Promise<RefreshOutcome> {
  const provider = new NflverseStatsProvider();
  try {
    const res = await provider.getTeamWeekStats(season, { force });
    const outcome: RefreshOutcome = {
      key: "stats",
      ok: true,
      degraded: res.dataQuality !== "OK",
      provider: provider.id,
      label: provider.label,
      message:
        res.data.length === 0
          ? "No completed games yet this season — the model is running on preseason priors."
          : null,
      detail: { teamWeeks: res.data.length, lastUpdated: res.lastUpdated },
      records: res.data.length,
    };
    await recordStatus(outcome);
    return outcome;
  } catch (err) {
    const outcome: RefreshOutcome = {
      key: "stats",
      ok: false,
      degraded: true,
      provider: provider.id,
      label: provider.label,
      message: (err as Error).message,
      detail: {},
      records: 0,
    };
    await recordStatus(outcome);
    return outcome;
  }
}

export async function recordModelStatus(): Promise<RefreshOutcome> {
  const artifact = await loadModelArtifact(true);
  const outcome: RefreshOutcome = {
    key: "model",
    ok: !artifact.isFallback,
    degraded: artifact.isFallback === true,
    provider: "local artifact",
    label: "Team model",
    message: artifact.isFallback
      ? "data/model/model.json is missing — running on built-in default parameters. Run `npm run train`."
      : null,
    detail: {
      trainedAt: artifact.trainedAt,
      trainSeasons: artifact.trainSeasons,
      holdoutSeasons: artifact.holdoutSeasons,
    },
    records: Object.keys(artifact.priors).length,
  };
  await recordStatus(outcome);
  return outcome;
}

/** Read the persisted schedule back out in canonical form. */
export async function loadCanonicalGames(season: number): Promise<CanonicalGame[]> {
  const rows = await prisma.game.findMany({
    where: { season },
    orderBy: [{ week: "asc" }, { kickoff: "asc" }],
  });
  return rows.map((g) => ({
    id: g.id,
    season: g.season,
    week: g.week,
    seasonType: g.seasonType === "POST" ? "POST" : "REG",
    kickoff: g.kickoff.toISOString(),
    homeTeam: g.homeTeamAbbr,
    awayTeam: g.awayTeamAbbr,
    neutralSite: g.neutralSite,
    stadium: g.stadium,
    roof: g.roof,
    surface: g.surface,
    divisionGame: g.divisionGame,
    homeRest: g.homeRest,
    awayRest: g.awayRest,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    completed: g.completed,
    overtime: g.overtime,
    refHomeMoneyline: g.refHomeMoneyline,
    refAwayMoneyline: g.refAwayMoneyline,
    refSpreadLine: g.refSpreadLine,
  }));
}

export interface RefreshReport {
  startedAt: string;
  finishedAt: string;
  season: number;
  week: number;
  offline: boolean;
  outcomes: RefreshOutcome[];
  degraded: boolean;
}

/** Refresh every provider. Individual failures degrade, they do not throw. */
export async function refreshAll(
  season: number,
  opts: { force?: boolean; week?: number } = {},
): Promise<RefreshReport> {
  const startedAt = now().toISOString();
  const force = opts.force ?? false;

  await ensureTeams();
  const schedule = await refreshSchedule(season, force);
  const games = await loadCanonicalGames(season);
  const week = opts.week ?? detectCurrentWeek(games);

  const [odds, injuries, weather, stats, model] = await Promise.all([
    refreshOdds(season, force),
    refreshInjuries(season, week, force),
    refreshWeather(season, force),
    refreshStats(season, force),
    recordModelStatus(),
  ]);

  const outcomes = [schedule, odds, injuries, weather, stats, model];
  return {
    startedAt,
    finishedAt: now().toISOString(),
    season,
    week,
    offline: env.offline,
    outcomes,
    degraded: outcomes.some((o) => !o.ok || o.degraded),
  };
}
