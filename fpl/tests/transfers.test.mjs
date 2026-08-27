import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, legalSquadSpecs } from './fixtures.mjs';
import { GKP, MID, FWD, DEF, POSITIONS, MAX_PER_CLUB, SQUAD_SIZE } from '../js/rules.js';
import { horizonWeight, DEFAULTS as XP_DEFAULTS } from '../js/xp.js';
import { emptyState, initialSquad, declareChip } from '../js/squad.js';
import { planTransfers, combinations, describe, PLANNER_DEFAULTS } from '../js/transfers.js';

/** Squad of ordinary players plus a shortlist of named candidates. */
function setup(candidates, { freeTransfers = 1, squadOverrides = {}, bank = null, gameweek = 2 } = {}) {
  const specs = [...legalSquadSpecs(squadOverrides), ...candidates];
  const snapshot = buildSnapshot({ playerSpecs: specs });
  let state = initialSquad(emptyState(gameweek), legalSquadSpecs().map((s) => s.id), snapshot);
  state = { ...state, freeTransfers, ...(bank == null ? {} : { bank }) };
  return { snapshot, state };
}

// These exercise the planner, so they use the built-in model rather than
// depending on projections published by anyone else.
const OPTS = { source: 'model', epBlend: 0, horizon: 6, minutesPrior: 80, fromGameweek: 1 };

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

// ── Defaults ───────────────────────────────────────────────────────────────

test('the defaults are five gameweeks, no value on a banked transfer, no bar', () => {
  assert.equal(PLANNER_DEFAULTS.horizon, 5);
  assert.equal(PLANNER_DEFAULTS.freeTransferValue, 0);
  assert.equal(PLANNER_DEFAULTS.minimumGain, 0);
});

test('the horizon starts at the gameweek being set up', () => {
  const { snapshot, state } = setup([], { gameweek: 4 });
  const result = planTransfers(state, snapshot, [], { source: 'model', epBlend: 0 });
  assert.deepEqual(result.gameweeks, [4, 5, 6, 7, 8]);
});

/**
 * A candidate a shade better than a squad player certain to be in the eleven.
 * He shares that player's club and price, so the only difference between them
 * is the margin - not their fixtures.
 */
function marginalUpgrade(margin) {
  // Same club, price, bonus and defensive rate as the man he replaces, so the
  // margin is the only thing between them.
  const candidate = { id: 90, name: 'Slightly better', position: MID, team: 2, price: 55,
    xG90: 0.50 + margin, xA90: 0.30, dc90: 6, bonus: 10, minutes: 900 };
  return setup([candidate], {
    squadOverrides: { 8: { xG90: 0.50, xA90: 0.30, price: 55, minutes: 900 } },
  });
}

test('a slim but genuine improvement is now recommended', () => {
  const { snapshot, state } = marginalUpgrade(0.02);
  const result = planTransfers(state, snapshot, [90], { source: 'model', epBlend: 0, fromGameweek: 1 });

  assert.equal(result.recommendation.action, 'transfer');
  assert.equal(result.recommendation.plan.transfersIn[0].id, 90);
  const gain = result.recommendation.plan.netGain;
  assert.ok(gain > 0 && gain < 0.5,
    `expected a gain under the old half-point bar, got ${gain.toFixed(3)}`);
});

test('a move worth nothing at all is still a hold', () => {
  const { snapshot, state } = marginalUpgrade(0);
  const result = planTransfers(state, snapshot, [90], { source: 'model', epBlend: 0, fromGameweek: 1 });
  assert.equal(result.recommendation.action, 'hold');
  assert.doesNotMatch(result.recommendation.headline, /0\.0-point bar/);
  assert.match(result.recommendation.headline, /improves on your squad/);
});

test('a move that makes the squad worse is a hold', () => {
  const { snapshot, state } = marginalUpgrade(-0.05);
  const result = planTransfers(state, snapshot, [90], { source: 'model', epBlend: 0, fromGameweek: 1 });
  assert.equal(result.recommendation.action, 'hold');
});

test('a bar can still be set, and then it applies', () => {
  const { snapshot, state } = marginalUpgrade(0.02);
  const withBar = planTransfers(state, snapshot, [90],
    { source: 'model', epBlend: 0, fromGameweek: 1, minimumGain: 0.5 });
  assert.equal(withBar.recommendation.action, 'hold');
  assert.match(withBar.recommendation.headline, /gains only 0\.\d\d points/,
    'and says what the move was actually worth');
});

