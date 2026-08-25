import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, legalSquadSpecs } from './fixtures.mjs';
import { MID, FWD } from '../js/rules.js';
import { parsePredictedPoints, matchPredictions, coverage } from '../js/predicted.js';
import { expectedPoints, projectSquad, DEFAULTS as XP_DEFAULTS } from '../js/xp.js';

const TABLE_TSV = [
  'Player\tTeam\tPos\tPrice\tGW7\tGW8\tGW9',
  'Haaland\tMCI\tFWD\t15.5\t7.4\t6.1\t8.0',
  'B.Fernandes\tMUN\tMID\t12.0\t5.2\t4.8\t5.5',
  'Gabriel\tARS\tDEF\t8.0\t4.1\t3.9\t4.4',
].join('\n');

test('a table copied out of a browser is read as tab-separated', () => {
  const { entries, gameweeks, problems } = parsePredictedPoints(TABLE_TSV);
  assert.deepEqual(problems, []);
  assert.deepEqual(gameweeks, [7, 8, 9]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    name: 'Haaland', team: 'MCI', position: 'FWD', price: '15.5',
    points: { 7: 7.4, 8: 6.1, 9: 8.0 },
  });
});

test('CSV works too, including a comma inside a quoted name', () => {
  const csv = 'Player,Team,GW7,GW8\n"Silva, Bernardo",MCI,4.5,4.2\nHaaland,MCI,7.4,6.1';
  const { entries, problems } = parsePredictedPoints(csv);
  assert.deepEqual(problems, []);
  assert.equal(entries[0].name, 'Silva, Bernardo');
  assert.deepEqual(entries[0].points, { 7: 4.5, 8: 4.2 });
});

test('gameweek headers are recognised however they are written', () => {
  const variants = 'Player\tGameweek 7\tgw8\tWeek 9\t10\nHaaland\t1\t2\t3\t4';
  const { gameweeks, entries } = parsePredictedPoints(variants);
  assert.deepEqual(gameweeks, [7, 8, 9, 10]);
  assert.deepEqual(entries[0].points, { 7: 1, 8: 2, 9: 3, 10: 4 });
});

test('a currency symbol or stray text around a number does not break it', () => {
  const messy = 'Player,Price,GW7\nHaaland,£15.5m,7.4 pts';
  const { entries } = parsePredictedPoints(messy);
  assert.equal(entries[0].points[7], 7.4);
});

test('text that is not a predictions table says so plainly', () => {
  const noName = parsePredictedPoints('Foo\tBar\nx\ty');
  assert.match(noName.problems[0], /Could not find a header row/);

  const noGameweeks = parsePredictedPoints('Player\tTeam\nHaaland\tMCI');
  assert.match(noGameweeks.problems[0], /Could not find a header row/);
  assert.match(noGameweeks.problems[0], /The text starts: Player/, 'and shows what it saw');
});

test('JSON is accepted as well', () => {
  const json = JSON.stringify([
    { name: 'Haaland', team: 'MCI', points: { GW7: 7.4, GW8: 6.1 } },
    { name: 'Gabriel', team: 'ARS', points: { GW7: 4.1, GW8: 3.9 } },
  ]);
  const { entries, gameweeks } = parsePredictedPoints(json);
  assert.deepEqual(gameweeks, [7, 8]);
  assert.equal(entries[0].points[7], 7.4);
});

// ── Matching to the squad ──────────────────────────────────────────────────

function squadSnapshot() {
  const specs = legalSquadSpecs({
    8: { name: 'Haaland' }, 9: { name: 'B.Fernandes' }, 3: { name: 'Gabriel' },
  });
  const snapshot = buildSnapshot({ playerSpecs: specs });
  for (const spec of specs) {
    const player = snapshot.player(spec.id);
    player.fullName = spec.name ?? player.name;
    player.team = snapshot.team(player.teamId);
  }
  return snapshot;
}

test('rows are matched to the squad and unmatched ones reported', () => {
  const snapshot = squadSnapshot();
  const players = [3, 8, 9].map((id) => snapshot.player(id));
  const { entries } = parsePredictedPoints(TABLE_TSV);
  const { points, matched, unmatched } = matchPredictions(players, entries);

  assert.equal(matched.length, 3);
  assert.deepEqual(unmatched, []);
  assert.equal(points[8][7], 7.4, 'Haaland');
  assert.equal(points[9][8], 4.8, 'B.Fernandes');
});

test('a player not asked about is reported rather than forced onto someone', () => {
  const snapshot = squadSnapshot();
  const players = [8].map((id) => snapshot.player(id));   // only Haaland
  const { entries } = parsePredictedPoints(TABLE_TSV);
  const { matched, unmatched } = matchPredictions(players, entries);
  assert.equal(matched.length, 1);
  assert.equal(unmatched.length, 2);
});

