/**
 * Scoring a gameweek as it happens, against the side actually submitted.
 *
 * The optimiser's suggestion is not the same thing as the eleven you played, so
 * this works only from a recorded submission. Automatic substitutions are
 * applied exactly when FPL would settle them - once a starter's fixtures are
 * finished and he did not appear - and not before.
 */

import { CHIPS, captainMultiplier } from './rules.js';
import { applyAutoSubs } from './lineup.js';

/**
 * @param {Snapshot} snapshot
 * @param {object} submission `{ xi, bench, captain, viceCaptain, chip }` of player ids
 * @param {number} gameweek
 * @returns {object} the running score and everything needed to explain it
 */
export function liveScore(snapshot, submission, gameweek) {
  const decorate = (id) => {
    const player = snapshot.player(id);
    if (!player) return null;
    return { ...player, live: snapshot.liveStatus(player, gameweek) };
  };

  const xi = submission.xi.map(decorate).filter(Boolean);
  const bench = submission.bench.map(decorate).filter(Boolean);
  if (xi.length === 0) return null;

  const chip = submission.chip ?? 'none';
  const benchCounts = !!CHIPS[chip]?.benchCounts;

  // Bench Boost pays everyone, so nobody is substituted in or out.
  const settled = benchCounts
    ? { xi, substitutions: [] }
    : applyAutoSubs({
        xi: xi.map((p) => ({ ...p, played: p.live.played, settled: p.live.settled })),
        bench: bench.map((p) => ({ ...p, played: p.live.played, settled: p.live.settled })),
      });

  const counted = benchCounts ? [...xi, ...bench] : settled.xi;

  // The armband falls to the vice only once the captain's gameweek is settled
  // and he has not played - the same test FPL applies.
  const captain = xi.find((p) => p.id === submission.captain);
  const vice = xi.find((p) => p.id === submission.viceCaptain);
  const captainBlanked = captain && captain.live.settled && !captain.live.played;
  const armband = captainBlanked && vice ? vice : captain;

  const base = counted.reduce((a, p) => a + p.live.points, 0);
  const armbandBonus = armband && counted.some((p) => p.id === armband.id)
    ? armband.live.points * (captainMultiplier(chip) - 1)
    : 0;

  const pending = counted.filter((p) => !p.live.settled && !p.live.blank);
  const inPlay = counted.filter((p) => p.live.started && !p.live.settled);

  return {
    gameweek,
    chip,
    total: base + armbandBonus,
    base,
    armbandBonus,
    armband,
    armbandSwitched: !!captainBlanked && !!vice,
    substitutions: settled.substitutions,
    counted,
    benchCounts,
    playersToPlay: pending.filter((p) => !p.live.started).length,
    playersInPlay: inPlay.length,
    settled: counted.every((p) => p.live.settled || p.live.blank),
  };
}
