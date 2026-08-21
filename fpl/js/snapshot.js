/**
 * Normalises an FPL data snapshot (bootstrap-static + fixtures) into the shape
 * the rest of the app consumes, and answers fixture questions about it.
 *
 * Field names follow the official API. Anything optional is probed defensively
 * so a snapshot from a slightly different API revision still loads.
 */

import { GKP, DEF, MID, FWD } from './rules.js';

const num = (v, fallback = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
};

const STATUS_AVAILABILITY = {
  a: 1,      // available
  d: 0.5,    // doubtful - overridden by chance_of_playing when present
  i: 0,      // injured
  s: 0,      // suspended
  u: 0,      // unavailable (left the league, not in squad)
  n: 0,      // not eligible
};

/**
 * @param {object} raw `{ elements, teams, events, fixtures, element_types? }`
 */
export function loadSnapshot(raw) {
  if (!raw || !Array.isArray(raw.elements) || !Array.isArray(raw.teams)) {
    throw new Error('Snapshot must contain `elements` and `teams` arrays.');
  }

  const teams = new Map();
  for (const t of raw.teams) {
    teams.set(t.id, {
      id: t.id,
      name: t.name,
      short: t.short_name,
      strength: num(t.strength, 3),
      attackHome: num(t.strength_attack_home, 1100),
      attackAway: num(t.strength_attack_away, 1100),
      defenceHome: num(t.strength_defence_home, 1100),
      defenceAway: num(t.strength_defence_away, 1100),
    });
  }

  const events = Array.isArray(raw.events) ? raw.events : [];
  const currentEvent = events.find((e) => e.is_current)?.id ?? null;
  const nextEvent = events.find((e) => e.is_next)?.id
    ?? (currentEvent ? currentEvent + 1 : (events[0]?.id ?? 1));
  const deadlines = new Map(events.map((e) => [e.id, e.deadline_time]));

  const players = new Map();
  for (const e of raw.elements) {
    const minutes = num(e.minutes);
    const starts = num(e.starts);
    players.set(e.id, {
      id: e.id,
      name: e.web_name ?? `${e.first_name ?? ''} ${e.second_name ?? ''}`.trim(),
      fullName: `${e.first_name ?? ''} ${e.second_name ?? ''}`.trim(),
      position: e.element_type,
      teamId: e.team,
      price: num(e.now_cost),                 // tenths of a million
      status: e.status ?? 'a',
      chanceOfPlaying: e.chance_of_playing_next_round,
      news: e.news ?? '',
      minutes,
      starts,
      form: num(e.form),
      pointsPerGame: num(e.points_per_game),
      totalPoints: num(e.total_points),
      epNext: e.ep_next == null ? null : num(e.ep_next),
      goals: num(e.goals_scored),
      assists: num(e.assists),
      cleanSheets: num(e.clean_sheets),
      goalsConceded: num(e.goals_conceded),
      saves: num(e.saves),
      bonus: num(e.bonus),
      bps: num(e.bps),
      yellowCards: num(e.yellow_cards),
      redCards: num(e.red_cards),
      ownGoals: num(e.own_goals),
      penaltiesSaved: num(e.penalties_saved),
      penaltiesMissed: num(e.penalties_missed),
      xG90: e.expected_goals_per_90 == null ? null : num(e.expected_goals_per_90),
      xA90: e.expected_assists_per_90 == null ? null : num(e.expected_assists_per_90),
      // Added to the API alongside defensive contribution scoring. May be a
      // points total or an action count depending on API revision; `xp.js`
      // normalises it and a per-player override always wins.
      defensiveContribution: e.defensive_contribution == null ? null : num(e.defensive_contribution),
      defensiveContribution90: e.defensive_contribution_per_90 == null
        ? null : num(e.defensive_contribution_per_90),
      selectedBy: num(e.selected_by_percent),
      per90: minutes > 0 ? minutes / 90 : 0,
      startRate: starts > 0 && minutes > 0 ? minutes / (starts * 90) : 0,
    });
  }

  // Surnames repeat across the league, so every display name carries its club.
  for (const p of players.values()) {
    p.label = `${p.name} (${teams.get(p.teamId)?.short ?? '?'})`;
    p.recent = [];
  }

  // Per-match history, when the refresh fetched it. This is what separates a
  // regular starter from a squad player with the same season minutes.
  for (const [id, detail] of Object.entries(raw.details ?? {})) {
    const player = players.get(Number(id));
    if (!player) continue;
    player.recent = (detail.recent ?? []).map((h) => ({
      round: h.round,
      minutes: num(h.minutes),
      // `starts` arrived with the 2024/25 API. Without it, treat an hour on the
      // pitch as a start - imperfect, but far better than ignoring the match.
      started: h.starts != null ? num(h.starts) > 0 : num(h.minutes) >= 60,
      points: num(h.total_points),
    }));
    player.historyPast = detail.history_past ?? [];
  }

  const fixtures = (raw.fixtures ?? []).map((f) => ({
    id: f.id,
    event: f.event,
    home: f.team_h,
    away: f.team_a,
    homeDifficulty: num(f.team_h_difficulty, 3),
    awayDifficulty: num(f.team_a_difficulty, 3),
    finished: !!f.finished,
    kickoff: f.kickoff_time ?? null,
  }));

  return new Snapshot({ players, teams, fixtures, events, currentEvent, nextEvent, deadlines,
    generatedAt: raw.generated_at ?? raw.generatedAt ?? null });
}

