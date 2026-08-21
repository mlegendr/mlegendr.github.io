/**
 * Expected-points model.
 *
 * Every projection in the app comes from `expectedPoints`, which prices a
 * player's gameweek one scoring rule at a time using the 2026/27 point values.
 * Rate stats come from the snapshot, fixture context scales them, and minutes
 * decide how much of the rate the player actually banks.
 *
 * Blanks score zero; doubles are the sum of both fixtures.
 */

import {
  GKP, DEF, GOAL_POINTS, ASSIST_POINTS, CLEAN_SHEET_POINTS, SAVES_PER_POINT,
  PENALTY_SAVE_POINTS, PENALTY_MISS_POINTS, OWN_GOAL_POINTS, YELLOW_CARD_POINTS,
  RED_CARD_POINTS, GOALS_CONCEDED_PER_POINT, DEFCON_POINTS, DEFCON_THRESHOLD,
} from './rules.js';

export const DEFAULTS = {
  /** Weight given to FPL's own `ep_next` for the immediate gameweek only. */
  epBlend: 0.35,
  /** Expected minutes assumed for a fit player with no season data yet. */
  minutesPrior: 68,
  /** Games of season data needed before season minutes fully outweigh the prior. */
  minutesPriorGames: 3,
  /** Bonus points regress towards the mean; season rates alone overstate them. */
  bonusDamping: 0.9,
  /** How far form is allowed to move attacking output. */
  formSwing: 0.12,
  /** Later gameweeks are less certain, so they are discounted when ranking plans. */
  horizonDecay: 0.92,
  /** How many recent matches inform the start probability. */
  recentMatches: 6,
  /**
   * Weight decay per match going back, so last weekend counts most. At 0.75 a
   * run of three straight starts after a spell out reads as roughly a 70%
   * chance of starting, which is about right for a player who has just won his
   * place back.
   */
  recencyDecay: 0.75,
  /** Recent matches needed before they fully outweigh the season rate. */
  recentPriorMatches: 2,
  /**
   * Smoothing on the observed start rate, in units of recency weight. Keeps a
   * short run of matches from implying a player is certain to start or certain
   * not to - roughly a 7% floor and a 92% ceiling over six matches.
   */
  startSmoothing: 0.3,
};

