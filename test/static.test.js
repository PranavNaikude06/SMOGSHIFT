import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadStaticFiles } from '../src/http.js';
import { buildAdvice } from '../src/advice.js';
import { GROUPS, COMMUTE_MODES, HEATING_TYPES } from '../src/schemas.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const loadDictionary = async (lang) => JSON.parse(await read(`i18n/${lang}.json`));

/** Every action id the engine can emit, found by sweeping bands and profiles. */
function allActionIds() {
  const ids = new Set();
  const hourly = Array.from({ length: 24 }, (_, h) => ({ time: `2026-11-20T${String(h).padStart(2, '0')}:00`, aqi: 100, pm25: h === 15 ? 10 : 80 }));
  for (const aqi of [30, 80, 130, 180, 350]) {
    for (const groups of [[], ['respiratory']]) {
      for (const [commuteMode, heating, hasPurifier, exercisesOutdoors] of [
        ['car', 'wood', false, true], ['remote', 'electric', true, false], ['walk', 'gas', false, true]]) {
        for (const pm25 of [80, 5]) {
          const air = { current: { time: '2026-11-20T08:00', aqi, pm25 }, hourly };
          const profile = { city: 'X', groups, commuteMode, commuteKm: 10, heating, hasPurifier, exercisesOutdoors };
          for (const a of buildAdvice({ air, profile }).actions) ids.add(a.id);
        }
      }
    }
  }
  return ids;
}

test('loadStaticFiles serves the real public files with correct types', async () => {
  const files = await loadStaticFiles(PUBLIC_DIR);
  const types = Object.fromEntries([...files].map(([route, f]) => [route, f.type]));
  assert.match(types['/'], /text\/html/);
  assert.match(types['/app.js'], /text\/javascript/);
  assert.match(types['/styles.css'], /text\/css/);
  assert.match(types['/i18n/en.json'], /application\/json/);
});

test('index.html is CSP-safe: no inline scripts, styles or event handlers', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline <script>');
  assert.doesNotMatch(html, /<style|\sstyle=/, 'inline style');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'inline event handler');
});

test('index.html has a labelled Smog Scheduler form with a live results region', async () => {
  const html = await read('index.html');
  assert.match(html, /<label for="day-text"/);
  assert.match(html, /<textarea id="day-text"[^>]*maxlength="500"/);
  assert.match(html, /id="schedule-results"[^>]*aria-live="polite"/);
  assert.match(html, /id="schedule-error"[^>]*role="alert"/);
});

test('English dictionary has every scheduler and error string the UI uses', async () => {
  const dict = await loadDictionary('en');
  const required = {
    schedule: ['heading', 'intro', 'label', 'hint', 'counter', 'submit', 'loading', 'resultsHeading',
      'total', 'moved', 'stays', 'cigs', 'n95'],
    'schedule.reason': ['fixed', 'indoor', 'past', 'noBetter'],
    errors: ['cityFirst', 'dayRequired', 'dayUnreadable', 'aiUnavailable', 'aiBusy'],
  };
  for (const [section, keys] of Object.entries(required)) {
    const node = section.split('.').reduce((n, k) => n?.[k], dict);
    for (const key of keys) assert.ok(node?.[key], `${section}.${key}`);
  }
});

test('index.html has a labelled Photo Audit form limited to JPEG, PNG and WebP', async () => {
  const html = await read('index.html');
  assert.match(html, /<label for="photo"/);
  assert.match(html, /<input id="photo"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /id="audit-results"[^>]*aria-live="polite"/);
  assert.match(html, /id="audit-error"[^>]*role="alert"/);
});

test('English dictionary has every Photo Audit string the UI uses', async () => {
  const dict = await loadDictionary('en');
  const required = {
    audit: ['heading', 'intro', 'label', 'hint', 'submit', 'loading', 'resultsHeading', 'none', 'previewAlt', 'why'],
    'audit.severity': ['low', 'medium', 'high'],
    errors: ['photoRequired', 'photoInvalid', 'photoTooBig', 'photoTooSmall'],
  };
  for (const [section, keys] of Object.entries(required)) {
    const node = section.split('.').reduce((n, k) => n?.[k], dict);
    for (const key of keys) assert.ok(node?.[key], `${section}.${key}`);
  }
});

test('English dictionary covers every action the engine can produce', async () => {
  const dict = await loadDictionary('en');
  const ids = allActionIds();
  assert.ok(ids.size >= 14, `sweep found only ${ids.size} action ids`);
  for (const id of ids) {
    assert.ok(dict.actions[id]?.title, `actions.${id}.title`);
    assert.ok(dict.actions[id]?.detail, `actions.${id}.detail`);
  }
});

test('English dictionary covers every category, area, group, commute mode and fuel', async () => {
  const dict = await loadDictionary('en');
  const required = {
    category: ['good', 'moderate', 'usg', 'unhealthy', 'very_unhealthy', 'hazardous'],
    area: ['routine', 'indoor', 'alternative'],
    groups: GROUPS,
    commuteModes: COMMUTE_MODES,
    heatingTypes: HEATING_TYPES,
  };
  for (const [section, keys] of Object.entries(required)) {
    for (const key of keys) assert.ok(dict[section]?.[key], `${section}.${key}`);
  }
});
