/**
 * Transfer planner.
 *
 * Given the manager's shortlist of incoming targets, this enumerates every
 * legal combination of moves - including doing nothing - scores each one over
 * the fixture horizon with the XI re-optimised in every gameweek, subtracts
 * any points hits, and ranks the results.
 *
 * The candidate pool is deliberately closed: only the shortlist can come in,
 * and protected players never go out. Plans blocked by protection are still
 * scored, so the cost of protecting someone can be reported rather than hidden.
 */

import { MAX_FREE_TRANSFERS, TRANSFER_HIT, CHIPS, POSITIONS, MAX_PER_CLUB, money } from './rules.js';
import { optimiseLineup } from './lineup.js';
import { projectSquad, DEFAULTS as XP_DEFAULTS, teamGamesPlayed } from './xp.js';
import { sellValue, isPreSeason } from './squad.js';

export const PLANNER_DEFAULTS = {
  horizon: 6,
  /** Extra transfers beyond the free allocation the planner may consider. */
  maxHits: 2,
  /** A banked free transfer has option value; this is what one is worth. */
  freeTransferValue: 0.8,
  /** Later gameweeks are discounted when comparing plans. */
  decay: XP_DEFAULTS.horizonDecay,
  /** Ignore plans that gain less than this, and roll the transfer instead. */
  minimumGain: 0.5,
  /** Squad players the planner may never sell, however good the move. */
  protectedIds: [],
};

/**
 * @param {object} state squad state
 * @param {Snapshot} snapshot
 * @param {number[]} candidateIds shortlist of incoming targets
 * @param {object} options see PLANNER_DEFAULTS
 */
export function planTransfers(state, snapshot, candidateIds, options = {}) {
  const o = { ...PLANNER_DEFAULTS, ...options };
  const chip = options.chip ?? state.activeChip ?? 'none';
  // Pre-season behaves like a permanent wildcard: rebuild freely, no hits, and
  // nothing to bank because free transfers do not exist yet.
  const preSeason = isPreSeason(state);
  const unlimited = !!CHIPS[chip]?.unlimitedTransfers || preSeason;
  const freeTransfers = preSeason ? 0 : state.freeTransfers;

  const gameweeks = snapshot.horizon(options.fromGameweek ?? state.gameweek, o.horizon);
  const teamGamesMap = teamGamesPlayed(snapshot);

  const owned = new Map(state.picks.map((p) => [p.playerId, p]));
  const candidates = candidateIds
    .filter((id) => !owned.has(id))
    .map((id) => {
      const p = snapshot.player(id);
      if (!p) throw new Error(`Unknown player id ${id} in the shortlist.`);
      return p;
    });

  const squad = state.picks.map((pick) => ({
    ...snapshot.player(pick.playerId),
    purchasePrice: pick.purchasePrice,
    sellPrice: sellValue(pick, snapshot),
  }));

  const projections = projectSquad(
    snapshot,
    [...squad, ...candidates],
    gameweeks,
    { ...options, overrides: state.overrides, teamGamesMap },
  );

  const protectedIds = new Set(options.protectedIds ?? state.protectedIds ?? o.protectedIds);

  const maxTransfers = unlimited
    ? candidates.length
    : Math.min(candidates.length, freeTransfers + o.maxHits);

  const baseline = scoreSquad(squad, projections, gameweeks, { chip, decay: o.decay, unchangedFor: null });
  // Doing nothing keeps every free transfer, so the baseline is valued the same
  // way as any plan - otherwise reported gains drift by a constant.
  const baselineScore = baseline.total
    + Math.min(MAX_FREE_TRANSFERS, freeTransfers) * o.freeTransferValue;

  const plans = [];
  for (const incoming of subsets(candidates, maxTransfers)) {
    const m = incoming.length;
    for (const outgoing of combinations(squad, m)) {
      const check = legalSwap(squad, outgoing, incoming, state.bank, snapshot);
      if (!check.ok) continue;

      const newSquad = squad
        .filter((p) => !outgoing.some((q) => q.id === p.id))
        .concat(incoming.map((p) => ({ ...p, purchasePrice: p.price, sellPrice: p.price })));

      // A Free Hit squad exists for one gameweek only; the old squad returns.
      const unchangedFor = chip === 'freehit' ? squad : null;
      const scored = scoreSquad(newSquad, projections, gameweeks, { chip, decay: o.decay, unchangedFor });

      const hits = unlimited ? 0 : Math.max(0, m - freeTransfers) * TRANSFER_HIT;
      const remainingFree = unlimited
        ? Math.min(MAX_FREE_TRANSFERS, freeTransfers)
        : Math.max(0, freeTransfers - m);
      const bankValue = remainingFree * o.freeTransferValue;
      const score = scored.total - hits + bankValue;

      plans.push({
        transfersIn: incoming,
        transfersOut: outgoing,
        blockedBy: outgoing.filter((p) => protectedIds.has(p.id)),
        transfers: m,
        hits,
        bankAfter: check.bankAfter,
        horizonPoints: scored.total,
        perGameweek: scored.perGameweek,
        netGain: score - baselineScore,
        rawGain: scored.total - baseline.total,
        freeTransfersAfter: remainingFree,
        score,
      });
    }
  }

  plans.sort((a, b) => b.netGain - a.netGain || a.transfers - b.transfers);

  const allowed = plans.filter((plan) => plan.blockedBy.length === 0);
  const blocked = plans.filter((plan) => plan.blockedBy.length > 0);
  const best = allowed[0];

  // If protecting someone ruled out a better move, say so rather than quietly
  // presenting the second-best option as though it were the best available.
  const bestBlocked = blocked[0];
  const protectionCost = bestBlocked && bestBlocked.netGain > (best?.netGain ?? -Infinity)
    ? {
        plan: bestBlocked,
        players: bestBlocked.blockedBy,
        forgone: bestBlocked.netGain - (best?.netGain ?? 0),
      }
    : null;

  return {
    gameweeks,
    chip,
    freeTransfers,
    preSeason,
    protectedIds: [...protectedIds],
    baseline: { ...baseline, score: baselineScore },
    plans: allowed.slice(0, options.limit ?? 12),
    blockedPlans: blocked.length,
    protectionCost,
    recommendation: recommend(best, allowed, o, { chip, freeTransfers, snapshot, gameweeks, preSeason }),
    consideredPlans: plans.length,
    projections,
  };
}

