/**
 * Squad state: who you own, what you paid, what you can sell for, how much is
 * in the bank, how many free transfers you hold and which chips are spent.
 *
 * State is a plain serialisable object so it round-trips through localStorage
 * and the JSON export without ceremony. Every mutation returns a new state.
 */

import {
  GKP, DEF, MID, FWD, POSITIONS, SQUAD_SIZE, MAX_PER_CLUB, MAX_FREE_TRANSFERS,
  BUDGET, TRANSFER_HIT, sellingPrice, chipHalf, CHIPS,
} from './rules.js';

export const STATE_VERSION = 1;

export function emptyState(gameweek = 1) {
  return {
    version: STATE_VERSION,
    season: '2026/27',
    gameweek,
    bank: 0,                       // tenths of a million
    freeTransfers: 1,
    picks: [],                     // { playerId, purchasePrice }
    chipsUsed: { first: [], second: [] },
    activeChip: 'none',            // chip declared for the current gameweek
    freeHitRestore: null,          // picks/bank to restore after a Free Hit
    savedXi: null,                 // last confirmed starting XI, if any
    overrides: {},                 // playerId -> { minutes, availability, defconRate }
    protectedIds: [],              // players the planner may never sell
    log: [],
  };
}

/** Build the opening squad. Before the GW1 deadline transfers are unlimited and free. */
export function initialSquad(state, playerIds, snapshot, { budget = BUDGET, purchasePrices = {} } = {}) {
  const picks = playerIds.map((id) => {
    const p = snapshot.player(id);
    if (!p) throw new Error(`Unknown player id ${id}.`);
    // What you actually paid governs the selling price, not today's price.
    return { playerId: id, purchasePrice: purchasePrices[id] ?? p.price };
  });
  const validation = validateSquad(picks.map((x) => x.playerId), snapshot);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const spend = picks.reduce((a, x) => a + x.purchasePrice, 0);
  if (spend > budget) throw new Error(`Squad costs ${(spend / 10).toFixed(1)}m, over the ${(budget / 10).toFixed(1)}m budget.`);

  return { ...state, picks, bank: budget - spend,
    log: [...state.log, { gameweek: state.gameweek, type: 'initial', spend, bank: budget - spend }] };
}

/** Squad legality: 2/5/5/3 by position and no more than three from a club. */
export function validateSquad(playerIds, snapshot) {
  const errors = [];
  if (playerIds.length !== SQUAD_SIZE) errors.push(`Squad must have ${SQUAD_SIZE} players, has ${playerIds.length}.`);
  if (new Set(playerIds).size !== playerIds.length) errors.push('Squad contains a duplicate player.');

  const counts = { [GKP]: 0, [DEF]: 0, [MID]: 0, [FWD]: 0 };
  const clubs = new Map();
  for (const id of playerIds) {
    const p = snapshot.player(id);
    if (!p) { errors.push(`Unknown player id ${id}.`); continue; }
    counts[p.position]++;
    clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1);
  }
  for (const meta of Object.values(POSITIONS)) {
    if (counts[meta.id] !== meta.squad) {
      errors.push(`Need ${meta.squad} ${meta.short}, have ${counts[meta.id]}.`);
    }
  }
  for (const [teamId, n] of clubs) {
    if (n > MAX_PER_CLUB) {
      errors.push(`${snapshot.team(teamId)?.short ?? teamId}: ${n} players, limit is ${MAX_PER_CLUB}.`);
    }
  }
  return { valid: errors.length === 0, errors, counts, clubs };
}

/** What each pick would sell for right now, given FPL's half-of-the-rise rule. */
export function sellValue(pick, snapshot) {
  const current = snapshot.player(pick.playerId)?.price ?? pick.purchasePrice;
  return sellingPrice(pick.purchasePrice, current);
}

export function squadValue(state, snapshot) {
  const selling = state.picks.reduce((a, pick) => a + sellValue(pick, snapshot), 0);
  const market = state.picks.reduce((a, pick) => a + (snapshot.player(pick.playerId)?.price ?? 0), 0);
  return { selling, market, bank: state.bank, total: selling + state.bank };
}

/**
 * Apply a set of transfers.
 * @param {{out:number[], in:number[]}} transfers player ids
 * @returns {{state:object, cost:number, used:number, spend:number, proceeds:number}}
 */