/** Expected goals conceded by the team facing a fixture of this difficulty. */
const CONCEDE_BY_DIFFICULTY = { 1: 0.85, 2: 1.05, 3: 1.30, 4: 1.60, 5: 1.95 };
/** Multiplier on the player's own attacking rates for a fixture of this difficulty. */
const ATTACK_BY_DIFFICULTY = { 1: 1.35, 2: 1.18, 3: 1.00, 4: 0.86, 5: 0.74 };
/** Harder fixtures mean more defending, so defensive actions rise. */
const DEFCON_BY_DIFFICULTY = { 1: 0.88, 2: 0.94, 3: 1.00, 4: 1.07, 5: 1.14 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logistic = (x) => 1 / (1 + Math.exp(-x));
const lookup = (table, difficulty) => table[clamp(Math.round(difficulty), 1, 5)];

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** E[floor(X / d)] for X ~ Poisson(lambda) - how FPL pays saves and goals conceded. */
export function expectedFloorDiv(lambda, d) {
  if (lambda <= 0) return 0;
  let total = 0;
  const upper = Math.ceil(lambda + 8 * Math.sqrt(lambda) + 8);
  for (let k = 0; k <= upper; k++) total += Math.floor(k / d) * poissonPmf(k, lambda);
  return total;
}

/** P(X >= threshold) for X ~ Poisson(lambda). */
export function poissonAtLeast(lambda, threshold) {
  if (lambda <= 0) return 0;
  let below = 0;
  for (let k = 0; k < threshold; k++) below += poissonPmf(k, lambda);
  return clamp(1 - below, 0, 1);
}

/** Finished fixtures per team, used to turn season totals into per-game rates. */
export function teamGamesPlayed(snapshot) {
  const games = new Map();
  for (const t of snapshot.teams.keys()) games.set(t, 0);
  for (const f of snapshot.fixtures) {
    if (!f.finished) continue;
    games.set(f.home, (games.get(f.home) ?? 0) + 1);
    games.set(f.away, (games.get(f.away) ?? 0) + 1);
  }
  return games;
}

/**
 * What the last few matches say about a player's role.
 *
 * Season averages cannot tell a regular starter from someone who played every
 * minute in August and has been benched since. Recent matches can, so they are
 * weighted towards the present and dominate the season rate when available.
 *
 * @returns {{startProbability:number, minutes:number, matches:number}|null}
 */
export function recentRole(player, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const history = player.recent ?? [];
  if (history.length === 0) return null;

  const window = history.slice(-o.recentMatches);
  let weight = 0, started = 0, startedMinutes = 0, startedWeight = 0, benchMinutes = 0, benchWeight = 0;

  window.forEach((match, i) => {
    // The most recent match carries the most weight.
    const w = o.recencyDecay ** (window.length - 1 - i);
    weight += w;
    if (match.started) {
      started += w;
      startedMinutes += w * match.minutes;
      startedWeight += w;
    } else {
      benchMinutes += w * match.minutes;
      benchWeight += w;
    }
  });

  const startProbability = weight > 0 ? started / weight : 0;
  const whenStarting = startedWeight > 0 ? startedMinutes / startedWeight : 85;
  const whenNot = benchWeight > 0 ? benchMinutes / benchWeight : 8;

  // Of the matches he did not start, how often did he get on at all?
  const benchMatches = window.filter((m) => !m.started);
  const cameOn = benchMatches.filter((m) => m.minutes > 0).length;
  const subAppearanceRate = benchMatches.length > 0 ? cameOn / benchMatches.length : 0.6;

  return {
    startProbability,
    weight,                    // total recency weight, for smoothing
    subAppearanceRate,
    minutesIfStarting: clamp(whenStarting, 1, 90),
    minutesIfSub: clamp(whenNot > 0 ? whenNot : 15, 1, 90),
    minutes: clamp(startProbability * whenStarting + (1 - startProbability) * whenNot, 0, 90),
    matches: window.length,
  };
}

/**
 * How a player's minutes are actually distributed, rather than a single average.
 *
 * This distinction matters wherever scoring has a threshold. A player with a
 * 50% chance of starting is not a man who plays 45 minutes every week: he plays
 * ninety half the time and barely features the rest. Averaging the two before
 * applying a threshold badly understates his chance of clearing it.
 */
export function minutesProfile(snapshot, player, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const availability = o.override?.availability ?? snapshot.availability(player);

  // An explicit minutes override describes one expected outing, so treat it as
  // a near-certain start of that length.
  if (o.override?.minutes != null) {
    const minutes = clamp(o.override.minutes, 0, 90);
    const starts = minutes >= 45 ? 1 : 0;
    return {
      availability,
      pStart: availability * starts,
      pAppearance: availability * (minutes > 0 ? 1 : 0),
      minutesIfStarting: minutes,
      minutesIfSub: minutes,
      expectedMinutes: minutes,
    };
  }

  const role = recentRole(player, o);
  const blended = expectedMinutes(snapshot, player, o);

  if (!role) {
    // Without per-match history, infer a start share from the season's minutes.
    const games = o.teamGames ?? teamGamesPlayed(snapshot).get(player.teamId) ?? 0;
    const share = games > 0 ? clamp(player.minutes / (games * 90), 0, 1) : clamp(blended / 90, 0, 1);
    return {
      availability,
      pStart: availability * share,
      pAppearance: availability * Math.min(1, share + 0.25),
      minutesIfStarting: Math.max(blended, 70),
      minutesIfSub: 15,
      expectedMinutes: availability * blended,
    };
  }

  // Smooth the observed start rate rather than blending it with season minutes.
  // Minutes are a poor proxy for starts - a substitute who plays half an hour
  // every week accumulates them without ever starting - and a handful of
  // matches should never imply absolute certainty either way.
  const alpha = o.startSmoothing;
  const pStartRaw = clamp(
    (role.startProbability * role.weight + alpha) / (role.weight + 2 * alpha), 0, 1);
  const pAppearRaw = clamp(pStartRaw + (1 - pStartRaw) * role.subAppearanceRate, 0, 1);

  return {
    availability,
    pStart: availability * pStartRaw,
    pAppearance: availability * pAppearRaw,
    minutesIfStarting: role.minutesIfStarting,
    minutesIfSub: role.minutesIfSub,
    expectedMinutes: availability * blended,
  };
}

/**
 * Probability the player starts, from recent selections, scaled by whether he
 * is fit. Used for the vice-captain tiebreak and shown in the squad table.
 */
export function startProbability(snapshot, player, opts = {}) {
  return minutesProfile(snapshot, player, opts).pStart;
}

/**
 * Expected minutes in a match the player features in. Recent selections lead;
 * the season rate and a prior fill in behind them. A manual override wins.
 */
export function expectedMinutes(snapshot, player, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.override?.minutes != null) return clamp(o.override.minutes, 0, 90);

  const games = o.teamGames ?? teamGamesPlayed(snapshot).get(player.teamId) ?? 0;
  const prior = o.override?.minutesPrior ?? o.minutesPrior;
  const seasonEstimate = games > 0
    ? (() => {
        const seasonRate = clamp(player.minutes / games, 0, 90);
        const w = games / (games + o.minutesPriorGames);
        return w * seasonRate + (1 - w) * prior;
      })()
    : prior;

  const role = recentRole(player, o);
  if (!role) return clamp(seasonEstimate, 0, 90);

  // Trust recent matches more the more of them there are.
  const w = role.matches / (role.matches + o.recentPriorMatches);
  return clamp(w * role.minutes + (1 - w) * seasonEstimate, 0, 90);
}

