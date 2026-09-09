/**
 * CSV import of pool-entry pick history.
 *
 * Accepts a long format (`entry,week,team`, optionally with `owner`) and a wide
 * format (`entry,week1,week2,...`). Nothing is ever silently dropped: every row
 * that cannot be used produces an issue the preview shows before you commit.
 */

import { parseCsv, parseCsvRows } from "../csv";
import { normalizeTeam } from "../teams";
import type { ImportIssue, ImportPreview, ImportRow } from "./types";

export interface ImportContext {
  season: number;
  maxWeek: number;
  /** week -> teams with no game that week, so byes can be flagged. */
  byeTeamsByWeek?: Map<number, Set<string>>;
  /** entryName -> week the entry was already eliminated, for the §3 check. */
  eliminatedWeekByEntry?: Map<string, number>;
}

const WIDE_WEEK = /^week\s*_?(\d{1,2})$/i;

function headerIndex(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === n);
    if (i >= 0) return i;
  }
  return -1;
}

/** Detect and parse either supported layout into flat rows plus parse issues. */
export function parseImportCsv(
  text: string,
  ctx: ImportContext,
): { rows: ImportRow[]; issues: ImportIssue[]; format: "long" | "wide" } {
  const issues: ImportIssue[] = [];
  const grid = parseCsvRows(text.trim());
  if (grid.length === 0) {
    return {
      rows: [],
      issues: [{ kind: "MALFORMED_ROW", severity: "ERROR", message: "The file is empty." }],
      format: "long",
    };
  }

  const header = grid[0].map((h) => h.trim());
  const wideWeekCols = header
    .map((h, i) => ({ i, m: WIDE_WEEK.exec(h.trim()) }))
    .filter((x) => x.m)
    .map((x) => ({ index: x.i, week: Number(x.m![1]) }));

  if (wideWeekCols.length > 0) {
    return { ...parseWide(grid, header, wideWeekCols, ctx, issues), format: "wide" };
  }
  return { ...parseLong(text, ctx, issues), format: "long" };
}

function parseLong(text: string, ctx: ImportContext, issues: ImportIssue[]) {
  const records = parseCsv(text.trim());
  if (records.length === 0) {
    issues.push({
      kind: "MALFORMED_ROW",
      severity: "ERROR",
      message: "No data rows found under the header.",
    });
    return { rows: [] as ImportRow[], issues };
  }
  const header = Object.keys(records[0]);
  const entryKey = header.find((h) => ["entry", "entry_name", "team_name", "name"].includes(h.trim().toLowerCase()));
  const weekKey = header.find((h) => ["week", "wk"].includes(h.trim().toLowerCase()));
  const teamKey = header.find((h) => ["team", "pick", "selection"].includes(h.trim().toLowerCase()));
  const ownerKey = header.find((h) => ["owner", "player", "person", "manager"].includes(h.trim().toLowerCase()));

  if (!entryKey || !weekKey || !teamKey) {
    issues.push({
      kind: "MALFORMED_ROW",
      severity: "ERROR",
      message:
        "Long format needs `entry`, `week` and `team` columns (an optional `owner` column is also supported).",
    });
    return { rows: [] as ImportRow[], issues };
  }

  const rows: ImportRow[] = [];
  records.forEach((r, i) => {
    const line = i + 2; // 1-based, plus the header row
    const entry = (r[entryKey] ?? "").trim();
    const rawTeam = (r[teamKey] ?? "").trim();
    const weekRaw = (r[weekKey] ?? "").trim();
    if (!entry && !rawTeam && !weekRaw) return; // blank line
    if (!entry) {
      issues.push({
        kind: "MISSING_ENTRY",
        severity: "ERROR",
        message: `Line ${line}: no entry name.`,
        sourceLine: line,
      });
      return;
    }
    if (!rawTeam) return; // an empty cell simply means "no pick that week"
    const week = Number(weekRaw);
    const team = normalizeTeam(rawTeam);
    rows.push({
      entry,
      owner: ownerKey ? (r[ownerKey] ?? "").trim() || null : null,
      week: Number.isFinite(week) ? Math.round(week) : Number.NaN,
      team: team ?? "",
      rawTeam,
      sourceLine: line,
    });
  });
  return { rows, issues };
}

function parseWide(
  grid: string[][],
  header: string[],
  weekCols: { index: number; week: number }[],
  ctx: ImportContext,
  issues: ImportIssue[],
) {
  const entryIdx = headerIndex(header, ["entry", "entry_name", "name", "team_name"]);
  const ownerIdx = headerIndex(header, ["owner", "player", "person", "manager"]);
  if (entryIdx < 0) {
    issues.push({
      kind: "MALFORMED_ROW",
      severity: "ERROR",
      message: "Wide format needs an `entry` column alongside the week columns.",
    });
    return { rows: [] as ImportRow[], issues };
  }

  const rows: ImportRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const line = r + 1;
    const cells = grid[r];
    const entry = (cells[entryIdx] ?? "").trim();
    if (!entry) {
      if (cells.some((c) => c.trim())) {
        issues.push({
          kind: "MISSING_ENTRY",
          severity: "ERROR",
          message: `Line ${line}: row has picks but no entry name.`,
          sourceLine: line,
        });
      }
      continue;
    }
    for (const col of weekCols) {
      const rawTeam = (cells[col.index] ?? "").trim();
      if (!rawTeam) continue; // empty cell = no pick that week
      rows.push({
        entry,
        owner: ownerIdx >= 0 ? (cells[ownerIdx] ?? "").trim() || null : null,
        week: col.week,
        team: normalizeTeam(rawTeam) ?? "",
        rawTeam,
        sourceLine: line,
      });
    }
  }
  void ctx;
  return { rows, issues };
}

