import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, legalSquadSpecs } from './fixtures.mjs';
import { MID, FWD, DEF } from '../js/rules.js';
import { emptyState, initialSquad, declareChip } from '../js/squad.js';
import { planTransfers, combinations, describe } from '../js/transfers.js';

/** Squad of ordinary players plus a shortlist of named candidates. */
function setup(candidates, { freeTransfers = 1, squadOverrides = {}, bank = null, gameweek = 2 } = {}) {
  const specs = [...legalSquadSpecs(squadOverrides), ...candidates];
  const snapshot = buildSnapshot({ playerSpecs: specs });
  let state = initialSquad(emptyState(gameweek), legalSquadSpecs().map((s) => s.id), snapshot);
  state = { ...state, freeTransfers, ...(bank == null ? {} : { bank }) };
  return { snapshot, state };
}

const OPTS = { epBlend: 0, horizon: 6, minutesPrior: 80, fromGameweek: 1 };

test('an obviously better candidate is recommended for the free transfer', () => {
  // Player 8 is a replacement-level midfielder; candidate 90 is elite and affordable.
  const { snapshot, state } = setup([
    { id: 90, name: 'Elite', position: MID, team: 20, price: 55, xG90: 0.7, xA90: 0.4, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0, xA90: 0, price: 55 } } });

  const result = planTransfers(state, snapshot, [90], OPTS);
  assert.equal(result.recommendation.action, 'transfer');
  const plan = result.recommendation.plan;
  assert.equal(plan.transfers, 1);
  assert.equal(plan.transfersIn[0].id, 90);
  assert.equal(plan.hits, 0);
  assert.ok(plan.netGain > 1, `expected a clear gain, got ${plan.netGain}`);
});

test('a marginal candidate is rejected and the transfer is rolled', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Similar', position: MID, team: 20, price: 55, xG90: 0.20, xA90: 0.15, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0.19, xA90: 0.15, price: 55 } } });

  const result = planTransfers(state, snapshot, [90], OPTS);
  assert.equal(result.recommendation.action, 'hold');
  assert.match(result.recommendation.headline, /Roll your transfer/);
});

test('a hit is taken only when the gain clears the four points', () => {
  const candidates = [
    { id: 90, name: 'BigA', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
    { id: 91, name: 'BigB', position: MID, team: 19, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
  ];
  const dead = { xG90: 0, xA90: 0, price: 55, minutes: 900 };
  const { snapshot, state } = setup(candidates, { squadOverrides: { 8: dead, 9: dead } });

  const takesHit = planTransfers(state, snapshot, [90, 91], OPTS);
  assert.equal(takesHit.recommendation.plan.transfers, 2);
  assert.equal(takesHit.recommendation.plan.hits, 4);
  assert.ok(takesHit.recommendation.plan.netGain > 0);

  // The same two moves with two free transfers should cost nothing.
  const free = planTransfers({ ...state, freeTransfers: 2 }, snapshot, [90, 91], OPTS);
  assert.equal(free.recommendation.plan.hits, 0);
});

test('a hit that does not pay for itself is not recommended', () => {
  const candidates = [
    { id: 90, name: 'Good', position: MID, team: 20, price: 55, xG90: 0.7, xA90: 0.4, minutes: 900 },
    { id: 91, name: 'Meh', position: MID, team: 19, price: 55, xG90: 0.21, xA90: 0.15, minutes: 900 },
  ];
  const { snapshot, state } = setup(candidates, {
    squadOverrides: { 8: { xG90: 0, xA90: 0, price: 55 }, 9: { xG90: 0.20, xA90: 0.15, price: 55 } },
  });
  const result = planTransfers(state, snapshot, [90, 91], OPTS);
  assert.equal(result.recommendation.plan.transfers, 1, 'only the move that pays is taken');
  assert.equal(result.recommendation.plan.transfersIn[0].id, 90);
});

test('the planner never proposes a move it cannot afford', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Unaffordable', position: MID, team: 20, price: 400, xG90: 1.2, xA90: 0.8, minutes: 900 },
  ], { bank: 0, squadOverrides: { 8: { xG90: 0, xA90: 0 } } });

  const result = planTransfers(state, snapshot, [90], OPTS);
  assert.equal(result.recommendation.action, 'hold');
  assert.ok(result.plans.every((p) => p.transfers === 0), 'no affordable plan exists');
});

test('the planner never breaks the three-per-club limit', () => {
  // Rearranged so club 1 holds exactly three players, one of them a midfielder.
  // The candidate is a fourth club-1 player, so the only legal way to sign him
  // is to sell the club-1 midfielder - no other single swap keeps both the
  // position counts and the club limit intact.
  const { snapshot, state } = setup([
    { id: 90, name: 'FourthFromClub', position: MID, team: 1, price: 55, xG90: 0.9, xA90: 0.5, minutes: 900 },
  ], {
    squadOverrides: {
      7: { team: 7 },                                        // club 1 drops to two
      8: { team: 1, xG90: 0.02, xA90: 0.02, price: 55 },      // club 1 back to three
    },
  });

  const result = planTransfers(state, snapshot, [90], OPTS);
  const withCandidate = result.plans.filter((plan) => plan.transfersIn.some((p) => p.id === 90));

  assert.ok(withCandidate.length > 0, 'the legal swap should be found');
  for (const plan of withCandidate) {
    assert.deepEqual(plan.transfersOut.map((p) => p.id), [8],
      'only the club-1 midfielder can make room');
  }
  assert.equal(result.recommendation.plan.transfersIn[0].id, 90);
});

