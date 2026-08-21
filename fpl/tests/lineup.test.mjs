import test from 'node:test';
import assert from 'node:assert/strict';
import { GKP, DEF, MID, FWD } from '../js/rules.js';
import { optimiseLineup, pickArmbands, benchOrder } from '../js/lineup.js';

/** 15 players whose projections are set explicitly. */
function squad(points = {}) {
  const layout = [
    ...Array(2).fill(GKP), ...Array(5).fill(DEF),
    ...Array(5).fill(MID), ...Array(3).fill(FWD),
  ];
  return layout.map((position, i) => ({
    id: i + 1, position, name: `P${i + 1}`, points: points[i + 1] ?? 2,
  }));
}

test('the optimal XI is legal and picks the highest projections', () => {
  // Ids 1-2 GKP, 3-7 DEF, 8-12 MID, 13-15 FWD.
  const lineup = optimiseLineup(squad({
    1: 5, 2: 1,                      // keeper 1 is clearly better
    3: 6, 4: 6, 5: 6, 6: 1, 7: 1,    // three good defenders
    8: 9, 9: 8, 10: 7, 11: 6, 12: 3, // five usable midfielders
    13: 8, 14: 7, 15: 1,             // only two good forwards, so 3-5-2 wins
  }));
  assert.equal(lineup.xi.length, 11);
  assert.equal(lineup.bench.length, 4);
  assert.equal(lineup.formation.name, '3-5-2');
  const ids = lineup.xi.map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14]);
});

test('formation constraints are respected even when the best players cluster', () => {
  // Every midfielder is elite, but only five can start.
  const lineup = optimiseLineup(squad({ 8: 20, 9: 20, 10: 20, 11: 20, 12: 20 }));
  assert.equal(lineup.xi.filter((p) => p.position === MID).length, 5);
  assert.equal(lineup.xi.filter((p) => p.position === GKP).length, 1);
  assert.ok(lineup.xi.filter((p) => p.position === DEF).length >= 3);
  assert.ok(lineup.xi.filter((p) => p.position === FWD).length >= 1);
});

test('captain is the top projection and the armband doubles it', () => {
  const lineup = optimiseLineup(squad({ 8: 12, 9: 9 }));
  assert.equal(lineup.captain.id, 8);
  assert.equal(lineup.viceCaptain.id, 9);
  assert.equal(lineup.captainBonus, 12);
  assert.equal(lineup.total, lineup.startingPoints + 12);
});

test('triple captain triples the captain instead', () => {
  const lineup = optimiseLineup(squad({ 8: 12 }), '3xc');
  assert.equal(lineup.captainBonus, 24);
  assert.equal(lineup.total, lineup.startingPoints + 24);
});

test('bench boost adds the four bench players', () => {
  const plain = optimiseLineup(squad({ 8: 12 }), 'none');
  const boosted = optimiseLineup(squad({ 8: 12 }), 'bboost');
  assert.equal(boosted.total, plain.total + plain.benchPoints);
  assert.ok(boosted.benchPoints > 0);
});

test('vice-captain breaks near-ties towards the likelier starter', () => {
  const xi = [
    { id: 1, position: MID, points: 10, startProbability: 1 },
    { id: 2, position: MID, points: 6.2, startProbability: 0.5 },
    { id: 3, position: FWD, points: 6.0, startProbability: 1 },
  ];
  const { captain, viceCaptain } = pickArmbands(xi);
  assert.equal(captain.id, 1);
  assert.equal(viceCaptain.id, 3, 'a 0.2-point gap is not worth a rotation risk');
});

test('the reserve keeper stays in its own bench slot', () => {
  const bench = benchOrder([
    { id: 2, position: GKP, points: 0.5 },
    { id: 7, position: DEF, points: 3 },
    { id: 12, position: MID, points: 4 },
  ]);
  assert.equal(bench[0].position, GKP);
  assert.deepEqual(bench.slice(1).map((p) => p.id), [12, 7]);
});

test('a malformed squad is rejected rather than silently fixed', () => {
  assert.throws(() => optimiseLineup(squad().slice(0, 14)), /15-player squad/);
});