/**
 * Validate parsed rows and summarise them for the preview screen.
 *
 * ERROR issues block the commit; WARNING issues do not but are always shown.
 */
export function buildImportPreview(text: string, ctx: ImportContext): ImportPreview {
  const { rows, issues: parseIssues, format } = parseImportCsv(text, ctx);
  const issues: ImportIssue[] = [...parseIssues];

  const seenEntryWeek = new Map<string, ImportRow>();
  const teamsByEntry = new Map<string, Map<string, number>>();
  const ownerByEntry = new Map<string, string | null>();

  for (const row of rows) {
    if (!row.team) {
      issues.push({
        kind: "UNKNOWN_TEAM",
        severity: "ERROR",
        message: `Line ${row.sourceLine}: "${row.rawTeam}" is not a recognised NFL team.`,
        entry: row.entry,
        week: row.week,
        team: row.rawTeam,
        sourceLine: row.sourceLine,
      });
      continue;
    }
    if (!Number.isFinite(row.week) || row.week < 1 || row.week > ctx.maxWeek) {
      issues.push({
        kind: "INVALID_WEEK",
        severity: "ERROR",
        message: `Line ${row.sourceLine}: week ${row.week} is outside 1–${ctx.maxWeek}.`,
        entry: row.entry,
        week: row.week,
        sourceLine: row.sourceLine,
      });
      continue;
    }

    const key = `${row.entry}|${row.week}`;
    const prior = seenEntryWeek.get(key);
    if (prior) {
      issues.push({
        kind: prior.team === row.team ? "DUPLICATE_PICK" : "CONFLICTING_SELECTION",
        severity: prior.team === row.team ? "WARNING" : "ERROR",
        message:
          prior.team === row.team
            ? `Line ${row.sourceLine}: ${row.entry} week ${row.week} ${row.team} is listed twice; the duplicate is ignored.`
            : `Line ${row.sourceLine}: ${row.entry} has conflicting week ${row.week} picks (${prior.team} on line ${prior.sourceLine}, ${row.team} here).`,
        entry: row.entry,
        week: row.week,
        team: row.team,
        sourceLine: row.sourceLine,
      });
      continue;
    }
    seenEntryWeek.set(key, row);

    const teams = teamsByEntry.get(row.entry) ?? new Map<string, number>();
    const firstWeek = teams.get(row.team);
    if (firstWeek != null) {
      issues.push({
        kind: "TEAM_REUSED_BY_ENTRY",
        severity: "ERROR",
        message: `${row.entry} uses ${row.team} in both week ${firstWeek} and week ${row.week}. A survivor entry may use a team only once.`,
        entry: row.entry,
        week: row.week,
        team: row.team,
        sourceLine: row.sourceLine,
      });
    } else {
      teams.set(row.team, row.week);
    }
    teamsByEntry.set(row.entry, teams);
    if (row.owner) ownerByEntry.set(row.entry, row.owner);
    else if (!ownerByEntry.has(row.entry)) ownerByEntry.set(row.entry, null);

    const byes = ctx.byeTeamsByWeek?.get(row.week);
    if (byes?.has(row.team)) {
      issues.push({
        kind: "TEAM_ON_BYE",
        severity: "ERROR",
        message: `${row.entry} picked ${row.team} in week ${row.week}, but ${row.team} is on bye that week.`,
        entry: row.entry,
        week: row.week,
        team: row.team,
        sourceLine: row.sourceLine,
      });
    }

    const elimWeek = ctx.eliminatedWeekByEntry?.get(row.entry);
    if (elimWeek != null && row.week > elimWeek) {
      issues.push({
        kind: "PICK_AFTER_ELIMINATION",
        severity: "WARNING",
        message: `${row.entry} has a week ${row.week} pick but was already eliminated in week ${elimWeek}. It will be stored but ignored by the simulator.`,
        entry: row.entry,
        week: row.week,
        team: row.team,
        sourceLine: row.sourceLine,
      });
    }
  }

  const accepted = [...seenEntryWeek.values()];
  const entries = [...teamsByEntry.keys()].sort().map((name) => {
    const picks = accepted.filter((r) => r.entry === name).sort((a, b) => a.week - b.week);
    return {
      name,
      owner: ownerByEntry.get(name) ?? null,
      weeks: picks.map((p) => p.week),
      teams: picks.map((p) => p.team),
    };
  });

  const errors = issues.filter((i) => i.severity === "ERROR").length;
  const warnings = issues.length - errors;

  return {
    format,
    rows: accepted,
    issues,
    entries,
    committable: errors === 0 && accepted.length > 0,
    totals: { rows: accepted.length, entries: entries.length, errors, warnings },
  };
}