test('one row cannot claim two players', () => {
  const snapshot = squadSnapshot();
  const players = [3, 8, 9].map((id) => snapshot.player(id));
  const doubled = parsePredictedPoints(
    'Player\tGW7\nHaaland\t7.4\nHaaland\t9.9').entries;
  const { matched, unmatched } = matchPredictions(players, doubled);
  assert.equal(matched.length, 1);
  assert.equal(unmatched.length, 1, 'the second row has nobody left to match');
});

test('coverage reports exactly what is missing', () => {
  const points = { 1: { 7: 5, 8: 4 }, 2: { 7: 3 } };
  const result = coverage(points, [1, 2], [7, 8]);
  assert.equal(result.have, 3);
  assert.equal(result.wanted, 4);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, [{ playerId: 2, gameweek: 8 }]);

  assert.equal(coverage(points, [1], [7, 8]).complete, true);
});

// ── Feeding the projections ────────────────────────────────────────────────

test('imported predictions are used verbatim, for every gameweek', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.9, xA90: 0.4, epNext: 2.0 }],
  });
  const predicted = { 1: { 1: 7.4, 2: 6.1 } };

  for (const [gameweek, expected] of [[1, 7.4], [2, 6.1]]) {
    const result = expectedPoints(snapshot, snapshot.player(1), gameweek, { predicted });
    assert.equal(result.total, expected, `gameweek ${gameweek} should be used as published`);
    assert.equal(result.source, 'predicted');
  }
});

test('a gameweek with no published number scores zero and is flagged', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 0.9, xA90: 0.4, epNext: 5.0 }],
  });
  const result = expectedPoints(snapshot, snapshot.player(1), 3, { predicted: { 1: { 1: 7.4 } } });
  assert.equal(result.source, 'predicted');
  assert.equal(result.total, 0, 'nothing published means nothing counted');
  assert.equal(result.missing, true);
});

test('nothing else can supply a number in its place', () => {
  // This player has strong rates and a healthy ep_next; neither may be used.
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, xG90: 1.2, xA90: 0.8, minutes: 900, epNext: 8.0 }],
  });
  for (const opts of [{}, { fallback: 'ep' }, { fallback: 'model' }, { epBlend: 0.9 }]) {
    const result = expectedPoints(snapshot, snapshot.player(1), 1, { predicted: {}, ...opts });
    assert.equal(result.total, 0, `a fallback leaked in with ${JSON.stringify(opts)}`);
    assert.equal(result.source, 'predicted');
  }
});

test('the published number stands even where the fixture list disagrees', () => {
  // No fixture in gameweek 1 as far as this snapshot knows, but the table gives
  // a figure - whoever published it was already pricing the fixtures.
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, epNext: 5 }],
    fixtureSpecs: [{ id: 1, event: 2, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: false }],
  });
  const result = expectedPoints(snapshot, snapshot.player(1), 1, { predicted: { 1: { 1: 7.4 } } });
  assert.equal(result.total, 7.4, 'used exactly as given');
  assert.equal(result.missing, false);
});

test('a double gameweek is whatever the table says, not doubled again', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: FWD, team: 1, epNext: 5 }],
    fixtureSpecs: [
      { id: 1, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
      { id: 2, event: 1, team_h: 3, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3, finished: false },
    ],
  });
  const result = expectedPoints(snapshot, snapshot.player(1), 1, { predicted: { 1: { 1: 9.0 } } });
  assert.equal(result.total, 9.0);
  assert.ok(result.double);
});

// ── Weighting by distance ──────────────────────────────────────────────────

test('the horizon is weighted towards the nearer gameweeks', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1 }] });
  const predicted = { 1: { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4 } };
  const projections = projectSquad(snapshot, [snapshot.player(1)], [1, 2, 3, 4, 5],
    { source: 'predicted', predicted });

  const p = projections.get(1);
  assert.equal(p.total, 20, 'the plain sum is untouched');

  const decay = XP_DEFAULTS.horizonDecay;
  const expected = [0, 1, 2, 3, 4].reduce((a, i) => a + 4 * decay ** i, 0);
  assert.ok(Math.abs(p.weighted - expected) < 1e-9);
  assert.ok(p.weighted < p.total, 'later gameweeks count for less');
});

