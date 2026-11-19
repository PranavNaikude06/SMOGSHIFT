import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/schemas.js';

const load = async (lang) => JSON.parse(await readFile(new URL(`../public/i18n/${lang}.json`, import.meta.url), 'utf8'));

/** Flattens nested dictionaries to { 'a.b.c': 'text' }. */
function flatten(node, prefix = '') {
  return Object.entries(node).reduce((acc, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? { ...acc, [path]: value } : { ...acc, ...flatten(value, path) };
  }, {});
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every language has exactly the English key set', async () => {
  const en = Object.keys(flatten(await load('en'))).sort();
  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    const keys = Object.keys(flatten(await load(lang))).sort();
    assert.deepEqual(keys.filter((k) => !en.includes(k)), [], `${lang}: extra keys`);
    assert.deepEqual(en.filter((k) => !keys.includes(k)), [], `${lang}: missing keys`);
  }
});

test('every translation keeps the same {placeholders} as English', async () => {
  const en = flatten(await load('en'));
  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    const dict = flatten(await load(lang));
    for (const [key, text] of Object.entries(en)) {
      assert.deepEqual(placeholders(dict[key] ?? ''), placeholders(text), `${lang}: ${key}`);
    }
  }
});

test('no translation is left empty', async () => {
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries(flatten(await load(lang)))) {
      assert.ok(text.trim().length > 0, `${lang}: ${key} is empty`);
    }
  }
});

test('index.html has a labelled language picker offering en, hi and mr', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="language"/);
  for (const lang of LANGUAGES) assert.match(html, new RegExp(`<option value="${lang}" lang="${lang}">`));
});
