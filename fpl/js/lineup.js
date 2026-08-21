/**
 * Starting XI, bench order and armband selection.
 *
 * The XI choice is solved exactly: within a formation the positions do not
 * interact, so taking the highest-projected players in each slot is optimal,
 * and there are only eight legal formations to compare.
 */

import { GKP, DEF, MID, FWD, FORMATIONS, POSITIONS, captainMultiplier, CHIPS } from './rules.js';

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
