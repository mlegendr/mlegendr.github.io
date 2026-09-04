/**
 * Manual overrides.
 *
 * The app must stay usable when a provider is down or plainly wrong, so the user
 * can pin a win probability, a spread, a moneyline, the current week, or an
 * injury. Every override is stored with its scope and is reversible, and every
 * value it touches is labelled "Manual Override" in the UI.
 */

import "./server-guard";
import { prisma } from "./db";

export type OverrideScope =
  | "WIN_PROBABILITY"
  | "SPREAD"
  | "MONEYLINE"
  | "INJURY"
  | "CURRENT_WEEK";

export interface OverrideRecord {
  id: string;
  season: number;
  week: number | null;
  scope: OverrideScope;
  gameId: string | null;
  teamAbbr: string | null;
  value: Record<string, unknown>;
  note: string | null;
  active: boolean;
  updatedAt: string;
}

export interface OverrideBundle {
  /** `${team}:${week}` -> probability in [0,1] that this team wins that week. */
  winProbability: Map<string, { prob: number; note: string | null }>;
  /** gameId -> spread from the home team's perspective (negative == home favoured). */
  spread: Map<string, { spread: number; note: string | null }>;
  /** gameId -> { home, away } American moneylines. */
  moneyline: Map<string, { home: number; away: number; note: string | null }>;
  currentWeek: number | null;
  all: OverrideRecord[];
}

function toRecord(row: {
  id: string;
  season: number;
  week: number | null;
  scope: string;
  gameId: string | null;
  teamAbbr: string | null;
  valueJson: string;
  note: string | null;
  active: boolean;
  updatedAt: Date;
}): OverrideRecord {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(row.valueJson) as Record<string, unknown>;
  } catch {
    value = {};
  }
  return {
    id: row.id,
    season: row.season,
    week: row.week,
    scope: row.scope as OverrideScope,
    gameId: row.gameId,
    teamAbbr: row.teamAbbr,
    value,
    note: row.note,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadOverrides(season: number): Promise<OverrideBundle> {
  const rows = await prisma.manualOverride.findMany({
    where: { season, active: true },
    orderBy: { updatedAt: "desc" },
  });
  const all = rows.map(toRecord);

  const bundle: OverrideBundle = {
    winProbability: new Map(),
    spread: new Map(),
    moneyline: new Map(),
    currentWeek: null,
    all,
  };

  for (const o of all) {
    if (o.scope === "WIN_PROBABILITY" && o.teamAbbr && o.week != null) {
      const p = Number(o.value.probability);
      if (Number.isFinite(p) && p > 0 && p < 1) {
        bundle.winProbability.set(`${o.teamAbbr}:${o.week}`, { prob: p, note: o.note });
      }
    } else if (o.scope === "SPREAD" && o.gameId) {
      const s = Number(o.value.spread);
      if (Number.isFinite(s)) bundle.spread.set(o.gameId, { spread: s, note: o.note });
    } else if (o.scope === "MONEYLINE" && o.gameId) {
      const h = Number(o.value.home);
      const a = Number(o.value.away);
      if (Number.isFinite(h) && Number.isFinite(a)) {
        bundle.moneyline.set(o.gameId, { home: h, away: a, note: o.note });
      }
    } else if (o.scope === "CURRENT_WEEK") {
      const w = Number(o.value.week);
      if (Number.isFinite(w)) bundle.currentWeek = w;
    }
  }

  return bundle;
}

export async function listOverrides(season: number): Promise<OverrideRecord[]> {
  const rows = await prisma.manualOverride.findMany({
    where: { season },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toRecord);
}

export async function upsertOverride(input: {
  season: number;
  week?: number | null;
  scope: OverrideScope;
  gameId?: string | null;
  teamAbbr?: string | null;
  value: Record<string, unknown>;
  note?: string | null;
}): Promise<OverrideRecord> {
  const existing = await prisma.manualOverride.findFirst({
    where: {
      season: input.season,
      week: input.week ?? null,
      scope: input.scope,
      gameId: input.gameId ?? null,
      teamAbbr: input.teamAbbr ?? null,
    },
  });
  const data = {
    season: input.season,
    week: input.week ?? null,
    scope: input.scope,
    gameId: input.gameId ?? null,
    teamAbbr: input.teamAbbr ?? null,
    valueJson: JSON.stringify(input.value),
    note: input.note ?? null,
    active: true,
  };
  const row = existing
    ? await prisma.manualOverride.update({ where: { id: existing.id }, data })
    : await prisma.manualOverride.create({ data });
  return toRecord(row);
}

export async function deleteOverride(id: string): Promise<void> {
  await prisma.manualOverride.delete({ where: { id } }).catch(() => undefined);
}