function per90(total, minutes, fallback = 0) {
  if (!minutes || minutes <= 0) return fallback;
  return total / (minutes / 90);
}

/**
 * Points for a single fixture. Exposed so the UI can explain a projection.
 * @returns {{total:number, parts:object}}
 */
export function fixtureExpectedPoints(snapshot, player, fixture, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pos = player.position;
  const profile = minutesProfile(snapshot, player, o);
  const { availability, pStart, pAppearance } = profile;
  if (availability <= 0) return { total: 0, parts: {} };

  const mins = profile.expectedMinutes;
  // Linear scoring (goals, assists, cards) only cares about total minutes.
  const minShare = clamp(mins / 90, 0, 1);
  const pApp = pAppearance;
  // Reaching 60 minutes is overwhelmingly a starter's event.
  const p60 = pStart * logistic((profile.minutesIfStarting - 58) / 7)
    + Math.max(0, pAppearance - pStart) * logistic((profile.minutesIfSub - 58) / 7);

  const attackMult = lookup(ATTACK_BY_DIFFICULTY, fixture.difficulty) * (fixture.home ? 1.05 : 0.95);
  const concede = lookup(CONCEDE_BY_DIFFICULTY, fixture.difficulty) * (fixture.home ? 0.94 : 1.06);
  const defconMult = lookup(DEFCON_BY_DIFFICULTY, fixture.difficulty);

  // Form nudges attacking output around the season baseline, but only mildly:
  // the underlying rates already carry most of the signal.
  const formMult = player.pointsPerGame > 0 && player.form > 0
    ? clamp(1 - o.formSwing + o.formSwing * (player.form / player.pointsPerGame), 1 - o.formSwing, 1 + o.formSwing)
    : 1;

  const xG90 = player.xG90 ?? per90(player.goals, player.minutes);
  const xA90 = player.xA90 ?? per90(player.assists, player.minutes);

  const parts = {};
  parts.appearance = pApp + p60;                       // 1 point, 2 from 60 minutes
  parts.goals = xG90 * minShare * attackMult * formMult * GOAL_POINTS[pos];
  parts.assists = xA90 * minShare * attackMult * formMult * ASSIST_POINTS;

  const cleanSheetPoints = CLEAN_SHEET_POINTS[pos] ?? 0;
  parts.cleanSheet = cleanSheetPoints > 0 ? p60 * Math.exp(-concede) * cleanSheetPoints : 0;

  parts.goalsConceded = (pos === GKP || pos === DEF)
    ? -expectedFloorDiv(concede * minShare, GOALS_CONCEDED_PER_POINT)
    : 0;

  if (pos === GKP) {
    const saves90 = per90(player.saves, player.minutes, 2.8);
    const shotVolume = concede / CONCEDE_BY_DIFFICULTY[3];
    parts.saves = expectedFloorDiv(saves90 * minShare * shotVolume, SAVES_PER_POINT);
    parts.penaltySaves = per90(player.penaltiesSaved, player.minutes) * minShare * PENALTY_SAVE_POINTS;
  } else {
    parts.saves = 0;
    parts.penaltySaves = 0;
  }

  parts.defensiveContribution = defconPoints(player, profile, defconMult, o);

  parts.bonus = per90(player.bonus, player.minutes) * minShare * o.bonusDamping;

  parts.cards = (per90(player.yellowCards, player.minutes) * YELLOW_CARD_POINTS
    + per90(player.redCards, player.minutes) * RED_CARD_POINTS) * minShare;
  parts.penaltiesMissed = per90(player.penaltiesMissed, player.minutes) * minShare * PENALTY_MISS_POINTS;
  parts.ownGoals = per90(player.ownGoals, player.minutes) * minShare * OWN_GOAL_POINTS;

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts, expectedMinutes: mins, availability, p60, pStart, concede, attackMult, profile };
}

