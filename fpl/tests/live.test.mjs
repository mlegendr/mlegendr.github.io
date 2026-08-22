import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../js/snapshot.js';
import { GKP, DEF, MID, FWD } from '../js/rules.js';
import { liveScore } from '../js/live.js';

/**
 * A gameweek-1 snapshot where each player's fixture state and returns are set
 * explicitly. `state` is one of 'upcoming', 'live', 'finished'.
 */
function build(players) {
  // Every player gets a team of his own, each facing a shared opponent that
  // nobody belongs to, so one player's fixture state cannot leak into another's.
  const opponent = players.length + 1;
  const teams = [...players.map((p, i) => ({ id: i + 1, name: `T${i + 1}`, short_name: `T${i + 1}` })),
    { id: opponent, name: 'Opp', short_name: 'OPP' }];
  const fixtures = players.map((p, i) => ({
    id: i + 1, event: 1, team_h: i + 1, team_a: opponent,
    team_h_difficulty: 3, team_a_difficulty: 3,
    finished: p.state === 'finished',
    started: p.state !== 'upcoming',
  }));
  const elements = players.map((p, i) => ({
    id: i + 1, web_name: p.name ?? `P${i + 1}`, first_name: p.name ?? `P${i + 1}`, second_name: '',
    element_type: p.position, team: i + 1, now_cost: 50, status: 'a',
    minutes: 0, starts: 0, event_points: p.points ?? 0,
  }));
  const details = {};
  players.forEach((p, i) => {
    if (p.state === 'upcoming') return;
    details[i + 1] = { recent: [{ round: 1, fixture: i + 1, minutes: p.minutes ?? 0,
      starts: (p.minutes ?? 0) > 0 ? 1 : 0, total_points: p.points ?? 0 }] };
  });
  return loadSnapshot({
    elements, teams, fixtures, details,
    events: [{ id: 1, finished: false, is_current: true, is_next: false }],
  });
}

/** 15 players: ids 1-2 GKP, 3-7 DEF, 8-12 MID, 13-15 FWD. */
const LAYOUT = [GKP, GKP, DEF, DEF, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD, FWD];
const squad = (overrides = {}) => LAYOUT.map((position, i) => ({
  position, state: 'finished', minutes: 90, points: 2, ...(overrides[i + 1] ?? {}),
}));

// A 4-4-2: keeper 1, defenders 3-6, midfielders 8-11, forwards 13-14.
const SUBMISSION = {
  xi: [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14],
  bench: [2, 7, 12, 15],
  captain: 13,
  viceCaptain: 8,
  chip: 'none',
};

test('the total is the submitted eleven, with the captain doubled', () => {
  const snapshot = build(squad({ 13: { points: 10 } }));
  const score = liveScore(snapshot, SUBMISSION, 1);

  // Ten players on 2 plus the captain on 10, then the captain again.
  assert.equal(score.base, 10 * 2 + 10);
  assert.equal(score.armbandBonus, 10);
  assert.equal(score.total, 40);
  assert.equal(score.armband.id, 13);
});

test('bench players are excluded unless bench boost is played', () => {
  const snapshot = build(squad({ 2: { points: 9 }, 7: { points: 9 }, 12: { points: 9 }, 15: { points: 9 } }));

  const plain = liveScore(snapshot, SUBMISSION, 1);
  const boosted = liveScore(snapshot, { ...SUBMISSION, chip: 'bboost' }, 1);

  assert.equal(plain.total, 11 * 2 + 2, 'eleven players plus the doubled captain');
  assert.equal(boosted.total, plain.total + 4 * 9, 'the four bench players are added');
  assert.equal(boosted.benchCounts, true);
});

test('triple captain trebles instead', () => {
  const snapshot = build(squad({ 13: { points: 12 } }));
  const doubled = liveScore(snapshot, SUBMISSION, 1);
  const tripled = liveScore(snapshot, { ...SUBMISSION, chip: '3xc' }, 1);
  assert.equal(tripled.total - doubled.total, 12);
});