test('holding no longer earns a bonus for keeping the transfer', () => {
  const { snapshot, state } = marginalUpgrade(0.02);
  const opts = { source: 'model', epBlend: 0, fromGameweek: 1 };

  const neutral = planTransfers(state, snapshot, [90], opts);
  const valued = planTransfers(state, snapshot, [90], { ...opts, freeTransferValue: 0.8 });

  assert.equal(neutral.recommendation.action, 'transfer');
  assert.equal(valued.recommendation.action, 'hold',
    'putting a price on the banked transfer would still hold it back');
  assert.ok(neutral.plans[0].netGain > valued.plans[0].netGain);
});

// ── Plans are scored on the eleven, not the fifteen ────────────────────────

/**
 * A squad with points set player by player, plus two candidates. Everyone is
 * on a club of his own so nothing but the points distinguishes them.
 */
function pointsScenario(points, weekly = null) {
  const spec = (id, position, team) => ({ id, name: `P${id}`, position, team, price: 50 });
  const squad = [
    spec(1, GKP, 1), spec(2, GKP, 2),
    spec(3, DEF, 3), spec(4, DEF, 4), spec(5, DEF, 5), spec(6, DEF, 6), spec(7, DEF, 7),
    spec(8, MID, 8), spec(9, MID, 9), spec(10, MID, 10), spec(11, MID, 11), spec(12, MID, 12),
    spec(13, FWD, 13), spec(14, FWD, 14), spec(15, FWD, 15),
  ];
  const candidates = [spec(90, MID, 16), spec(91, MID, 17)];
  const snapshot = buildSnapshot({ playerSpecs: [...squad, ...candidates], teams: 20 });

  const predicted = {};
  for (const [id, value] of Object.entries(points)) {
    predicted[id] = weekly?.[id] ?? { 1: value, 2: value, 3: value, 4: value, 5: value };
  }

  let state = initialSquad(emptyState(1), squad.map((s) => s.id), snapshot);
  state = { ...state, freeTransfers: 2 };
  return { snapshot, state, predicted, squadIds: squad.map((s) => s.id) };
}

const FLAT = {
  1: 4.0, 2: 1.0,
  3: 5.0, 4: 4.5, 5: 4.0, 6: 3.5, 7: 1.0,
  8: 6.0, 9: 5.0, 10: 4.0, 11: 3.0, 12: 0.5,
  13: 7.0, 14: 5.0, 15: 1.0,
  90: 8.0,   // a real upgrade on the midfielder he replaces
  91: 0.6,   // barely better than the man he replaces, and benched either way
};

test('a plan is worth the change in the optimised eleven, not in the fifteen', () => {
  const { snapshot, state, predicted } = pointsScenario(FLAT);
  const result = planTransfers(state, snapshot, [90, 91],
    { source: 'predicted', predicted, horizon: 5, fromGameweek: 1 });

  const plan = result.plans.find((p) => p.transfers === 2
    && p.transfersIn.some((x) => x.id === 90) && p.transfersIn.some((x) => x.id === 91));
  assert.ok(plan, 'the two-transfer plan should be among those considered');

  const weightSum = [0, 1, 2, 3, 4]
    .reduce((a, i) => a + horizonWeight(i, XP_DEFAULTS.horizonDecay), 0);

  // Both incoming midfielders replace midfielders, and P91 sits on the bench
  // before and after, so his points never reach the eleven.
  const outIds = plan.transfersOut.map((p) => p.id);
  const naive = (FLAT[90] + FLAT[91] - outIds.reduce((a, id) => a + FLAT[id], 0)) * weightSum;

  assert.ok(Math.abs(plan.netGain - naive) > 1,
    `scored on the fifteen (${naive.toFixed(2)}) rather than the eleven`);
  assert.ok(plan.netGain > naive,
    'and the eleven is worth more here, because the upgrade also takes the armband');
});

test('a signing who never makes the eleven is worth nothing', () => {
  // P91 replaces the weakest midfielder and is still too weak to start.
  const { snapshot, state, predicted } = pointsScenario({ ...FLAT, 91: 0.6 });
  const result = planTransfers(state, snapshot, [91],
    { source: 'predicted', predicted, horizon: 5, fromGameweek: 1 });

  const plan = result.plans.find((p) => p.transfers === 1);
  assert.ok(Math.abs(plan.netGain) < 1e-9,
    `a bench-to-bench swap should be worth nothing, got ${plan.netGain}`);
  assert.equal(result.recommendation.action, 'hold');
});