test('positions must balance: a forward cannot simply replace a midfielder', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Striker', position: FWD, team: 20, price: 55, xG90: 0.9, xA90: 0.3, minutes: 900 },
  ], { squadOverrides: { 13: { xG90: 0, xA90: 0, price: 55 } } });

  const result = planTransfers(state, snapshot, [90], OPTS);
  for (const plan of result.plans) {
    if (plan.transfers === 0) continue;
    assert.ok(plan.transfersOut.every((p) => p.position === FWD),
      'a single incoming forward can only replace a forward');
  }
});

test('a wildcard removes hits and lets every shortlisted move through', () => {
  const dead = { xG90: 0, xA90: 0, price: 55, minutes: 900 };
  const candidates = [90, 91, 92].map((id, i) => ({
    id, name: `Big${id}`, position: MID, team: 20 - i, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900,
  }));
  const { snapshot, state } = setup(candidates, {
    freeTransfers: 1, squadOverrides: { 8: dead, 9: dead, 10: dead },
  });

  const wild = declareChip(state, 'wildcard', snapshot);
  const result = planTransfers(wild, snapshot, [90, 91, 92], OPTS);
  assert.equal(result.recommendation.plan.transfers, 3);
  assert.equal(result.recommendation.plan.hits, 0);
});

test('a free hit values the new squad for one gameweek only', () => {
  const dead = { xG90: 0, xA90: 0, price: 55, minutes: 900 };
  const candidate = { id: 90, name: 'OneWeek', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 };
  const { snapshot, state } = setup([candidate], { squadOverrides: { 8: dead } });

  const normal = planTransfers(state, snapshot, [90], OPTS);
  const freeHit = planTransfers(declareChip(state, 'freehit', snapshot), snapshot, [90], OPTS);

  const gain = (r) => r.plans.find((p) => p.transfers === 1).rawGain;
  assert.ok(gain(freeHit) < gain(normal),
    'a free hit only banks the first gameweek, so it is worth less than a permanent move');
  assert.ok(gain(freeHit) > 0);
});

test('triple captain lifts the projection for the chipped gameweek', () => {
  const { snapshot, state } = setup([], { squadOverrides: { 8: { xG90: 1.0, xA90: 0.5 } } });
  const plain = planTransfers(state, snapshot, [], OPTS);
  const tripled = planTransfers(declareChip(state, '3xc', snapshot), snapshot, [], OPTS);
  assert.ok(tripled.baseline.total > plain.baseline.total);
});

test('bench boost adds the bench to the chipped gameweek', () => {
  const { snapshot, state } = setup([], {});
  const plain = planTransfers(state, snapshot, [], OPTS);
  const boosted = planTransfers(declareChip(state, 'bboost', snapshot), snapshot, [], OPTS);
  assert.ok(boosted.baseline.total > plain.baseline.total);
});

test('combinations enumerates without repeats', () => {
  const items = [1, 2, 3, 4];
  assert.equal([...combinations(items, 0)].length, 1);
  assert.equal([...combinations(items, 2)].length, 6);
  assert.equal([...combinations(items, 4)].length, 1);
  assert.equal([...combinations(items, 5)].length, 0);
});

test('plans are described in a readable way', () => {
  assert.equal(describe({ transfers: 0 }), 'No transfers');
  assert.equal(describe({ transfers: 1, transfersOut: [{ name: 'A' }], transfersIn: [{ name: 'B' }] }), 'A → B');
});

test('doing nothing always scores exactly zero net gain', () => {
  const candidate = { id: 90, name: 'Option', position: MID, team: 20, price: 55, xG90: 0.5, xA90: 0.3, minutes: 900 };

  for (const [chipName, chip] of [['no chip', null], ['wildcard', 'wildcard'], ['free hit', 'freehit']]) {
    const { snapshot, state } = setup([candidate], { freeTransfers: 3 });
    const withChip = chip ? declareChip(state, chip, snapshot) : state;
    const result = planTransfers(withChip, snapshot, [90], OPTS);
    const hold = result.plans.find((p) => p.transfers === 0);
    assert.ok(Math.abs(hold.netGain) < 1e-9,
      `${chipName}: holding should be the zero point, got ${hold.netGain}`);
  }
});

// ── Protected players ──────────────────────────────────────────────────────