test('a starter who did not play is replaced once his match is over', () => {
  // Midfielder 11 was benched all match. The first bench player who played
  // comes on, whatever his position, as long as the formation survives - so
  // defender 7 takes the place, turning 4-4-2 into 5-3-2.
  const snapshot = build(squad({
    11: { minutes: 0, points: 0, state: 'finished' },
    7: { minutes: 90, points: 7 },
  }));
  const score = liveScore(snapshot, SUBMISSION, 1);

  assert.equal(score.substitutions.length, 1);
  assert.equal(score.substitutions[0].out.id, 11);
  assert.equal(score.substitutions[0].in.id, 7);
  assert.ok(score.counted.some((p) => p.id === 7));
  assert.ok(!score.counted.some((p) => p.id === 11));
});

test('the bench is used in the order it was set', () => {
  // Bench order is [2 (GK), 7 (DEF), 12 (MID), 15 (FWD)]. Defender 7 did not
  // play either, so the next one who did takes the place instead.
  const snapshot = build(squad({
    11: { minutes: 0, points: 0, state: 'finished' },
    7: { minutes: 0, points: 0, state: 'finished' },
    12: { minutes: 90, points: 7 },
  }));
  const score = liveScore(snapshot, SUBMISSION, 1);
  assert.equal(score.substitutions.length, 1);
  assert.equal(score.substitutions[0].in.id, 12);
});

test('the reserve keeper only replaces the keeper', () => {
  const snapshot = build(squad({
    1: { minutes: 0, points: 0, state: 'finished' },   // starting keeper blanked
    2: { minutes: 90, points: 6 },                     // reserve keeper played
  }));
  const score = liveScore(snapshot, SUBMISSION, 1);
  assert.equal(score.substitutions.length, 1);
  assert.equal(score.substitutions[0].in.id, 2);
  assert.equal(score.substitutions[0].in.position, GKP);
});

test('no substitution is made while his match is still to come', () => {
  const snapshot = build(squad({
    11: { minutes: 0, points: 0, state: 'upcoming' },
    12: { minutes: 90, points: 7 },
  }));
  const score = liveScore(snapshot, SUBMISSION, 1);
  assert.equal(score.substitutions.length, 0, 'nothing has happened yet');
  assert.equal(score.playersToPlay, 1);
  assert.equal(score.settled, false);
});

test('a substitution that would break the formation is not made', () => {
  // Only three defenders start, so a blanking defender cannot be replaced by
  // the bench midfielder or forward - only by the bench defender.
  const threeAtTheBack = {
    xi: [1, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14],
    bench: [2, 6, 7, 15],
    captain: 13, viceCaptain: 8, chip: 'none',
  };
  const snapshot = build(squad({
    3: { minutes: 0, points: 0, state: 'finished' },
    6: { minutes: 0, points: 0, state: 'finished' },   // first bench defender also blanked
    7: { minutes: 90, points: 5 },                     // second bench defender played
  }));
  const score = liveScore(snapshot, threeAtTheBack, 1);
  assert.equal(score.substitutions.length, 1);
  assert.equal(score.substitutions[0].in.id, 7, 'a defender must replace a defender here');
});

test('the armband passes to the vice only once the captain has blanked', () => {
  const stillToPlay = build(squad({ 13: { minutes: 0, points: 0, state: 'upcoming' }, 8: { points: 6 } }));
  assert.equal(liveScore(stillToPlay, SUBMISSION, 1).armband.id, 13, 'the captain may yet play');

  const blanked = build(squad({ 13: { minutes: 0, points: 0, state: 'finished' }, 8: { points: 6 } }));
  const score = liveScore(blanked, SUBMISSION, 1);
  assert.equal(score.armband.id, 8, 'the vice takes over');
  assert.ok(score.armbandSwitched);
  assert.equal(score.armbandBonus, 6);
});

test('players still to play are counted, and the gameweek is not settled', () => {
  const snapshot = build(squad({
    3: { state: 'upcoming', minutes: 0, points: 0 },
    4: { state: 'live', minutes: 40, points: 1 },
  }));
  const score = liveScore(snapshot, SUBMISSION, 1);
  assert.equal(score.playersToPlay, 1);
  assert.equal(score.playersInPlay, 1);
  assert.equal(score.settled, false);
});
