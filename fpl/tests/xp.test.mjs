import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './fixtures.mjs';
import { GKP, DEF, MID, FWD } from '../js/rules.js';
import { expectedPoints, expectedFloorDiv, poissonAtLeast, expectedMinutes } from '../js/xp.js';
import { loadSnapshot } from '../js/snapshot.js';

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

// ── Recent-role model ──────────────────────────────────────────────────────

import { recentRole, startProbability } from '../js/xp.js';

/** Attach a run of matches to a player: `true` = started, `false` = benched. */
function withHistory(snapshot, id, pattern, { startMinutes = 90, subMinutes = 10 } = {}) {
  snapshot.player(id).recent = pattern.map((started, i) => ({
    round: i + 1,
    minutes: started ? startMinutes : subMinutes,
    started,
    points: 2,
  }));
  return snapshot.player(id);
}

test('a nailed starter and a benched player are told apart', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: MID, team: 1, minutes: 540 },
      { id: 2, position: MID, team: 1, minutes: 540 },
    ],
  });
  // Identical season minutes, opposite recent roles.
  const nailed = withHistory(snapshot, 1, [true, true, true, true, true, true]);
  const dropped = withHistory(snapshot, 2, [true, true, true, false, false, false]);

  assert.equal(recentRole(nailed).startProbability, 1);
  assert.ok(recentRole(dropped).startProbability < 0.35,
    'recent benchings should dominate earlier starts');
  assert.ok(recentRole(nailed).minutes > recentRole(dropped).minutes + 40);
});

test('recency is weighted: just-won a place beats just-lost one', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: MID, team: 1 }, { id: 2, position: MID, team: 1 }],
  });
  const rising = withHistory(snapshot, 1, [false, false, false, true, true, true]);
  const falling = withHistory(snapshot, 2, [true, true, true, false, false, false]);

  assert.ok(recentRole(rising).startProbability > 0.65);
  assert.ok(recentRole(falling).startProbability < 0.35);
});

test('expected minutes follow the recent role, not the season average', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1, minutes: 540 }] });
  const player = snapshot.player(1);

  const seasonOnly = expectedMinutes(snapshot, player, { teamGames: 6 });
  withHistory(snapshot, 1, [false, false, false, false, false, false]);
  const benchedNow = expectedMinutes(snapshot, player, { teamGames: 6 });

  assert.ok(benchedNow < seasonOnly - 30,
    `a player now benched should project far fewer minutes (${benchedNow} vs ${seasonOnly})`);
});

test('a manual minutes override still beats the history', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1 }] });
  withHistory(snapshot, 1, [true, true, true, true, true, true]);
  assert.equal(expectedMinutes(snapshot, snapshot.player(1), { override: { minutes: 20 } }), 20);
});

test('start probability folds in whether the player is fit', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: MID, team: 1 },
      { id: 2, position: MID, team: 1, status: 'd', chance: 25 },
      { id: 3, position: MID, team: 1, status: 'i' },
    ],
  });
  for (const id of [1, 2, 3]) withHistory(snapshot, id, [true, true, true, true, true, true]);

  const fit = startProbability(snapshot, snapshot.player(1));
  // Six straight starts is strong but not certain, so smoothing caps it short of 1.
  assert.ok(fit > 0.9 && fit < 1, `expected a high but not certain start rate, got ${fit}`);

  const doubtful = startProbability(snapshot, snapshot.player(2));
  assert.ok(Math.abs(doubtful - fit * 0.25) < 1e-9, 'a 25% doubt scales the same start rate');

  assert.equal(startProbability(snapshot, snapshot.player(3)), 0, 'injured means no start');
});

test('without history the model falls back to the season share', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1, minutes: 270 }] });
  const p = startProbability(snapshot, snapshot.player(1), { teamGames: 6 });
  assert.ok(Math.abs(p - 0.5) < 1e-9, `270 of 540 minutes is a half share, got ${p}`);
});

test('a benched player projects fewer points than an identical starter', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: FWD, team: 1, xG90: 0.6, xA90: 0.2, minutes: 540 },
      { id: 2, position: FWD, team: 1, xG90: 0.6, xA90: 0.2, minutes: 540 },
    ],
  });
  withHistory(snapshot, 1, [true, true, true, true, true, true]);
  withHistory(snapshot, 2, [false, false, false, false, false, false]);

  const starter = expectedPoints(snapshot, snapshot.player(1), 1, { epBlend: 0, teamGames: 6 }).total;
  const benched = expectedPoints(snapshot, snapshot.player(2), 1, { epBlend: 0, teamGames: 6 }).total;
  assert.ok(benched < starter / 2, `${benched} should be far below ${starter}`);
});