export function applyTransfers(state, transfers, snapshot, { chip = state.activeChip } = {}) {
  const outIds = [...transfers.out];
  const inIds = [...transfers.in];
  if (outIds.length !== inIds.length) throw new Error('Transfers must be balanced: equal players in and out.');

  const owned = new Map(state.picks.map((p) => [p.playerId, p]));
  for (const id of outIds) if (!owned.has(id)) throw new Error(`Cannot sell ${label(id, snapshot)} - not in the squad.`);
  for (const id of inIds) {
    if (owned.has(id) && !outIds.includes(id)) throw new Error(`${label(id, snapshot)} is already in the squad.`);
    if (!snapshot.player(id)) throw new Error(`Unknown player id ${id}.`);
  }

  const proceeds = outIds.reduce((a, id) => a + sellValue(owned.get(id), snapshot), 0);
  const spend = inIds.reduce((a, id) => a + snapshot.player(id).price, 0);
  const bank = state.bank + proceeds - spend;
  if (bank < 0) throw new Error(`Short by £${((-bank) / 10).toFixed(1)}m for these transfers.`);

  const picks = state.picks
    .filter((p) => !outIds.includes(p.playerId))
    .concat(inIds.map((id) => ({ playerId: id, purchasePrice: snapshot.player(id).price })));

  const validation = validateSquad(picks.map((p) => p.playerId), snapshot);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const free = CHIPS[chip]?.unlimitedTransfers ? Infinity : state.freeTransfers;
  const used = outIds.length;
  const cost = Math.max(0, used - free) * TRANSFER_HIT || 0;
  // Wildcard and Free Hit leave banked free transfers untouched.
  const freeTransfers = CHIPS[chip]?.unlimitedTransfers
    ? state.freeTransfers
    : Math.max(0, state.freeTransfers - used);

  return {
    state: {
      ...state,
      picks,
      bank,
      freeTransfers,
      log: [...state.log, {
        gameweek: state.gameweek, type: 'transfers', chip,
        out: outIds, in: inIds, cost, proceeds, spend, bank,
      }],
    },
    cost, used, spend, proceeds,
  };
}

/**
 * Declare a chip for the current gameweek. The app never suggests this - it
 * only records what the manager has decided and feeds it to the projections.
 */
export function declareChip(state, chip, snapshot) {
  if (!CHIPS[chip]) throw new Error(`Unknown chip "${chip}".`);
  const half = chipHalf(state.gameweek);

  // A chip is only reserved while it is the active one. Changing your mind
  // before the deadline hands it back; advancing the gameweek spends it.
  const released = state.activeChip === 'none'
    ? state.chipsUsed[half]
    : state.chipsUsed[half].filter((c) => c !== state.activeChip);

  if (chip === 'none') {
    if (state.activeChip === 'none') return state;
    return {
      ...state,
      activeChip: 'none',
      freeHitRestore: null,
      chipsUsed: { ...state.chipsUsed, [half]: released },
      log: [...state.log, { gameweek: state.gameweek, type: 'chip-cleared', chip: state.activeChip }],
    };
  }

  if (released.includes(chip)) {
    throw new Error(`${CHIPS[chip].name} has already been used in the ${half} half of the season.`);
  }

  // A Free Hit squad reverts at the next deadline, so remember what to restore.
  const freeHitRestore = chip === 'freehit'
    ? { picks: state.picks.map((p) => ({ ...p })), bank: state.bank }
    : null;

  return {
    ...state,
    activeChip: chip,
    freeHitRestore,
    chipsUsed: { ...state.chipsUsed, [half]: [...released, chip] },
    log: [...state.log, { gameweek: state.gameweek, type: 'chip', chip }],
  };
}

export function availableChips(state) {
  const half = chipHalf(state.gameweek);
  const used = new Set(state.chipsUsed[half]);
  return Object.values(CHIPS)
    .filter((c) => c.id !== 'none')
    .map((c) => ({ ...c, used: used.has(c.id), half }));
}

/**
 * Roll into the next gameweek: restore a Free Hit squad, accrue a free
 * transfer up to the cap of five, and clear the active chip.
 */
export function advanceGameweek(state, { to = state.gameweek + 1 } = {}) {
  const restored = state.freeHitRestore
    ? { picks: state.freeHitRestore.picks, bank: state.freeHitRestore.bank }
    : {};
  return {
    ...state,
    ...restored,
    gameweek: to,
    activeChip: 'none',
    freeHitRestore: null,
    savedXi: null,
    freeTransfers: Math.min(MAX_FREE_TRANSFERS, state.freeTransfers + 1),
    log: [...state.log, { gameweek: to, type: 'advance', freeHitReverted: !!state.freeHitRestore }],
  };
}

/** Squad entries decorated with live price, sell value and projection hooks. */
export function squadPlayers(state, snapshot) {
  return state.picks.map((pick) => {
    const p = snapshot.player(pick.playerId);
    if (!p) throw new Error(`Player ${pick.playerId} is missing from the snapshot.`);
    return {
      ...p,
      purchasePrice: pick.purchasePrice,
      sellPrice: sellValue(pick, snapshot),
      team: snapshot.team(p.teamId),
    };
  });
}

function label(id, snapshot) {
  return snapshot.player(id)?.name ?? `player ${id}`;
}