/**
 * Defensive contribution: 2 points at 10 CBIT (DEF) or 12 CBIRT (MID/FWD).
 * A per-player `defconRate` override (chance of hitting the threshold in a full
 * match) is honoured first, since it is the cleanest thing a manager can supply.
 */
function defconPoints(player, profile, defconMult, o) {
  const threshold = DEFCON_THRESHOLD[player.position];
  if (!Number.isFinite(threshold)) return 0;   // goalkeepers are not eligible

  const { pStart, pAppearance, minutesIfStarting, minutesIfSub } = profile;
  const pSubOnly = Math.max(0, pAppearance - pStart);

  if (o.override?.defconRate != null) {
    // The override is the chance of clearing the threshold in a full match, so
    // it only applies when he actually starts.
    return DEFCON_POINTS * clamp(o.override.defconRate, 0, 1) * pStart;
  }

  const raw = player.defensiveContribution90
    ?? (player.defensiveContribution != null && player.minutes > 0
      ? per90(player.defensiveContribution, player.minutes)
      : null);
  if (raw == null) return 0;

  // The API field has appeared both as points-per-90 (0-2) and as a raw action
  // count per 90 (roughly 5-20). Treat anything above 3 as an action count and
  // price it through the Poisson threshold; otherwise it is already points.
  if (raw > 3) {
    // Average the probability over the outcomes, not the minutes: a rotation
    // risk either starts and has a real chance of clearing 10 or 12 actions,
    // or does not start and has almost none. Blending the minutes first would
    // understate him badly.
    const hitRate = (minutes) => poissonAtLeast(raw * (minutes / 90) * defconMult, threshold);
    return DEFCON_POINTS * (pStart * hitRate(minutesIfStarting) + pSubOnly * hitRate(minutesIfSub));
  }

  // Already expressed as points per 90, so it scales with minutes.
  const minShare = pStart * (minutesIfStarting / 90) + pSubOnly * (minutesIfSub / 90);
  return raw * minShare * defconMult;
}

/**
 * Expected points for a player in a gameweek, summed over their fixtures.
 * @param {object} opts `{ overrides: Map<playerId, override>, epBlend, teamGamesMap }`
 */
export function expectedPoints(snapshot, player, gameweek, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const override = o.overrides?.get?.(player.id) ?? o.overrides?.[player.id] ?? null;
  const teamGames = o.teamGamesMap?.get(player.teamId);
  const fixtures = snapshot.teamFixtures(player.teamId, gameweek);

  const perFixture = fixtures.map((f) =>
    fixtureExpectedPoints(snapshot, player, f, { ...o, override, teamGames }));
  const modelTotal = perFixture.reduce((a, r) => a + r.total, 0);
  let total = modelTotal;

  // FPL publishes its own one-gameweek projection; blending regularises ours.
  // Recorded rather than applied silently, so the breakdown shown to the user
  // reconciles with the number they are shown.
  let blend = null;
  if (gameweek === snapshot.nextEvent && player.epNext != null && o.epBlend > 0
      && snapshot.availability(player) > 0 && override?.minutes == null) {
    blend = { epNext: player.epNext, weight: o.epBlend };
    total = (1 - o.epBlend) * total + o.epBlend * player.epNext;
  }

  return {
    playerId: player.id,
    gameweek,
    total,
    modelTotal,
    blend,
    fixtures: fixtures.map((f, i) => ({ ...f, points: perFixture[i].total, detail: perFixture[i] })),
    blank: fixtures.length === 0,
    double: fixtures.length > 1,
  };
}

/**
 * Projections for many players across a horizon.
 * @returns {Map<playerId, {byGameweek: Map<gw, number>, total:number, detail:Map}>}
 */
export function projectSquad(snapshot, players, gameweeks, opts = {}) {
  const teamGamesMap = opts.teamGamesMap ?? teamGamesPlayed(snapshot);
  const out = new Map();
  for (const player of players) {
    const byGameweek = new Map();
    const detail = new Map();
    let total = 0;
    for (const gw of gameweeks) {
      const r = expectedPoints(snapshot, player, gw, { ...opts, teamGamesMap });
      byGameweek.set(gw, r.total);
      detail.set(gw, r);
      total += r.total;
    }
    out.set(player.id, { byGameweek, detail, total });
  }
  return out;
}