test('the same points sooner are worth more than later', () => {
  const snapshot = buildSnapshot({
    playerSpecs: [{ id: 1, position: MID, team: 1 }, { id: 2, position: MID, team: 1 }],
  });
  const predicted = {
    1: { 1: 8, 2: 2, 3: 2, 4: 2, 5: 2 },   // front-loaded
    2: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 8 },   // back-loaded
  };
  const projections = projectSquad(snapshot, [snapshot.player(1), snapshot.player(2)],
    [1, 2, 3, 4, 5], { source: 'predicted', predicted });

  assert.equal(projections.get(1).total, projections.get(2).total, 'identical over the horizon');
  assert.ok(projections.get(1).weighted > projections.get(2).weighted,
    'but the immediate one is preferred');
});

test('gameweeks with no figure are counted and reported', () => {
  const snapshot = buildSnapshot({ playerSpecs: [{ id: 1, position: MID, team: 1 }] });
  const projections = projectSquad(snapshot, [snapshot.player(1)], [1, 2, 3],
    { source: 'predicted', predicted: { 1: { 1: 5 } } });
  const p = projections.get(1);
  assert.equal(p.total, 5);
  assert.equal(p.missing, 2, 'gameweeks 2 and 3 have nothing');
});

// ── The published table's actual shape ─────────────────────────────────────
// ── The published table's actual shape ─────────────────────────────────────

const REAL_FORMAT = [
  'FPL predicted points for every player over the next 8 gameweeks, sorted by total.',
  'Player\tTeam\tPos\tPrice\tGW1\tGW2\tGW3\tGW4\tGW5\tGW6\tGW7\tGW8\t8 GW total',
  'Haaland\tMCI\tFWD\t£15.5m\t6.6\t6.1\t7.0\t4.8\t7.0\t4.7\t7.2\t6.0\t49.5',
  'B.Fernandes\tMUN\tMID\t£12.0m\t6.4\t6.4\t5.2\t4.8\t5.6\t5.8\t5.5\t5.9\t45.6',
  'Fernandes\tTOT\tMID\t£6.0m\t3.1\t3.4\t3.2\t3.4\t3.4\t2.9\t3.8\t2.7\t25.8',
  'M.Sangaré\tBRE\tMID\t£5.5m\t3.4\t3.2\t3.3\t3.0\t2.9\t2.8\t2.6\t3.2\t24.3',
  'I.Sangaré\tNFO\tMID\t£5.0m\t2.8\t2.1\t2.6\t2.4\t2.7\t2.4\t2.1\t2.5\t19.6',
  'J.Timber\tARS\tDEF\t£6.5m\t0.0\t0.0\t0.0\t0.0\t2.9\t3.1\t3.2\t3.3\t12.5',
].join('\n');

test('a heading above the table is skipped rather than mistaken for it', () => {
  const { entries, gameweeks, problems, skippedLines } = parsePredictedPoints(REAL_FORMAT);
  assert.deepEqual(problems, []);
  assert.equal(skippedLines, 1, 'the sentence above the table');
  assert.deepEqual(gameweeks, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(entries.length, 6);
});

test('a season-total column is not mistaken for a gameweek', () => {
  const { gameweeks, entries } = parsePredictedPoints(REAL_FORMAT);
  assert.ok(!gameweeks.includes(49), '"8 GW total" is a summary, not gameweek 8');
  assert.equal(Object.keys(entries[0].points).length, 8);
  assert.equal(entries[0].points[8], 6.0, 'and GW8 keeps its own value');
});

test('prices written as £15.5m do not disturb the reading', () => {
  const { entries } = parsePredictedPoints(REAL_FORMAT);
  assert.equal(entries[0].price, '£15.5m');
  assert.equal(entries[0].points[1], 6.6);
});

test('a player yet to return reads as zeros then real numbers', () => {
  const { entries } = parsePredictedPoints(REAL_FORMAT);
  const timber = entries.find((e) => e.name === 'J.Timber');
  assert.deepEqual(timber.points, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2.9, 6: 3.1, 7: 3.2, 8: 3.3 });
});

test('the club column separates two players who share a surname', () => {
  const specs = legalSquadSpecs({ 8: { name: 'M.Sangaré', team: 4 }, 9: { name: 'I.Sangaré', team: 5 } });
  const snapshot = buildSnapshot({ playerSpecs: specs });
  snapshot.team(4).short = 'BRE';
  snapshot.team(5).short = 'NFO';
  for (const spec of specs) {
    const player = snapshot.player(spec.id);
    player.fullName = spec.name ?? player.name;
    player.team = snapshot.team(player.teamId);
  }

  const { entries } = parsePredictedPoints(REAL_FORMAT);
  const { points } = matchPredictions([8, 9].map((id) => snapshot.player(id)), entries);
  assert.equal(points[8][1], 3.4, 'the Brentford one');
  assert.equal(points[9][1], 2.8, 'the Forest one');
});