/** Horizon score for a squad, XI re-optimised each gameweek. */
function scoreSquad(squadPlayers, projections, gameweeks, { chip, decay, unchangedFor }) {
  let total = 0;
  const perGameweek = [];
  gameweeks.forEach((gw, i) => {
    // Only the first gameweek of the horizon uses the declared chip.
    const activeChip = i === 0 ? chip : 'none';
    const roster = i === 0 || !unchangedFor ? squadPlayers : unchangedFor;
    const priced = roster.map((p) => ({ ...p, points: projections.get(p.id)?.byGameweek.get(gw) ?? 0 }));
    const lineup = optimiseLineup(priced, activeChip);
    const weight = decay ** i;
    total += lineup.total * weight;
    perGameweek.push({ gameweek: gw, points: lineup.total, weighted: lineup.total * weight, lineup });
  });
  return { total, perGameweek };
}

/** Position counts, club limit and budget must all survive the swap. */
function legalSwap(squad, outgoing, incoming, bank, snapshot) {
  const outIds = new Set(outgoing.map((p) => p.id));
  const kept = squad.filter((p) => !outIds.has(p.id));
  const next = [...kept, ...incoming];

  const counts = {};
  for (const p of next) counts[p.position] = (counts[p.position] ?? 0) + 1;
  for (const meta of Object.values(POSITIONS)) {
    if ((counts[meta.id] ?? 0) !== meta.squad) return { ok: false, reason: 'position' };
  }

  const clubs = new Map();
  for (const p of next) {
    const n = (clubs.get(p.teamId) ?? 0) + 1;
    if (n > MAX_PER_CLUB) return { ok: false, reason: 'club-limit' };
    clubs.set(p.teamId, n);
  }

  const proceeds = outgoing.reduce((a, p) => a + p.sellPrice, 0);
  const spend = incoming.reduce((a, p) => a + p.price, 0);
  const bankAfter = bank + proceeds - spend;
  if (bankAfter < 0) return { ok: false, reason: 'budget' };

  return { ok: true, bankAfter };
}

function recommend(best, plans, o, ctx) {
  const holdReason = (detail) => {
    if (ctx.preSeason) {
      return `Keep this squad. ${detail} Changes are still free until the Gameweek 1 deadline, so nothing is committed.`;
    }
    if (ctx.freeTransfers >= MAX_FREE_TRANSFERS) {
      return `Hold. You are at the ${MAX_FREE_TRANSFERS}-transfer cap, so a rolled transfer is now worth nothing - but ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`;
    }
    return `Roll your transfer. ${detail}`;
  };

  if (!best || best.transfers === 0) {
    return {
      action: 'hold',
      headline: holdReason(`No shortlisted move clears the ${o.minimumGain.toFixed(1)}-point bar over ${ctx.gameweeks.length} gameweeks.`),
      plan: best ?? null,
    };
  }
  if (best.netGain < o.minimumGain) {
    return {
      action: 'hold',
      headline: holdReason(`The best shortlisted move gains only ${best.netGain.toFixed(1)} points over ${ctx.gameweeks.length} gameweeks.`),
      plan: best,
    };
  }
  const hitNote = best.hits > 0
    ? ` This takes a ${best.hits}-point hit, and still nets ${best.netGain.toFixed(1)}.`
    : '';
  return {
    action: 'transfer',
    headline: `${describe(best)} for a projected ${best.netGain.toFixed(1)} points over ${ctx.gameweeks.length} gameweeks.${hitNote}`,
    plan: best,
  };
}

export function describe(plan) {
  if (!plan || plan.transfers === 0) return 'No transfers';
  const outs = plan.transfersOut.map((p) => p.label ?? p.name).join(', ');
  const ins = plan.transfersIn.map((p) => p.label ?? p.name).join(', ');
  return `${outs} → ${ins}`;
}

/** All subsets of `items` up to `maxSize`, smallest first. */
function* subsets(items, maxSize) {
  for (let size = 0; size <= Math.min(maxSize, items.length); size++) {
    yield* combinations(items, size);
  }
}

/** All `k`-combinations of `items`. */
export function* combinations(items, k) {
  if (k === 0) { yield []; return; }
  if (k > items.length) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === items.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}
