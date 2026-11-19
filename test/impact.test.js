import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CIGARETTE_PM25,
  cigaretteEquivalent,
  exposureFactor,
  commuteCo2,
  streetMultiplier,
} from '../src/impact.js';

test('22 µg/m³ for 24 hours equals one cigarette', () => {
  assert.equal(cigaretteEquivalent(CIGARETTE_PM25, 24), 1);
});

test('cigarettes scale linearly with concentration and time', () => {
  assert.equal(cigaretteEquivalent(132, 1), 0.25);
  assert.equal(cigaretteEquivalent(0, 10), 0);
  assert.equal(cigaretteEquivalent(50, 0), 0);
});

test('cigaretteEquivalent rejects negative or non-numeric input', () => {
  for (const [pm25, hours] of [[-1, 1], [1, -1], [Number.NaN, 1], ['5', 1], [1, Infinity]]) {
    assert.throws(() => cigaretteEquivalent(pm25, hours), RangeError);
  }
});

test('exposure factor: outdoors is full exposure, purifier is lowest', () => {
  assert.equal(exposureFactor({ indoors: false }), 1);
  assert.equal(exposureFactor({ indoors: true, windowsClosed: false }), 0.8);
  assert.equal(exposureFactor({ indoors: true, windowsClosed: true }), 0.5);
  assert.equal(exposureFactor({ indoors: true, windowsClosed: true, hasPurifier: true }), 0.2);
});

test('a purifier only helps indoors', () => {
  assert.equal(exposureFactor({ indoors: false, hasPurifier: true }), 1);
});

test('commuteCo2 uses per-km factors per mode', () => {
  assert.equal(commuteCo2('car', 10), 1.7);
  assert.equal(commuteCo2('metro', 10), 0.35);
  assert.equal(commuteCo2('cycle', 25), 0);
  assert.equal(commuteCo2('remote', 0), 0);
});

test('commuteCo2 rejects unknown modes and bad distances', () => {
  assert.throws(() => commuteCo2('rocket', 5), RangeError);
  assert.throws(() => commuteCo2('car', -2), RangeError);
});

test('streetMultiplier counts your household plus the neighbours', () => {
  assert.equal(streetMultiplier(2, 20), 42);
  assert.equal(streetMultiplier(2), 42);
  assert.equal(streetMultiplier(2, 0), 2);
});

test('streetMultiplier rejects invalid neighbour counts', () => {
  for (const n of [-1, 1.5, 1001]) {
    assert.throws(() => streetMultiplier(1, n), RangeError);
  }
});
