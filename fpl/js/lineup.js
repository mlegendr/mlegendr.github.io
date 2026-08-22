/**
 * Starting XI, bench order and armband selection.
 *
 * The XI choice is solved exactly: within a formation the positions do not
 * interact, so taking the highest-projected players in each slot is optimal,
 * and there are only eight legal formations to compare.
 */

import {
  GKP, DEF, MID, FWD, FORMATIONS, POSITIONS, STARTING_XI, captainMultiplier, CHIPS,
} from './rules.js';

const byPoints = (a, b) => b.points - a.points;

/**
 * @param {{id:number, position:number, points:number}[]} squad 15 projected players
 * @param {string} chip active chip id for this gameweek
 */
export function optimiseLineup(squad, chip = 'none') {
  if (squad.length !== 15) throw new Error(`Expected a 15-player squad, got ${squad.length}.`);

  const pool = {
    [GKP]: squad.filter((p) => p.position === GKP).sort(byPoints),
    [DEF]: squad.filter((p) => p.position === DEF).sort(byPoints),
    [MID]: squad.filter((p) => p.position === MID).sort(byPoints),
    [FWD]: squad.filter((p) => p.position === FWD).sort(byPoints),
  };
  for (const [pos, meta] of Object.entries(POSITIONS)) {
    if (pool[pos].length !== meta.squad) {
      throw new Error(`Squad must contain ${meta.squad} ${meta.short}, found ${pool[pos].length}.`);
    }
  }

  let best = null;
  for (const formation of FORMATIONS) {
    const xi = [
      pool[GKP][0],
      ...pool[DEF].slice(0, formation.d),
      ...pool[MID].slice(0, formation.m),
      ...pool[FWD].slice(0, formation.f),
    ];
    const points = xi.reduce((a, p) => a + p.points, 0);
    if (!best || points > best.startingPoints) best = { formation, xi, startingPoints: points };
  }

  const xiIds = new Set(best.xi.map((p) => p.id));
  const bench = benchOrder(squad.filter((p) => !xiIds.has(p.id)));
  const armbands = pickArmbands(best.xi);
  const benchCounts = !!CHIPS[chip]?.benchCounts;

  const basePoints = best.startingPoints + (benchCounts ? bench.reduce((a, p) => a + p.points, 0) : 0);
  const captainBonus = armbands.captain
    ? armbands.captain.points * (captainMultiplier(chip) - 1)
    : 0;

  return {
    formation: best.formation,
    xi: sortForDisplay(best.xi),
    bench,
    captain: armbands.captain,
    viceCaptain: armbands.viceCaptain,
    captainShortlist: armbands.shortlist,
    startingPoints: best.startingPoints,
    benchPoints: bench.reduce((a, p) => a + p.points, 0),
    captainBonus,
    chip,
    total: basePoints + captainBonus,
  };
}

/**
 * Bench priority. The reserve keeper occupies its own slot; outfielders are
 * ordered by projection, which is what maximises the value of an auto-sub.
 */
export function benchOrder(bench) {
  const keeper = bench.filter((p) => p.position === GKP);
  const outfield = bench.filter((p) => p.position !== GKP).sort(byPoints);
  return [...keeper, ...outfield];
}

/**
 * Captain is simply the highest projection in the XI. For the vice we break
 * near-ties towards the player most likely to actually appear, since the vice
 * only ever pays out when the captain does not play.
 */
export function pickArmbands(xi) {
  const ranked = [...xi].sort(byPoints);
  const captain = ranked[0] ?? null;
  const rest = ranked.slice(1);

  let viceCaptain = rest[0] ?? null;
  if (viceCaptain) {
    const contenders = rest.filter((p) => p.points >= viceCaptain.points - 0.5);
    viceCaptain = contenders.sort((a, b) =>
      (b.startProbability ?? 1) - (a.startProbability ?? 1) || b.points - a.points)[0];
  }

  return { captain, viceCaptain, shortlist: ranked.slice(0, 5) };
}

