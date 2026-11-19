import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProfile,
  validateLanguage,
  validateTasks,
  validateFindings,
  validatePhoto,
  validateSummary,
  validateCity,
  validateDayText,
  MAX_PHOTO_BYTES,
} from '../src/schemas.js';

const profile = (overrides = {}) => ({
  city: 'Pune',
  groups: ['children'],
  commuteMode: 'car',
  commuteKm: 12,
  heating: 'wood',
  hasPurifier: false,
  exercisesOutdoors: true,
  ...overrides,
});

const task = (overrides = {}) => ({
  name: 'Market',
  start: '11:00',
  durationMin: 60,
  outdoor: true,
  flexible: true,
  ...overrides,
});

const finding = (overrides = {}) => ({
  source: 'Incense stick',
  severity: 'medium',
  fix: 'Use an electric diffuser instead',
  why: 'Burning incense releases fine particles indoors',
  ...overrides,
});

// --- profile ---------------------------------------------------------------

test('profile: accepts a valid profile and trims the city', () => {
  const result = validateProfile(profile({ city: '  Navi Mumbai ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.city, 'Navi Mumbai');
});

test('profile: accepts Devanagari city names', () => {
  assert.equal(validateProfile(profile({ city: 'पुणे' })).ok, true);
});

test('profile: rejects non-objects', () => {
  for (const bad of [null, [], 'Pune', 42]) assert.equal(validateProfile(bad).ok, false);
});

test('profile: rejects bad city, groups, commute, heating and flags', () => {
  const cases = [
    { city: 'P' },
    { city: '<script>' },
    { groups: ['aliens'] },
    { groups: 'children' },
    { commuteMode: 'rocket' },
    { commuteKm: -1 },
    { commuteKm: 201 },
    { heating: 'nuclear' },
    { hasPurifier: 'yes' },
  ];
  for (const overrides of cases) {
    assert.equal(validateProfile(profile(overrides)).ok, false, JSON.stringify(overrides));
  }
});

test('profile: dedupes groups, zeroes km for remote, drops unknown fields', () => {
  const result = validateProfile(profile({ groups: ['elderly', 'elderly'], commuteMode: 'remote', extra: 1 }));
  assert.deepEqual(result.value.groups, ['elderly']);
  assert.equal(result.value.commuteKm, 0);
  assert.equal('extra' in result.value, false);
});

// --- city + day text (scheduler) -------------------------------------------

test('city: trims valid names and rejects junk', () => {
  assert.deepEqual(validateCity('  Pune '), { ok: true, value: 'Pune' });
  for (const bad of ['', 'P', '<b>', 42, null]) assert.equal(validateCity(bad).ok, false);
});

test('day text: 3–500 characters of free text', () => {
  assert.deepEqual(validateDayText(' 9am market 1 hr '), { ok: true, value: '9am market 1 hr' });
  for (const bad of ['', 'hi', 'x'.repeat(501), 7, undefined]) assert.equal(validateDayText(bad).ok, false);
});

// --- language --------------------------------------------------------------

test('language: accepts en, hi, mr and rejects others', () => {
  for (const lang of ['en', 'hi', 'mr']) assert.equal(validateLanguage(lang).ok, true);
  for (const lang of ['fr', '', undefined, 'EN']) assert.equal(validateLanguage(lang).ok, false);
});

// --- tasks (LLM output) ----------------------------------------------------

test('tasks: accepts valid tasks and strips extra fields', () => {
  const result = validateTasks({ tasks: [task({ note: 'ignore me' })] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [task()]);
});

test('tasks: rejects a wrong shape, empty list and more than 12 tasks', () => {
  assert.equal(validateTasks(null).ok, false);
  assert.equal(validateTasks({ tasks: 'x' }).ok, false);
  assert.equal(validateTasks({ tasks: [] }).ok, false);
  assert.equal(validateTasks({ tasks: Array.from({ length: 13 }, () => task()) }).ok, false);
});

test('tasks: rejects invalid fields in any task', () => {
  const cases = [
    { name: '' },
    { name: 'x'.repeat(61) },
    { start: '24:00' },
    { start: '9:00' },
    { durationMin: 4 },
    { durationMin: 481 },
    { durationMin: 30.5 },
    { outdoor: 'yes' },
    { flexible: undefined },
  ];
  for (const overrides of cases) {
    assert.equal(validateTasks({ tasks: [task(), task(overrides)] }).ok, false, JSON.stringify(overrides));
  }
});

// --- findings (LLM output) -------------------------------------------------

test('findings: keeps valid items, drops invalid ones, caps at 6', () => {
  const items = [finding(), finding({ severity: 'extreme' }), ...Array.from({ length: 7 }, () => finding())];
  const result = validateFindings({ findings: items });
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 6);
  assert.ok(result.value.every((f) => f.severity === 'medium'));
});

test('findings: empty list is valid; wrong shape is not', () => {
  assert.deepEqual(validateFindings({ findings: [] }), { ok: true, value: [] });
  assert.equal(validateFindings({ items: [] }).ok, false);
  assert.equal(validateFindings('nope').ok, false);
});

test('findings: drops items with over-long text', () => {
  const result = validateFindings({ findings: [finding({ fix: 'x'.repeat(201) })] });
  assert.deepEqual(result.value, []);
});

// --- summary (LLM output) --------------------------------------------------

test('summary: accepts trimmed text up to 1200 chars, rejects anything else', () => {
  assert.deepEqual(validateSummary({ summary: '  Close windows.  ' }), { ok: true, value: 'Close windows.' });
  for (const bad of [{ summary: '' }, { summary: 42 }, { summary: 'x'.repeat(1201) }, { text: 'hi' }, null]) {
    assert.equal(validateSummary(bad).ok, false, JSON.stringify(bad));
  }
});

// --- photo -----------------------------------------------------------------

const dataUrl = (bytes, type = 'jpeg') => `data:image/${type};base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

test('photo: accepts jpeg, png and webp data URLs', () => {
  for (const type of ['jpeg', 'png', 'webp']) assert.equal(validatePhoto(dataUrl(100, type)).ok, true);
});

test('photo: rejects other types, malformed data and non-strings', () => {
  for (const bad of [dataUrl(100, 'gif'), 'data:image/png;base64,@@@', 'hello', 42, null]) {
    assert.equal(validatePhoto(bad).ok, false);
  }
});

test('photo: enforces the size limit on decoded bytes', () => {
  assert.equal(validatePhoto(dataUrl(MAX_PHOTO_BYTES)).ok, true);
  assert.equal(validatePhoto(dataUrl(MAX_PHOTO_BYTES + 1)).ok, false);
});
