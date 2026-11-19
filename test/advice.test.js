import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiCategory, cleanestHour, buildAdvice } from '../src/advice.js';

const hourly = (pm25s, startHour = 0) =>
  pm25s.map((pm25, i) => ({ time: `2026-11-20T${String(startHour + i).padStart(2, '0')}:00`, aqi: Math.round(pm25 * 2), pm25 }));

const air = ({ aqi = 160, pm25 = 70, time = '2026-11-20T08:00', hours } = {}) => ({
  current: { time, aqi, pm25 },
  hourly: hours ?? hourly(Array.from({ length: 24 }, (_, h) => (h === 14 ? 30 : 70))),
});

const profile = (overrides = {}) => ({
  city: 'Pune',
  groups: [],
  commuteMode: 'remote',
  commuteKm: 0,
  heating: 'electric',
  hasPurifier: false,
  exercisesOutdoors: false,
  ...overrides,
});

const find = (advice, id) => advice.actions.find((a) => a.id === id);

// --- AQI bands -------------------------------------------------------------

test('aqiCategory uses exact US EPA band boundaries', () => {
  const cases = [
    [0, 'good'], [50, 'good'], [51, 'moderate'], [100, 'moderate'], [101, 'usg'], [150, 'usg'],
    [151, 'unhealthy'], [200, 'unhealthy'], [201, 'very_unhealthy'], [300, 'very_unhealthy'], [301, 'hazardous'],
  ];
  for (const [aqi, id] of cases) assert.equal(aqiCategory(aqi).id, id, `AQI ${aqi}`);
  assert.equal(aqiCategory(151).band, 3);
});

// --- cleanest hour ---------------------------------------------------------

test('cleanestHour picks the lowest future PM2.5 between 06:00 and 21:00', () => {
  const hours = hourly([5, 5, 5, 5, 5, 5, 60, 50, 40, 45, 30, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 5, 5]);
  assert.deepEqual(cleanestHour(hours, '2026-11-20T08:30'), { time: '2026-11-20T10:00', aqi: 60, pm25: 30 });
});

test('cleanestHour ignores past hours, breaks ties by earliest, null when none left', () => {
  const hours = hourly([50, 20, 20, 40], 9);
  assert.equal(cleanestHour(hours, '2026-11-20T10:15').time, '2026-11-20T10:00');
  assert.equal(cleanestHour(hours, '2026-11-20T23:00'), null);
});

// --- context-driven decisions ----------------------------------------------

test('asthma + AQI 180 + outdoor exercise ranks "exercise-indoors" first', () => {
  const advice = buildAdvice({ air: air({ aqi: 180 }), profile: profile({ groups: ['respiratory'], exercisesOutdoors: true }) });
  assert.equal(advice.actions[0].id, 'exercise-indoors');
  assert.ok(advice.actions[0].impact.cigarettesAvoided > 0);
});

test('AQI 40 → no mask and no sensitive-group warning', () => {
  const advice = buildAdvice({ air: air({ aqi: 40, pm25: 9 }), profile: profile({ groups: ['children'] }) });
  assert.equal(advice.category.id, 'good');
  assert.equal(find(advice, 'wear-n95'), undefined);
  assert.equal(find(advice, 'protect-sensitive'), undefined);
});

test('unhealthy air with children adds the sensitive-group action', () => {
  const advice = buildAdvice({ air: air({ aqi: 120, pm25: 45 }), profile: profile({ groups: ['children'] }) });
  assert.ok(find(advice, 'protect-sensitive'));
  assert.equal(advice.sensitive, true);
});

test('every area has at least one action whenever AQI > 50', () => {
  for (const aqi of [51, 120, 180, 250, 350]) {
    for (const p of [profile(), profile({ commuteMode: 'car', commuteKm: 10, heating: 'wood', hasPurifier: true })]) {
      const areas = new Set(buildAdvice({ air: air({ aqi }), profile: p }).actions.map((a) => a.area));
      assert.deepEqual([...areas].sort(), ['alternative', 'indoor', 'routine'], `AQI ${aqi}`);
    }
  }
});

test('outdoor exerciser in moderate air is sent to the cleanest hour, not indoors', () => {
  const advice = buildAdvice({ air: air({ aqi: 80 }), profile: profile({ exercisesOutdoors: true }) });
  assert.equal(find(advice, 'exercise-indoors'), undefined);
  assert.equal(find(advice, 'exercise-clean-hour').params.time, '14:00');
});

test('never suggests moving to an hour dirtier than now', () => {
  const advice = buildAdvice({ air: air({ aqi: 80, pm25: 20 }), profile: profile({ exercisesOutdoors: true }) });
  assert.equal(find(advice, 'exercise-clean-hour'), undefined);
  assert.equal(find(advice, 'errands-clean-hour'), undefined);
  assert.ok(find(advice, 'short-trips'), 'falls back to keeping trips short');
});

// --- impact numbers --------------------------------------------------------

test('car commute → metro switch with weekly CO₂ and the street multiplier', () => {
  const advice = buildAdvice({ air: air(), profile: profile({ commuteMode: 'car', commuteKm: 12 }) });
  const action = find(advice, 'switch-commute');
  // (0.17 − 0.035) kg/km × 12 km × 2 trips × 5 days
  assert.equal(action.impact.co2KgPerWeek, 16.2);
  assert.deepEqual(action.impact.street, { neighbours: 20, co2KgPerWeek: 340.2 });
});

test('no commute switch for metro, cycling or remote workers', () => {
  for (const commuteMode of ['metro', 'cycle', 'remote']) {
    const advice = buildAdvice({ air: air(), profile: profile({ commuteMode, commuteKm: 8 }) });
    assert.equal(find(advice, 'switch-commute'), undefined, commuteMode);
  }
});

test('solid-fuel heating gets a switch action counted in households', () => {
  for (const heating of ['wood', 'coal', 'kerosene']) {
    const action = find(buildAdvice({ air: air(), profile: profile({ heating }) }), 'switch-heating');
    assert.deepEqual(action.impact.street, { neighbours: 20, households: 21 }, heating);
  }
  assert.equal(find(buildAdvice({ air: air(), profile: profile({ heating: 'gas' }) }), 'switch-heating'), undefined);
});

test('purifier owners are told to run it; others get the DIY filter', () => {
  assert.ok(find(buildAdvice({ air: air(), profile: profile({ hasPurifier: true }) }), 'run-purifier'));
  assert.ok(find(buildAdvice({ air: air(), profile: profile() }), 'diy-purifier'));
});

test('errands move to the cleanest hour with cigarettes avoided', () => {
  const action = find(buildAdvice({ air: air(), profile: profile() }), 'errands-clean-hour');
  assert.equal(action.params.time, '14:00');
  // (70 − 30) µg/m³ for 1 h ÷ 22 ÷ 24
  assert.equal(action.impact.cigarettesAvoided, 0.08);
});

// --- purity ---------------------------------------------------------------

test('ranking is deterministic and inputs are not mutated', () => {
  const input = { air: Object.freeze(air()), profile: Object.freeze(profile({ commuteMode: 'car', commuteKm: 5 })) };
  assert.deepEqual(buildAdvice(input), buildAdvice(input));
  const priorities = buildAdvice(input).actions.map((a) => a.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});
