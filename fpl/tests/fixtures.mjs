/** Synthetic snapshot builder so the engine can be tested without live data. */
import { loadSnapshot } from '../js/snapshot.js';
import { GKP, DEF, MID, FWD } from '../js/rules.js';

export function buildSnapshot({ playerSpecs = [], fixtureSpecs = null, teams = 20, nextEvent = 1 } = {}) {
  const teamList = Array.from({ length: teams }, (_, i) => ({
    id: i + 1, name: `Team ${i + 1}`, short: `T${i + 1}`, strength: 3,
    strength_attack_home: 1100, strength_attack_away: 1100,
    strength_defence_home: 1100, strength_defence_away: 1100,
  }));

  const elements = playerSpecs.map((s, i) => ({
    id: s.id ?? i + 1,
    web_name: s.name ?? `P${i + 1}`,
    first_name: s.name ?? `P${i + 1}`,
    second_name: '',
    element_type: s.position,
    team: s.team ?? 1,
    now_cost: s.price ?? 50,
    status: s.status ?? 'a',
    chance_of_playing_next_round: s.chance ?? null,
    minutes: s.minutes ?? 900,
    starts: s.starts ?? 10,
    form: s.form ?? 4,
    points_per_game: s.ppg ?? 4,
    total_points: s.totalPoints ?? 40,
    ep_next: s.epNext ?? null,
    goals_scored: s.goals ?? 0,
    assists: s.assists ?? 0,
    clean_sheets: s.cleanSheets ?? 0,
    goals_conceded: s.goalsConceded ?? 0,
    saves: s.saves ?? 0,
    bonus: s.bonus ?? 0,
    bps: s.bps ?? 0,
    yellow_cards: 0, red_cards: 0, own_goals: 0,
    penalties_saved: 0, penalties_missed: 0,
    expected_goals_per_90: s.xG90 ?? 0,
    expected_assists_per_90: s.xA90 ?? 0,
    defensive_contribution_per_90: s.dc90 ?? null,
    selected_by_percent: '5.0',
  }));

  // Default: every team plays every gameweek 1-10, alternating home and away.
  const fixtures = fixtureSpecs ?? defaultFixtures(teams, 10);

  return loadSnapshot({
    elements, teams: teamList, fixtures,
    events: Array.from({ length: 38 }, (_, i) => ({
      id: i + 1, deadline_time: `2026-08-${String(21 + i).padStart(2, '0')}T17:00:00Z`,
      is_current: i + 1 === nextEvent - 1, is_next: i + 1 === nextEvent,
    })),
  });
}

function defaultFixtures(teams, gameweeks) {
  const out = [];
  let id = 1;
  for (let gw = 1; gw <= gameweeks; gw++) {
    for (let t = 1; t <= teams; t += 2) {
      const home = gw % 2 === 0 ? t : t + 1;
      const away = gw % 2 === 0 ? t + 1 : t;
      out.push({
        id: id++, event: gw, team_h: home, team_a: away,
        team_h_difficulty: 3, team_a_difficulty: 3, finished: false, kickoff_time: null,
      });
    }
  }
  return out;
}

/**
 * A legal 15-player squad: 2 GKP, 5 DEF, 5 MID, 3 FWD spread across teams.
 * Players carry mid-table rates by position so that a test candidate has to be
 * genuinely better to be worth a transfer, not merely better than a zero.
 */
export function legalSquadSpecs(overrides = {}) {
  const layout = [
    ...Array(2).fill(GKP), ...Array(5).fill(DEF),
    ...Array(5).fill(MID), ...Array(3).fill(FWD),
  ];
  return layout.map((position, i) => ({
    id: i + 1,
    name: `P${i + 1}`,
    position,
    team: (i % 6) + 1,          // at most 3 from any club
    price: 45 + i,
    ...BASELINE_RATES[position],
    ...(overrides[i + 1] ?? {}),
  }));
}

/** Roughly an average starter in each position. */
const BASELINE_RATES = {
  [GKP]: { saves: 300, bonus: 8 },
  [DEF]: { xG90: 0.05, xA90: 0.08, dc90: 9, bonus: 8 },
  [MID]: { xG90: 0.25, xA90: 0.20, dc90: 6, bonus: 10 },
  [FWD]: { xG90: 0.40, xA90: 0.15, bonus: 10 },
};