export class Snapshot {
  constructor(parts) { Object.assign(this, parts); }

  player(id) { return this.players.get(id); }
  team(id) { return this.teams.get(id); }

  /** Availability in [0,1]: explicit chance-of-playing wins over status code. */
  availability(player) {
    if (player.chanceOfPlaying != null) return Math.max(0, Math.min(100, player.chanceOfPlaying)) / 100;
    return STATUS_AVAILABILITY[player.status] ?? 1;
  }

  /**
   * Fixtures a team plays in a gameweek. Empty for a blank, two+ for a double.
   * @returns {{opponent:number, home:boolean, difficulty:number}[]}
   */
  teamFixtures(teamId, event) {
    const out = [];
    for (const f of this.fixtures) {
      if (f.event !== event) continue;
      if (f.home === teamId) out.push({ opponent: f.away, home: true, difficulty: f.homeDifficulty, kickoff: f.kickoff, fixtureId: f.id });
      else if (f.away === teamId) out.push({ opponent: f.home, home: false, difficulty: f.awayDifficulty, kickoff: f.kickoff, fixtureId: f.id });
    }
    return out;
  }

  /** The next `count` gameweek ids starting at `from` (inclusive). */
  horizon(from, count) {
    return Array.from({ length: count }, (_, i) => from + i).filter((gw) => gw <= 38);
  }

  /** Mean difficulty over a horizon, counting blanks as a null contribution. */
  fixtureRun(teamId, from, count) {
    return this.horizon(from, count).map((gw) => ({ gw, fixtures: this.teamFixtures(teamId, gw) }));
  }

  /**
   * Match on player name or club, so "salah", "ars" and "arsenal" all work.
   * Results are ranked by season points, which puts the intended player first
   * when several share a surname.
   */
  search(query, { position = null, limit = 20 } = {}) {
    const q = query.trim().toLowerCase();
    const results = [];
    for (const p of this.players.values()) {
      if (position && p.position !== position) continue;
      if (q && !this.matches(p, q)) continue;
      results.push(p);
    }
    results.sort((a, b) => b.totalPoints - a.totalPoints || b.price - a.price);
    return results.slice(0, limit);
  }

  matches(player, lowercaseQuery) {
    if (player.fullName.toLowerCase().includes(lowercaseQuery)) return true;
    if (player.name.toLowerCase().includes(lowercaseQuery)) return true;
    const team = this.team(player.teamId);
    if (!team) return false;
    return team.name.toLowerCase().includes(lowercaseQuery)
      || team.short.toLowerCase() === lowercaseQuery;
  }
}

export const POSITION_ORDER = [GKP, DEF, MID, FWD];
