import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, legalSquadSpecs } from './fixtures.mjs';
import { GKP, DEF, MID, FWD, MAX_FREE_TRANSFERS } from '../js/rules.js';
import {
  emptyState, initialSquad, validateSquad, applyTransfers, declareChip,
  advanceGameweek, squadValue, sellValue, isPreSeason, freeTransfersAvailable,
} from '../js/squad.js';

/**
 * A snapshot with a legal 15 plus spare players to transfer in.
 * Gameweek 2 by default: gameweek 1 is pre-season, where transfers are free and
 * unlimited, so it is the wrong place to test transfer economics.
 */
function setup(extra = [], overrides = {}, gameweek = 2) {
  const specs = [...legalSquadSpecs(overrides), ...extra];
  const snapshot = buildSnapshot({ playerSpecs: specs });
  const state = initialSquad(emptyState(gameweek), legalSquadSpecs().map((s) => s.id), snapshot);
  return { snapshot, state };
}

test('an opening squad spends from the £100.0m budget and banks the rest', () => {
  const { snapshot, state } = setup();
  const spend = legalSquadSpecs().reduce((a, s) => a + s.price, 0);
  assert.equal(state.bank, 1000 - spend);
  assert.equal(state.picks.length, 15);
});

test('squad validation enforces 2/5/5/3 and the three-per-club limit', () => {
  const specs = legalSquadSpecs();
  const snapshot = buildSnapshot({ playerSpecs: [...specs, { id: 99, position: FWD, team: 1, price: 50 }] });

  assert.ok(validateSquad(specs.map((s) => s.id), snapshot).valid);

  const wrongShape = [...specs.map((s) => s.id).slice(0, 14), 99];  // 4 forwards, 4 mids
  assert.equal(validateSquad(wrongShape, snapshot).valid, false);

  const clubHeavy = buildSnapshot({
    playerSpecs: legalSquadSpecs(Object.fromEntries([1, 2, 3, 4].map((i) => [i, { team: 1 }]))),
  });
  const result = validateSquad(legalSquadSpecs().map((s) => s.id), clubHeavy);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /limit is 3/.test(e)));
});

test('a transfer moves money at the selling price, not the purchase price', () => {
  const { snapshot, state } = setup([{ id: 90, position: MID, team: 20, price: 60 }]);
  // Player 8 is a midfielder bought at 52; his price rises to 56.
  snapshot.player(8).price = 56;
  assert.equal(sellValue(state.picks.find((p) => p.playerId === 8), snapshot), 54);

  const before = state.bank;
  const { state: after, cost } = applyTransfers(state, { out: [8], in: [90] }, snapshot);
  assert.equal(cost, 0, 'one transfer with one free transfer costs nothing');
  assert.equal(after.bank, before + 54 - 60);
  assert.equal(after.freeTransfers, 0);
  assert.ok(after.picks.some((p) => p.playerId === 90));
  assert.equal(after.picks.find((p) => p.playerId === 90).purchasePrice, 60);
});

test('a second transfer in the same gameweek costs four points', () => {
  const { snapshot, state } = setup([
    { id: 90, position: MID, team: 20, price: 45 },
    { id: 91, position: MID, team: 20, price: 45 },
  ]);
  const { cost, used } = applyTransfers(state, { out: [8, 9], in: [90, 91] }, snapshot);
  assert.equal(used, 2);
  assert.equal(cost, 4);
});

test('transfers that break the budget or the club limit are refused', () => {
  const { snapshot, state } = setup([
    { id: 90, position: MID, team: 20, price: 400 },   // more than bank plus sale proceeds
    { id: 91, position: MID, team: 1, price: 45 },
  ]);
  assert.throws(() => applyTransfers(state, { out: [8], in: [90] }, snapshot), /Short by/);
  // Team 1 already has three squad players (ids 1, 7, 13).
  assert.throws(() => applyTransfers(state, { out: [8], in: [91] }, snapshot), /limit is 3/);
});

test('a transfer must be balanced and cannot re-buy an owned player', () => {
  const { snapshot, state } = setup([{ id: 90, position: MID, team: 20, price: 45 }]);
  assert.throws(() => applyTransfers(state, { out: [8], in: [] }, snapshot), /balanced/);
  assert.throws(() => applyTransfers(state, { out: [8], in: [9] }, snapshot), /already in the squad/);
  assert.throws(() => applyTransfers(state, { out: [99], in: [90] }, snapshot), /not in the squad/);
});

test('free transfers accrue to a cap of five', () => {
  const { state } = setup();
  let s = { ...state, freeTransfers: 1 };
  for (let i = 0; i < 10; i++) s = advanceGameweek(s);
  assert.equal(s.freeTransfers, MAX_FREE_TRANSFERS);
  assert.equal(s.gameweek, 12);
});

test('a wildcard makes transfers free and keeps the banked ones', () => {
  const { snapshot, state } = setup([
    { id: 90, position: MID, team: 20, price: 45 },
    { id: 91, position: MID, team: 20, price: 45 },
    { id: 92, position: MID, team: 20, price: 45 },
  ]);
  const wild = declareChip({ ...state, freeTransfers: 2 }, 'wildcard', snapshot);
  const { state: after, cost } = applyTransfers(wild, { out: [8, 9, 10], in: [90, 91, 92] }, snapshot);
  assert.equal(cost, 0, 'no hits on a wildcard');
  assert.equal(after.freeTransfers, 2, 'banked transfers survive a wildcard');
});