test('a rotation risk still gets credit for defensive contribution when he starts', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: DEF, team: 1, dc90: 12, minutes: 540 },
      { id: 2, position: DEF, team: 1, dc90: 12, minutes: 540 },
    ],
  });
  const nailed = withHistory(snapshot, 1, [true, true, true, true, true, true]);
  const rotated = withHistory(snapshot, 2, [true, false, true, false, true, false]);

  const dc = (player) => expectedPoints(snapshot, player, 1, { epBlend: 0, teamGames: 6 })
    .fixtures[0].detail.parts.defensiveContribution;

  const nailedDc = dc(nailed);
  const rotatedDc = dc(rotated);

  // He starts roughly half the time, so he should earn roughly half as much -
  // not the near-zero that scaling the rate by average minutes would give.
  const ratio = rotatedDc / nailedDc;
  assert.ok(ratio > 0.3 && ratio < 0.7,
    `a half-time starter should earn roughly half the defensive contribution, got ${ratio.toFixed(2)}`);
});

test('threshold scoring beats the old rate-scaling for a half-time starter', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: DEF, team: 1, dc90: 12, minutes: 270 }] });
  const player = withHistory(snapshot, 1, [true, false, true, false, true, false]);
  const dc = expectedPoints(snapshot, player, 1, { epBlend: 0, teamGames: 6 })
    .fixtures[0].detail.parts.defensiveContribution;

  // Scaling the rate by a 50% minutes share and then applying the threshold
  // would give about 0.17 points. Averaging over outcomes gives about four
  // times that, which is the honest answer.
  assert.ok(dc > 0.5, `expected meaningful credit, got ${dc.toFixed(2)}`);
});

test('a clean sheet is a starter event, not an average-minutes one', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [
      { id: 1, position: DEF, team: 1, minutes: 540 },
      { id: 2, position: DEF, team: 1, minutes: 540 },
    ],
  });
  const nailed = withHistory(snapshot, 1, [true, true, true, true, true, true]);
  const cameos = withHistory(snapshot, 2, [false, false, false, false, false, false], { subMinutes: 20 });

  const cs = (player) => expectedPoints(snapshot, player, 1, { epBlend: 0, teamGames: 6 })
    .fixtures[0].detail.parts.cleanSheet;

  assert.ok(cs(nailed) > 0.5);
  assert.ok(cs(cameos) < cs(nailed) * 0.2,
    'a 20-minute substitute rarely reaches the 60 minutes a clean sheet needs');
});

test('a finished fixture contributes nothing to a forward-looking projection', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.7, xA90: 0.3, minutes: 900 }],
    fixtureSpecs: [
      { id: 1, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: true },
      { id: 2, event: 2, team_h: 1, team_a: 3, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
    ],
  });
  const played = expectedPoints(snapshot, snapshot.player(1), 1, { epBlend: 0 });
  assert.equal(played.total, 0, 'the match has already happened');
  assert.ok(played.blank);
  assert.ok(expectedPoints(snapshot, snapshot.player(1), 2, { epBlend: 0 }).total > 0);
});

test('a double gameweek half played counts only the match still to come', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.7, xA90: 0.3, minutes: 900 }],
    fixtureSpecs: [
      { id: 1, event: 5, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: true },
      { id: 2, event: 5, team_h: 3, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
    ],
  });
  const r = expectedPoints(snapshot, snapshot.player(1), 5, { epBlend: 0 });
  assert.equal(r.fixtures.length, 1);
  assert.equal(r.double, false);
  assert.ok(r.total > 0);
});

test('a gameweek in progress does not drag down start probabilities', () => {
  // Five finished gameweeks of starts, then GW6 is under way and this player's
  // fixture has not kicked off - so the API carries a zero-minute row for it.
  const raw = {
    elements: [{ id: 1, web_name: 'Nailed', first_name: 'N', second_name: 'Ailed',
      element_type: MID, team: 1, now_cost: 60, status: 'a', minutes: 450, starts: 5 }],
    teams: [{ id: 1, name: 'One', short_name: 'ONE' }, { id: 2, name: 'Two', short_name: 'TWO' }],
    events: Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, finished: i < 5, is_current: i === 5, is_next: false })),
    fixtures: Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, event: i + 1, team_h: 1, team_a: 2,
      team_h_difficulty: 3, team_a_difficulty: 3, finished: i < 5, started: i < 5 })),
    details: {
      1: {
        recent: [
          ...Array.from({ length: 5 }, (_, i) => ({
            round: i + 1, fixture: i + 1, minutes: 90, starts: 1, total_points: 6 })),
          { round: 6, fixture: 6, minutes: 0, starts: 0, total_points: 0 },  // not played yet
        ],
      },
    },
  };

  const snapshot = loadSnapshot(raw);
  const player = snapshot.player(1);

  assert.equal(player.recent.length, 5, 'the unplayed gameweek is not history');
  assert.ok(player.recent.every((m) => m.started));

  const p = startProbability(snapshot, player, { teamGames: 5 });
  assert.ok(p > 0.85, `a nailed starter should stay nailed mid-gameweek, got ${p.toFixed(2)}`);
});

test('without the filter that same player would look dropped', () => {
  // The same six rows, but with no event data to say which are finished: the
  // zero-minute row is the most recent and carries the most weight.
  const player = { recent: [
    ...Array.from({ length: 5 }, (_, i) => ({ round: i + 1, minutes: 90, started: true })),
    { round: 6, minutes: 0, started: false },
  ] };
  assert.ok(recentRole(player).startProbability < 0.75,
    'which is exactly the distortion the filter exists to prevent');
});
