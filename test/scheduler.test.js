import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reschedule } from '../src/scheduler.js';

/** Hourly PM2.5 for 2026-11-20; `overrides` maps hour → pm25, everything else is `base`. */
const day = (overrides = {}, base = 80) =>
  Array.from({ length: 24 }, (_, h) => ({
    time: `2026-11-20T${String(h).padStart(2, '0')}:00`,
    aqi: 150,
    pm25: overrides[h] ?? base,
  }));

const task = (name, start, durationMin, outdoor = true, flexible = true) => ({ name, start, durationMin, outdoor, flexible });
const NOW = '2026-11-20T08:30';
const byName = (result, name) => result.tasks.find((t) => t.name === name);

test('moves a flexible outdoor task to the cleanest free slot and reports cigarettes before → after', () => {
  const result = reschedule([task('Market', '11:00', 60)], day({ 15: 30 }), { now: NOW });
  const market = byName(result, 'Market');
  assert.equal(market.newStart, '15:00');
  assert.equal(market.moved, true);
  assert.equal(market.before, 0.15); // 80 µg/m³ × 1 h ÷ 22 ÷ 24
  assert.equal(market.after, 0.06);  // 30 µg/m³ × 1 h ÷ 22 ÷ 24
  assert.deepEqual(result.totals, { before: 0.15, after: 0.06 });
});

test('fixed outdoor tasks stay and get an N95 tip when the air is unhealthy', () => {
  const result = reschedule([task('School drop', '09:00', 20, true, false)], day({ 15: 10 }), { now: NOW });
  const drop = byName(result, 'School drop');
  assert.equal(drop.newStart, '09:00');
  assert.equal(drop.moved, false);
  assert.equal(drop.mitigation, 'n95');
});

test('no N95 tip when a fixed task is already in clean air', () => {
  const drop = byName(reschedule([task('Drop', '09:00', 20, true, false)], day({}, 12), { now: NOW }), 'Drop');
  assert.equal(drop.mitigation, null);
});

test('indoor tasks never move, have no exposure figures, but block their time slot', () => {
  const result = reschedule(
    [task('Cooking class', '15:00', 60, false, false), task('Walk', '18:00', 45)],
    day({ 15: 20, 16: 40 }),
    { now: NOW },
  );
  const cooking = byName(result, 'Cooking class');
  assert.deepEqual([cooking.newStart, cooking.before, cooking.after], ['15:00', null, null]);
  assert.equal(byName(result, 'Walk').newStart, '16:00', 'next-best slot because 15:00 is taken');
});

test('flexible tasks never overlap each other', () => {
  const result = reschedule([task('Walk', '10:00', 60), task('Market', '19:00', 60)], day({ 15: 20, 16: 25 }), { now: NOW });
  const starts = [byName(result, 'Walk').newStart, byName(result, 'Market').newStart].sort();
  assert.deepEqual(starts, ['15:00', '16:00']);
});

test('tasks that already started before now are left alone and marked past', () => {
  const past = byName(reschedule([task('Jog', '06:30', 30)], day({ 15: 10 }), { now: NOW }), 'Jog');
  assert.equal(past.newStart, '06:30');
  assert.equal(past.past, true);
});

test('does not move a task for a negligible gain', () => {
  const walk = byName(reschedule([task('Walk', '18:00', 60)], day({ 15: 77 }), { now: NOW }), 'Walk');
  assert.equal(walk.moved, false);
  assert.equal(walk.newStart, '18:00');
});

test('equal slots: earliest wins, so the schedule is deterministic', () => {
  const tasks = [task('Walk', '20:00', 60)];
  const air = day({ 10: 20, 14: 20 });
  const first = reschedule(tasks, air, { now: NOW });
  assert.equal(byName(first, 'Walk').newStart, '10:00');
  assert.deepEqual(reschedule(tasks, air, { now: NOW }), first);
});

test('only schedules between 06:00 and 21:00, from the next half hour', () => {
  const result = reschedule([task('Walk', '12:00', 60)], day({ 5: 1, 8: 1, 21: 1, 22: 1, 13: 40 }), { now: NOW });
  assert.equal(byName(result, 'Walk').newStart, '13:00', '05:00, 08:00 (past), 21:00 and 22:00 are out of bounds');
});

test('a task with no free window long enough stays put', () => {
  const result = reschedule([task('Hike', '09:00', 480)], day({ 15: 10 }), { now: '2026-11-20T14:00' });
  assert.equal(byName(result, 'Hike').moved, false);
});

test('without forecast data nothing moves and exposure is unknown', () => {
  const walk = byName(reschedule([task('Walk', '18:00', 60)], [], { now: NOW }), 'Walk');
  assert.deepEqual([walk.moved, walk.before, walk.after], [false, null, null]);
});

test('keeps the input order and does not mutate the input', () => {
  const tasks = Object.freeze([Object.freeze(task('B', '18:00', 30)), Object.freeze(task('A', '09:00', 30))]);
  const result = reschedule(tasks, day({ 15: 10 }), { now: NOW });
  assert.deepEqual(result.tasks.map((t) => t.name), ['B', 'A']);
});