test('a protected player is never proposed for transfer out', () => {
  // Squad midfielder 8 is dead weight, but protected; 9 is the next weakest.
  const { snapshot, state } = setup([
    { id: 90, name: 'Upgrade', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
  ], {
    squadOverrides: {
      8: { xG90: 0, xA90: 0, price: 55 },
      9: { xG90: 0.05, xA90: 0.05, price: 55 },
    },
  });

  const open = planTransfers(state, snapshot, [90], OPTS);
  assert.equal(open.recommendation.plan.transfersOut[0].id, 8, 'unprotected, the worst player goes');

  const guarded = planTransfers({ ...state, protectedIds: [8] }, snapshot, [90], OPTS);
  assert.equal(guarded.recommendation.plan.transfersOut[0].id, 9, 'protected, the next worst goes');
  for (const plan of guarded.plans) {
    assert.ok(!plan.transfersOut.some((p) => p.id === 8), 'no plan may sell a protected player');
  }
});

test('protecting someone reports what it costs', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Upgrade', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
  ], {
    squadOverrides: {
      8: { xG90: 0, xA90: 0, price: 55 },
      9: { xG90: 0.24, xA90: 0.19, price: 55 },
    },
  });

  const guarded = planTransfers({ ...state, protectedIds: [8] }, snapshot, [90], OPTS);
  assert.ok(guarded.protectionCost, 'the blocked better move should be reported');
  assert.deepEqual(guarded.protectionCost.players.map((p) => p.id), [8]);
  assert.ok(guarded.protectionCost.forgone > 0);
  assert.ok(guarded.blockedPlans > 0);
});

test('nothing is reported when protection costs nothing', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Upgrade', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0, xA90: 0, price: 55 } } });

  // Protecting the captain, who was never going to be sold anyway.
  const guarded = planTransfers({ ...state, protectedIds: [13] }, snapshot, [90], OPTS);
  assert.equal(guarded.protectionCost, null);
  assert.equal(guarded.recommendation.plan.transfersOut[0].id, 8);
});

test('protecting every candidate exit leaves holding as the only option', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Upgrade', position: MID, team: 20, price: 55, xG90: 0.9, xA90: 0.5, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0, xA90: 0, price: 55 } } });

  // Every midfielder protected, so no incoming midfielder can be accommodated.
  const guarded = planTransfers({ ...state, protectedIds: [8, 9, 10, 11, 12] }, snapshot, [90], OPTS);
  assert.equal(guarded.recommendation.action, 'hold');
  assert.ok(guarded.plans.every((p) => p.transfers === 0));
  assert.ok(guarded.protectionCost, 'and it should say the protection is what blocked it');
});

test('protection applies on a wildcard too', () => {
  const dead = { xG90: 0, xA90: 0, price: 55, minutes: 900 };
  const candidates = [90, 91].map((id, i) => ({
    id, name: `Big${id}`, position: MID, team: 20 - i, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900,
  }));
  const { snapshot, state } = setup(candidates, { squadOverrides: { 8: dead, 9: dead } });

  const wild = declareChip({ ...state, protectedIds: [8] }, 'wildcard', snapshot);
  const result = planTransfers(wild, snapshot, [90, 91], OPTS);
  for (const plan of result.plans) {
    assert.ok(!plan.transfersOut.some((p) => p.id === 8), 'a wildcard does not override protection');
  }
});

test('protecting a player you do not own has no effect on the planner', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Upgrade', position: MID, team: 20, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0, xA90: 0, price: 55 } } });

  // Id 90 is the incoming candidate, not a squad member.
  const result = planTransfers({ ...state, protectedIds: [90, 12345] }, snapshot, [90], OPTS);
  assert.equal(result.recommendation.plan.transfersOut[0].id, 8, 'the normal move still stands');
  assert.equal(result.protectionCost, null);
  assert.equal(result.blockedPlans, 0);
});


test('before the first deadline the planner takes no hits and does not talk about rolling', () => {
  const dead = { xG90: 0, xA90: 0, price: 55, minutes: 900 };
  const candidates = [90, 91].map((id, i) => ({
    id, name: `Star${id}`, position: MID, team: 20 - i, price: 55, xG90: 0.8, xA90: 0.5, minutes: 900,
  }));
  const { snapshot, state } = setup(candidates, { squadOverrides: { 8: dead, 9: dead }, gameweek: 1 });

  const result = planTransfers(state, snapshot, [90, 91], OPTS);
  assert.ok(result.preSeason);
  assert.equal(result.recommendation.plan.transfers, 2, 'both upgrades, with nothing to pay');
  assert.equal(result.recommendation.plan.hits, 0);
  for (const plan of result.plans) assert.equal(plan.hits, 0, 'no plan can incur a hit pre-season');
});

test('a pre-season hold does not offer to roll a transfer that does not exist', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Similar', position: MID, team: 20, price: 55, xG90: 0.20, xA90: 0.15, minutes: 900 },
  ], { squadOverrides: { 8: { xG90: 0.19, xA90: 0.15, price: 55 } }, gameweek: 1 });

  const result = planTransfers(state, snapshot, [90], OPTS);
  assert.equal(result.recommendation.action, 'hold');
  assert.doesNotMatch(result.recommendation.headline, /Roll your transfer/);
  assert.match(result.recommendation.headline, /still free until the Gameweek 1 deadline/);
});
