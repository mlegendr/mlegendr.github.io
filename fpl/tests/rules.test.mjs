import test from 'node:test';
import assert from 'node:assert/strict';
import { sellingPrice, hitCost, chipHalf, FORMATIONS, captainMultiplier } from '../js/rules.js';

test('selling price banks half of a rise, rounded down', () => {
  assert.equal(sellingPrice(50, 50), 50);
  assert.equal(sellingPrice(50, 51), 50);   // +0.1 rise, half rounds down to nothing
  assert.equal(sellingPrice(50, 52), 51);
  assert.equal(sellingPrice(50, 53), 51);
  assert.equal(sellingPrice(50, 54), 52);
  assert.equal(sellingPrice(120, 129), 124);
});

test('a price fall is absorbed in full', () => {
  assert.equal(sellingPrice(50, 48), 48);
  assert.equal(sellingPrice(50, 40), 40);
});

test('transfers beyond the free allocation cost four points each', () => {
  assert.equal(hitCost(1, 1), 0);
  assert.equal(hitCost(2, 1), 4);
  assert.equal(hitCost(5, 2), 12);
  assert.equal(hitCost(0, 3), 0);
});

test('chips split at the gameweek 19 boundary', () => {
  assert.equal(chipHalf(1), 'first');
  assert.equal(chipHalf(19), 'first');
  assert.equal(chipHalf(20), 'second');
  assert.equal(chipHalf(38), 'second');
});

test('only the eight legal formations exist', () => {
  const names = FORMATIONS.map((f) => f.name).sort();
  assert.deepEqual(names, ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-2-3', '5-3-2', '5-4-1']);
});

test('triple captain triples, everything else doubles', () => {
  assert.equal(captainMultiplier('3xc'), 3);
  assert.equal(captainMultiplier('none'), 2);
  assert.equal(captainMultiplier('bboost'), 2);
});
