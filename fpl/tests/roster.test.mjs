import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './fixtures.mjs';
import { GKP, DEF, MID, FWD } from '../js/rules.js';
import { normalise, matchScore, resolveEntry, resolveSquad } from '../js/roster.js';
import { emptyState, initialSquad, sellValue } from '../js/squad.js';
import { readFileSync } from 'node:fs';

/** A snapshot standing in for the real 2026/27 game, with the recorded squad in it. */
const REAL_LIKE = [
  { id: 1, name: 'Kinský', full: 'Antonín Kinský', position: GKP, team: 1, price: 45 },
  { id: 2, name: 'Dúbravka', full: 'Martin Dúbravka', position: GKP, team: 1, price: 40 },
  { id: 3, name: 'Gabriel', full: 'Gabriel Magalhães', position: DEF, team: 2, price: 80 },
  { id: 4, name: 'Mosquera', full: 'Cristhian Mosquera', position: DEF, team: 2, price: 55 },
  { id: 5, name: 'Maguire', full: 'Harry Maguire', position: DEF, team: 3, price: 50 },
  { id: 6, name: 'Greaves', full: 'Jacob Greaves', position: DEF, team: 12, price: 40 },
  { id: 7, name: 'Thomas', full: 'Kyle Thomas', position: DEF, team: 5, price: 40 },
  { id: 8, name: 'B.Fernandes', full: 'Bruno Fernandes', position: MID, team: 3, price: 120 },
  { id: 9, name: 'Mbeumo', full: 'Bryan Mbeumo', position: MID, team: 3, price: 80 },
  { id: 10, name: 'Tzolis', full: 'Christos Tzolis', position: MID, team: 2, price: 65 },
  { id: 11, name: 'Groß', full: 'Pascal Groß', position: MID, team: 7, price: 55 },
  { id: 12, name: 'Sangaré', full: 'Ibrahim Sangaré', position: MID, team: 6, price: 55 },
  { id: 13, name: 'Haaland', full: 'Erling Haaland', position: FWD, team: 8, price: 155 },
  { id: 14, name: 'João Pedro', full: 'João Pedro Junqueira de Jesus', position: FWD, team: 9, price: 75 },
  { id: 15, name: 'Kusi-Asare', full: 'Jonathan Kusi-Asare', position: FWD, team: 13, price: 45 },
  // Decoys that share a surname or a club.
  { id: 16, name: 'Jesus', full: 'Gabriel Jesus', position: FWD, team: 2, price: 70 },
  { id: 17, name: 'Thomas', full: 'Thomas Partey', position: MID, team: 11, price: 50 },
];

const SHORTS = { 1: 'TOT', 2: 'ARS', 3: 'MUN', 4: 'HUL', 5: 'COV', 6: 'SUN', 7: 'BHA',
  8: 'MCI', 9: 'CHE', 10: 'NFO', 11: 'AVL', 12: 'IPS', 13: 'FUL' };

function realLikeSnapshot() {
  const snapshot = buildSnapshot({
    playerSpecs: REAL_LIKE.map((p) => ({ id: p.id, name: p.name, position: p.position, team: p.team, price: p.price })),
  });
  // buildSnapshot only carries a single name field; restore full names and clubs.
  for (const spec of REAL_LIKE) {
    const player = snapshot.player(spec.id);
    player.name = spec.name;
    player.fullName = spec.full;
    player.label = `${spec.name} (${SHORTS[spec.team]})`;
  }
  for (const [id, short] of Object.entries(SHORTS)) {
    snapshot.team(Number(id)).short = short;
    snapshot.team(Number(id)).name = `Club ${short}`;
  }
  return snapshot;
}

test('normalisation strips accents, punctuation and the sharp s', () => {
  assert.equal(normalise('Kinský'), 'kinsky');
  assert.equal(normalise('Dúbravka'), 'dubravka');
  assert.equal(normalise('Groß'), 'gross');
  assert.equal(normalise('João Pedro'), 'joao pedro');
  assert.equal(normalise('B.Fernandes'), 'b fernandes');
  assert.equal(normalise('Le Fée'), 'le fee');
  assert.equal(normalise("O'Brien"), 'o brien');
});

test('an exact name beats a partial one', () => {
  const snapshot = realLikeSnapshot();
  const haaland = snapshot.player(13);
  assert.equal(matchScore(haaland, 'Haaland'), 100);
  assert.ok(matchScore(haaland, 'Erling') > 0);
  assert.equal(matchScore(haaland, 'Salah'), 0);
});