const POSITION_RANK = { [GKP]: 0, [DEF]: 1, [MID]: 2, [FWD]: 3 };
function sortForDisplay(players) {
  return [...players].sort((a, b) => POSITION_RANK[a.position] - POSITION_RANK[b.position] || b.points - a.points);
}

/**
 * Difference between a manager's saved XI and the optimal one.
 * @returns {{in:object[], out:object[], gain:number}}
 */
export function lineupDelta(currentXiIds, optimal) {
  const current = new Set(currentXiIds);
  const optimalIds = new Set(optimal.xi.map((p) => p.id));
  return {
    in: optimal.xi.filter((p) => !current.has(p.id)),
    out: optimal.bench.filter((p) => current.has(p.id)),
  };
}

/** Total projected points for a squad over several gameweeks, XI re-optimised each week. */
export function projectHorizon(squadPlayers, projections, gameweeks, { chip = 'none', chipGameweek = null, decay = 1 } = {}) {
  let total = 0;
  const perGameweek = [];
  gameweeks.forEach((gw, i) => {
    const priced = squadPlayers.map((p) => ({
      ...p,
      points: projections.get(p.id)?.byGameweek.get(gw) ?? 0,
    }));
    const activeChip = chipGameweek === gw || (chipGameweek == null && i === 0) ? chip : 'none';
    const lineup = optimiseLineup(priced, activeChip);
    const weight = decay ** i;
    total += lineup.total * weight;
    perGameweek.push({ gameweek: gw, lineup, weighted: lineup.total * weight });
  });
  return { total, perGameweek };
}

/**
 * Is this a legal eleven? Used to validate a side the manager has picked by
 * hand, rather than one the optimiser built.
 * @returns {{valid:boolean, errors:string[], formation:string|null}}
 */
export function validateXi(xi) {
  const errors = [];
  if (xi.length !== STARTING_XI) errors.push(`A starting eleven needs ${STARTING_XI} players, this has ${xi.length}.`);

  const counts = { [GKP]: 0, [DEF]: 0, [MID]: 0, [FWD]: 0 };
  for (const p of xi) counts[p.position] = (counts[p.position] ?? 0) + 1;

  if (counts[GKP] !== 1) errors.push(`Exactly one goalkeeper must start, this has ${counts[GKP]}.`);
  for (const pos of [DEF, MID, FWD]) {
    const meta = POSITIONS[pos];
    if (counts[pos] < meta.min) errors.push(`At least ${meta.min} ${meta.short} must start, this has ${counts[pos]}.`);
    if (counts[pos] > meta.max) errors.push(`At most ${meta.max} ${meta.short} can start, this has ${counts[pos]}.`);
  }

  const formation = errors.length === 0 ? `${counts[DEF]}-${counts[MID]}-${counts[FWD]}` : null;
  return { valid: errors.length === 0, errors, formation };
}

/**
 * Apply FPL's automatic substitutions to a submitted side.
 *
 * A starter who finished the gameweek without playing is replaced by the
 * highest-priority bench player who did, provided the formation survives. A
 * player whose match is still to come is left alone - nothing has happened yet.
 *
 * @param {object} submission `{ xi, bench }` of players carrying `played` and `settled`
 * @returns {{xi:object[], substitutions:{out:object, in:object}[]}}
 */
export function applyAutoSubs({ xi, bench }) {
  const substitutions = [];
  const finalXi = [...xi];
  const available = [...bench];

  const blanked = finalXi.filter((p) => p.settled && !p.played);
  for (const out of blanked) {
    const isKeeper = out.position === GKP;
    const index = available.findIndex((candidate) => {
      if (!candidate.played) return false;
      if (isKeeper) return candidate.position === GKP;
      if (candidate.position === GKP) return false;
      const trial = finalXi.map((p) => (p.id === out.id ? candidate : p));
      return validateXi(trial).valid;
    });
    if (index === -1) continue;

    const replacement = available.splice(index, 1)[0];
    const at = finalXi.findIndex((p) => p.id === out.id);
    finalXi[at] = replacement;
    substitutions.push({ out, in: replacement });
  }

  return { xi: finalXi, substitutions };
}