test('a free hit squad reverts at the next deadline', () => {
  const { snapshot, state } = setup([{ id: 90, position: MID, team: 20, price: 45 }]);
  const fh = declareChip(state, 'freehit', snapshot);
  const { state: after } = applyTransfers(fh, { out: [8], in: [90] }, snapshot);
  assert.ok(after.picks.some((p) => p.playerId === 90));

  const next = advanceGameweek(after);
  assert.ok(next.picks.some((p) => p.playerId === 8), 'the original squad is back');
  assert.ok(!next.picks.some((p) => p.playerId === 90));
  assert.equal(next.bank, state.bank);
});

test('a chip cannot be used twice in the same half, and only one is ever active', () => {
  const { snapshot, state } = setup();
  const used = declareChip(state, 'bboost', snapshot);

  // Already spent in an earlier gameweek of this half.
  assert.throws(() => declareChip({ ...used, activeChip: 'none' }, 'bboost', snapshot), /already been used/);

  // Only one chip can be active, so switching replaces rather than stacks.
  const switched = declareChip(used, '3xc', snapshot);
  assert.equal(switched.activeChip, '3xc');
  assert.deepEqual(switched.chipsUsed.first, ['3xc']);

  // The second half gets a fresh set.
  const secondHalf = { ...used, gameweek: 20, activeChip: 'none' };
  assert.doesNotThrow(() => declareChip(secondHalf, 'bboost', snapshot));
});

test('squad value separates selling value from market value', () => {
  const { snapshot, state } = setup();
  snapshot.player(8).price = 56;   // bought at 52
  const value = squadValue(state, snapshot);
  assert.equal(value.market - value.selling, 2, 'half the £0.4m rise is not yours');
  assert.equal(value.total, value.selling + state.bank);
});

test('a chip is only spent once the gameweek moves on', () => {
  const { snapshot, state } = setup();

  // Declared, then thought better of it: the chip comes back.
  const declared = declareChip(state, '3xc', snapshot);
  assert.deepEqual(declared.chipsUsed.first, ['3xc']);
  const cleared = declareChip(declared, 'none', snapshot);
  assert.deepEqual(cleared.chipsUsed.first, []);
  assert.equal(cleared.activeChip, 'none');
  assert.doesNotThrow(() => declareChip(cleared, '3xc', snapshot));

  // Switching straight to another chip also releases the first.
  const switched = declareChip(declared, 'bboost', snapshot);
  assert.deepEqual(switched.chipsUsed.first, ['bboost']);
  assert.equal(switched.activeChip, 'bboost');

  // Once the gameweek advances the chip is gone for that half.
  const spent = advanceGameweek(switched);
  assert.deepEqual(spent.chipsUsed.first, ['bboost']);
  assert.equal(spent.activeChip, 'none');
  assert.throws(() => declareChip(spent, 'bboost', snapshot), /already been used/);
});

test('a squad whose players have risen since purchase is still within budget', () => {
  const specs = legalSquadSpecs();
  const snapshot = buildSnapshot({ playerSpecs: specs });
  const paid = Object.fromEntries(specs.map((s) => [s.id, s.price]));

  // Every player rises £1.0m after being bought.
  for (const spec of specs) snapshot.player(spec.id).price = spec.price + 10;

  const state = initialSquad(emptyState(1), specs.map((s) => s.id), snapshot,
    { purchasePrices: paid });
  const spent = specs.reduce((a, s) => a + s.price, 0);
  assert.equal(state.bank, 1000 - spent, 'the bank reflects what was paid');

  const value = squadValue(state, snapshot);
  assert.equal(value.market - value.selling, 15 * 5, 'half of each £1.0m rise is withheld');
  assert.ok(value.market > spent, 'the squad is worth more than it cost');
});


// ── Before the first deadline ──────────────────────────────────────────────

test('there are no free transfers before the gameweek 1 deadline', () => {
  const { state } = setup([], {}, 1);
  assert.ok(isPreSeason(state));
  assert.equal(freeTransfersAvailable(state), Infinity, 'rebuild as often as you like');
  assert.equal(state.freeTransfers, 0, 'nothing banked, because nothing has been granted');
});

test('pre-season transfers are free however many you make', () => {
  const { snapshot, state } = setup([
    { id: 90, position: MID, team: 20, price: 45 },
    { id: 91, position: MID, team: 20, price: 45 },
    { id: 92, position: MID, team: 20, price: 45 },
  ], {}, 1);

  const { state: after, cost } = applyTransfers(state, { out: [8, 9, 10], in: [90, 91, 92] }, snapshot);
  assert.equal(cost, 0, 'no hit before the first deadline');
  assert.equal(after.freeTransfers, 0, 'and nothing is deducted');
});

test('the first free transfer arrives with gameweek 2', () => {
  const { state } = setup([], {}, 1);
  const gw2 = advanceGameweek(state);
  assert.equal(gw2.gameweek, 2);
  assert.equal(gw2.freeTransfers, 1, 'exactly one, not one on top of a phantom allowance');
  assert.equal(freeTransfersAvailable(gw2), 1);

  const gw3 = advanceGameweek(gw2);
  assert.equal(gw3.freeTransfers, 2, 'and it accrues normally from there');
});

test('joining mid-season starts with one free transfer, not unlimited', () => {
  const { state } = setup([], {}, 10);
  assert.equal(isPreSeason(state), false);
  assert.equal(freeTransfersAvailable(state), 1);
});

test('a second transfer in gameweek 2 does cost four points', () => {
  const { snapshot, state } = setup([
    { id: 90, position: MID, team: 20, price: 45 },
    { id: 91, position: MID, team: 20, price: 45 },
  ], {}, 2);
  const { cost } = applyTransfers(state, { out: [8, 9], in: [90, 91] }, snapshot);
  assert.equal(cost, 4);
});