test('a signing benched some weeks and starting others counts only when he starts', () => {
  // P91 is poor in gameweeks 1-3 and excellent in 4-5, so he should be worth
  // exactly what he adds in the two weeks he displaces someone.
  const weekly = { 91: { 1: 0.5, 2: 0.5, 3: 0.5, 4: 9.0, 5: 9.0 } };
  const { snapshot, state, predicted } = pointsScenario({ ...FLAT, 91: 0.5 }, weekly);
  const result = planTransfers(state, snapshot, [91],
    { source: 'predicted', predicted, horizon: 5, fromGameweek: 1 });

  const plan = result.plans.find((p) => p.transfers === 1);
  assert.ok(plan.netGain > 0, 'the two strong weeks are worth having');

  // Weeks 1-3 change nothing; weeks 4 and 5 he starts and takes the armband
  // from the 7.0 forward, so each is worth (9.0 - 3.0) for the place plus
  // (9.0 - 7.0) for the captaincy.
  const expected = (6 + 2) * (horizonWeight(3, XP_DEFAULTS.horizonDecay)
    + horizonWeight(4, XP_DEFAULTS.horizonDecay));
  assert.ok(Math.abs(plan.netGain - expected) < 1e-6,
    `expected ${expected.toFixed(3)} from the weeks he starts, got ${plan.netGain.toFixed(3)}`);
});

// ── Every plan offered must be a legal squad ───────────────────────────────

test('no plan the planner offers breaks any squad rule', () => {
  // Loaded against the rules on purpose: three players already from club 1, an
  // empty bank, five free transfers, and candidates that each break something.
  const spec = (id, position, team, price) => ({ id, name: `P${id}`, position, team, price });
  const squad = [
    spec(1, GKP, 1, 45), spec(2, GKP, 2, 40),
    spec(3, DEF, 1, 50), spec(4, DEF, 1, 50), spec(5, DEF, 3, 50), spec(6, DEF, 4, 50), spec(7, DEF, 5, 50),
    spec(8, MID, 6, 50), spec(9, MID, 7, 50), spec(10, MID, 8, 50), spec(11, MID, 9, 50), spec(12, MID, 10, 50),
    spec(13, FWD, 11, 60), spec(14, FWD, 12, 60), spec(15, FWD, 13, 60),
  ];
  const candidates = [
    spec(90, DEF, 1, 50),     // would be a fourth from club 1
    spec(91, FWD, 14, 300),   // far beyond the bank
    spec(92, MID, 15, 50),
    spec(93, DEF, 16, 50),
    spec(94, GKP, 17, 50),
  ];
  const snapshot = buildSnapshot({ playerSpecs: [...squad, ...candidates], teams: 20 });

  // Every candidate looks irresistible, so only the rules can stop them.
  const predicted = {};
  for (const p of squad) predicted[p.id] = { 1: 9, 2: 9, 3: 9, 4: 9, 5: 9 };
  for (const p of candidates) predicted[p.id] = { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 };

  let state = initialSquad(emptyState(2), squad.map((s) => s.id), snapshot);
  state = { ...state, freeTransfers: 5, bank: 0 };

  const result = planTransfers(state, snapshot, candidates.map((c) => c.id),
    { source: 'predicted', predicted, horizon: 5, maxHits: 3 });

  assert.ok(result.plans.length > 1, 'there should be something to check');

  for (const plan of result.plans) {
    const out = new Set(plan.transfersOut.map((p) => p.id));
    const next = [...squad.filter((p) => !out.has(p.id)), ...plan.transfersIn];
    const move = `${plan.transfersOut.map((p) => p.name).join(',') || 'none'} → ${plan.transfersIn.map((p) => p.name).join(',') || 'none'}`;

    assert.equal(next.length, SQUAD_SIZE, `${move}: squad is not fifteen`);
    assert.equal(new Set(next.map((p) => p.id)).size, SQUAD_SIZE, `${move}: a duplicate player`);

    const counts = {};
    for (const p of next) counts[p.position] = (counts[p.position] ?? 0) + 1;
    for (const meta of Object.values(POSITIONS)) {
      assert.equal(counts[meta.id] ?? 0, meta.squad, `${move}: ${meta.short} count is wrong`);
    }

    const clubs = {};
    for (const p of next) {
      const club = p.team ?? p.teamId;
      clubs[club] = (clubs[club] ?? 0) + 1;
      assert.ok(clubs[club] <= MAX_PER_CLUB, `${move}: ${clubs[club]} players from one club`);
    }

    assert.ok(plan.bankAfter >= 0, `${move}: leaves the bank at ${plan.bankAfter}`);
    assert.equal(plan.hits, Math.max(0, plan.transfers - 5) * 4, `${move}: hit is wrong`);
  }

  const signed = new Set(result.plans.flatMap((p) => p.transfersIn.map((x) => x.id)));
  assert.ok(!signed.has(91), 'the unaffordable candidate is never signed');
});

