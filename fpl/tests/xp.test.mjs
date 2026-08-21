import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './fixtures.mjs';
import { GKP, DEF, MID, FWD } from '../js/rules.js';
import { expectedPoints, expectedFloorDiv, poissonAtLeast, expectedMinutes } from '../js/xp.js';

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('expectedFloorDiv matches a hand-computed Poisson sum', () => {
  // E[floor(X/d)] tends to lambda/d - (d-1)/2d for large lambda.
  close(expectedFloorDiv(0, 2), 0);
  const lambda = 6;
  assert.ok(Math.abs(expectedFloorDiv(lambda, 2) - (lambda / 2 - 0.25)) < 0.01);
  assert.ok(Math.abs(expectedFloorDiv(9, 3) - (9 / 3 - 2 / 6)) < 0.02);
});

test('poissonAtLeast is a proper probability', () => {
  close(poissonAtLeast(0, 10), 0);
  const p = poissonAtLeast(10, 10);
  assert.ok(p > 0.4 && p < 0.6, `expected near half, got ${p}`);
  assert.ok(poissonAtLeast(20, 10) > 0.99);
});

test('a blank gameweek scores nothing', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: MID, team: 1, xG90: 0.5, xA90: 0.3 }],
    fixtureSpecs: [{ id: 1, event: 2, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: false }],
  });
  const gw1 = expectedPoints(snapshot, snapshot.player(1), 1, { epBlend: 0 });
  assert.equal(gw1.total, 0);
  assert.ok(gw1.blank);
  assert.ok(expectedPoints(snapshot, snapshot.player(1), 2, { epBlend: 0 }).total > 0);
});

test('a double gameweek is the sum of both fixtures', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: MID, team: 1, xG90: 0.5, xA90: 0.3 }],
    fixtureSpecs: [
      { id: 1, event: 5, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
      { id: 2, event: 5, team_h: 3, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
    ],
  });
  const r = expectedPoints(snapshot, snapshot.player(1), 5, { epBlend: 0 });
  assert.ok(r.double);
  assert.equal(r.fixtures.length, 2);
  close(r.total, r.fixtures[0].points + r.fixtures[1].points, 1e-9);
});

test('an injured player projects zero regardless of his rates', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.9, xA90: 0.4, status: 'i', epNext: 6 }],
  });
  assert.equal(expectedPoints(snapshot, snapshot.player(1), 1).total, 0);
});

test('a doubtful player is scaled by his chance of playing', () => {
  const specs = (chance) => [{ id: 1, position: FWD, team: 1, xG90: 0.8, xA90: 0.3, status: 'd', chance }];
  const full = expectedPoints(buildSnapshot({ playerSpecs: specs(100) }), buildSnapshot({ playerSpecs: specs(100) }).player(1), 1, { epBlend: 0 }).total;
  const half = expectedPoints(buildSnapshot({ playerSpecs: specs(50) }), buildSnapshot({ playerSpecs: specs(50) }).player(1), 1, { epBlend: 0 }).total;
  assert.ok(half < full);
  assert.ok(half > 0);
});

test('an easier fixture projects more points than a harder one', () => {
  const make = (difficulty) => buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.6, xA90: 0.2 }],
    fixtureSpecs: [{ id: 1, event: 1, team_h: 1, team_a: 2, team_h_difficulty: difficulty, team_a_difficulty: 3, finished: false }],
  });
  const easy = make(2), hard = make(5);
  assert.ok(expectedPoints(easy, easy.player(1), 1, { epBlend: 0 }).total
    > expectedPoints(hard, hard.player(1), 1, { epBlend: 0 }).total);
});

test('goalkeeper clean sheets and defender clean sheets outweigh a midfielder', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: GKP, team: 1, saves: 30, minutes: 900 },
      { id: 2, position: DEF, team: 1, minutes: 900 },
      { id: 3, position: MID, team: 1, minutes: 900 },
    ],
  });
  const cs = (id) => expectedPoints(snapshot, snapshot.player(id), 1, { epBlend: 0 })
    .fixtures[0].detail.parts.cleanSheet;
  assert.ok(cs(1) > cs(3));
  assert.ok(Math.abs(cs(1) - cs(2)) < 1e-9);
});

test('defensive contribution pays defenders at ten actions and midfielders at twelve', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: DEF, team: 1, dc90: 11, minutes: 900 },
      { id: 2, position: MID, team: 1, dc90: 11, minutes: 900 },
      { id: 3, position: GKP, team: 1, dc90: 11, minutes: 900 },
    ],
  });
  const dc = (id) => expectedPoints(snapshot, snapshot.player(id), 1, { epBlend: 0 })
    .fixtures[0].detail.parts.defensiveContribution;
  assert.ok(dc(1) > dc(2), 'same rate clears the defender threshold more often');
  assert.equal(dc(3), 0, 'goalkeepers earn no defensive contribution');
});

test('expected minutes blend season data with the prior', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1, minutes: 0 }] });
  const player = snapshot.player(1);
  assert.equal(expectedMinutes(snapshot, player, { teamGames: 0, minutesPrior: 68 }), 68);
  assert.equal(expectedMinutes(snapshot, player, { override: { minutes: 30 } }), 30);
  const blended = expectedMinutes(snapshot, { ...player, minutes: 180 }, { teamGames: 2, minutesPrior: 68 });
  assert.ok(blended > 68 && blended < 90, `expected between prior and 90, got ${blended}`);
});