test('every player in the recorded squad resolves', () => {
  const snapshot = realLikeSnapshot();
  const squadFile = JSON.parse(readFileSync(new URL('../data/squad-2026-27.json', import.meta.url)));
  const resolution = resolveSquad(snapshot, squadFile);

  assert.deepEqual(resolution.missing.map((m) => m.entry.name), []);
  assert.deepEqual(resolution.ambiguous.map((a) => a.entry.name), []);
  assert.equal(resolution.resolved.length, 15);
  assert.ok(resolution.ok);

  const byName = Object.fromEntries(resolution.resolved.map((r) => [r.entry.name, r.player.id]));
  assert.equal(byName['Kinsky'], 1, 'accented web names still match');
  assert.equal(byName['Groß'], 11);
  assert.equal(byName['João Pedro'], 14);
  assert.equal(byName['B.Fernandes'], 8);
  assert.equal(byName['Tzolis'], 10);
  assert.equal(byName['Kusi-Asare'], 15, 'hyphenated names resolve');
  assert.equal(byName['Sangaré'], 12);
  assert.equal(byName['Thomas'], 7, 'the Coventry defender, not Thomas Partey');
});

test('the club hint disambiguates players who share a surname', () => {
  const snapshot = realLikeSnapshot();
  const coventry = resolveEntry(snapshot, { name: 'Thomas', club: 'COV', position: 'DEF' });
  assert.equal(coventry.status, 'resolved');
  assert.equal(coventry.player.id, 7);

  const villa = resolveEntry(snapshot, { name: 'Thomas', club: 'AVL', position: 'MID' });
  assert.equal(villa.status, 'resolved');
  assert.equal(villa.player.id, 17);
});

test('an exact match wins over a surname match rather than going ambiguous', () => {
  const snapshot = realLikeSnapshot();
  snapshot.player(16).teamId = 10;   // Gabriel Jesus, web name "Jesus", now at NFO
  const result = resolveEntry(snapshot, { name: 'Jesus', club: 'NFO', position: 'FWD' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.player.id, 16, 'the player actually called "Jesus", not "Igor Jesus"');
});

test('a name that genuinely could mean two players is reported, not guessed', () => {
  const snapshot = realLikeSnapshot();
  // Two forwards with the same display name and club: nothing separates them.
  snapshot.player(16).teamId = 10;
  snapshot.player(15).teamId = 10;
  snapshot.player(15).name = 'Jesus';
  const result = resolveEntry(snapshot, { name: 'Jesus', club: 'NFO', position: 'FWD' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

test('a player missing from the snapshot is reported', () => {
  const snapshot = realLikeSnapshot();
  const result = resolveEntry(snapshot, { name: 'Nonexistent', club: 'TOT', position: 'MID' });
  assert.equal(result.status, 'missing');
});

test('a club hint that no longer holds is ignored with a note', () => {
  const snapshot = realLikeSnapshot();
  const result = resolveEntry(snapshot, { name: 'Mbeumo', club: 'BRE', position: 'MID' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.player.id, 9);
  assert.match(result.note, /club hint was ignored/);
});

test('the same player cannot fill two squad slots', () => {
  const snapshot = realLikeSnapshot();
  const resolution = resolveSquad(snapshot, {
    picks: [
      { name: 'Haaland', club: 'MCI', position: 'FWD' },
      { name: 'Haaland', club: 'MCI', position: 'FWD' },
    ],
  });
  assert.equal(resolution.resolved.length, 1);
  assert.equal(resolution.ambiguous.length, 1);
  assert.equal(resolution.ok, false);
});

test('recorded prices become the purchase prices', () => {
  const snapshot = realLikeSnapshot();
  const squadFile = JSON.parse(readFileSync(new URL('../data/squad-2026-27.json', import.meta.url)));

  // Gabriel has risen £0.3m since he was bought.
  snapshot.player(3).price = 83;

  const resolution = resolveSquad(snapshot, squadFile);
  assert.ok(resolution.ok);
  assert.equal(resolution.purchasePrices[3], 80, 'what was paid, not what it costs now');
  assert.deepEqual(resolution.priceMismatches.map((r) => r.entry.name), ['Gabriel']);

  const state = initialSquad(emptyState(1), resolution.playerIds, snapshot,
    { purchasePrices: resolution.purchasePrices });
  const gabriel = state.picks.find((p) => p.playerId === 3);
  assert.equal(gabriel.purchasePrice, 80);
  // Half of the £0.3m rise is banked, rounded down: sells for £8.1m.
  assert.equal(sellValue(gabriel, snapshot), 81);
  assert.equal(state.bank, 0, 'the recorded squad spends the full £100.0m');
});

test('a recorded price separates two players a name and club cannot', () => {
  const snapshot = realLikeSnapshot();
  // Two Arsenal midfielders both displayed as "Thomas", at different prices.
  snapshot.player(17).teamId = 2;
  snapshot.player(17).name = 'Thomas';
  snapshot.player(7).teamId = 2;
  snapshot.player(7).position = MID;

  const ambiguous = resolveEntry(snapshot, { name: 'Thomas', club: 'ARS', position: 'MID' });
  assert.equal(ambiguous.status, 'ambiguous');

  const byPrice = resolveEntry(snapshot, { name: 'Thomas', club: 'ARS', position: 'MID', price: 50 });
  assert.equal(byPrice.status, 'resolved');
  assert.equal(byPrice.player.id, 17);
});