test('the budget uses the selling price, not the market price', () => {
  const { snapshot, state } = setup([
    { id: 90, name: 'Costly', position: MID, team: 20, price: 62 },
  ], { bank: 0 });

  // Squad midfielder 8 was bought at 52 and is now worth 62, so he sells for
  // 57 - half the rise. That is 5 short of the incoming player's price.
  snapshot.player(8).price = 62;
  const short = planTransfers(state, snapshot, [90], { source: 'model', epBlend: 0, fromGameweek: 1 });
  assert.ok(short.plans.every((p) => !p.transfersIn.some((x) => x.id === 90)),
    'a move funded by the full rise rather than half of it must not be offered');

  // With the difference in the bank it becomes affordable.
  const funded = planTransfers({ ...state, bank: 5 }, snapshot, [90],
    { source: 'model', epBlend: 0, fromGameweek: 1 });
  assert.ok(funded.plans.some((p) => p.transfersIn.some((x) => x.id === 90)),
    'and with the shortfall covered it is');
});

test('the eleven is solved afresh in each gameweek, not once and carried', () => {
  const spec = (id, position, team) => ({ id, name: `P${id}`, position, team, price: 50 });
  const squad = [
    spec(1, GKP, 1), spec(2, GKP, 2),
    spec(3, DEF, 3), spec(4, DEF, 4), spec(5, DEF, 5), spec(6, DEF, 6), spec(7, DEF, 7),
    spec(8, MID, 8), spec(9, MID, 9), spec(10, MID, 10), spec(11, MID, 11), spec(12, MID, 12),
    spec(13, FWD, 13), spec(14, FWD, 14), spec(15, FWD, 15),
  ];
  const candidate = spec(90, MID, 16);
  const snapshot = buildSnapshot({ playerSpecs: [...squad, candidate], teams: 20 });

  // Each defender and midfielder peaks in a different week, so no single
  // eleven can be right twice, and the signing is useless until gameweek 4.
  const predicted = {
    1: { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5 }, 2: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
    3: { 1: 9, 2: 1, 3: 1, 4: 1, 5: 1 }, 4: { 1: 1, 2: 9, 3: 1, 4: 1, 5: 1 },
    5: { 1: 1, 2: 1, 3: 9, 4: 1, 5: 1 }, 6: { 1: 1, 2: 1, 3: 1, 4: 9, 5: 1 },
    7: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 9 },
    8: { 1: 8, 2: 2, 3: 2, 4: 2, 5: 2 }, 9: { 1: 2, 2: 8, 3: 2, 4: 2, 5: 2 },
    10: { 1: 2, 2: 2, 3: 8, 4: 2, 5: 2 }, 11: { 1: 2, 2: 2, 3: 2, 4: 8, 5: 2 },
    12: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 8 },
    13: { 1: 7, 2: 3, 3: 7, 4: 3, 5: 7 }, 14: { 1: 3, 2: 7, 3: 3, 4: 7, 5: 3 },
    15: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
    90: { 1: 0.5, 2: 0.5, 3: 0.5, 4: 12, 5: 12 },
  };

  let state = initialSquad(emptyState(1), squad.map((s) => s.id), snapshot);
  state = { ...state, freeTransfers: 1 };

  const result = planTransfers(state, snapshot, [90],
    { source: 'predicted', predicted, horizon: 5, fromGameweek: 1 });
  const plan = result.plans.find((p) => p.transfers === 1 && p.transfersIn[0].id === 90);
  assert.ok(plan);
  assert.equal(plan.perGameweek.length, 5, 'a lineup is worked out for every gameweek');

  const shapes = new Set(plan.perGameweek.map((w) =>
    `${w.lineup.formation.name}|${w.lineup.xi.map((p) => p.id).sort((a, b) => a - b).join(',')}`));
  assert.ok(shapes.size > 1,
    'one eleven across five gameweeks would mean it was solved once and carried forward');

  // The signing is benched while he is poor and starts once he is not.
  const starts = plan.perGameweek.map((w) => w.lineup.xi.some((p) => p.id === 90));
  assert.deepEqual(starts, [false, false, false, true, true]);

  // The armband follows the week's projections too.
  const captains = plan.perGameweek.map((w) => w.lineup.captain.id);
  assert.ok(new Set(captains).size > 1, 'the captain is re-chosen each gameweek');
  assert.deepEqual(captains.slice(3), [90, 90], 'and it is the signing once he peaks');
});
