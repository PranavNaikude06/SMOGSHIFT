import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAirDataClient } from '../src/airData.js';
import { NotFoundError, UpstreamError } from '../src/errors.js';

const GEO = {
  results: [{ name: 'Pune', country: 'India', admin1: 'Maharashtra', latitude: 18.52, longitude: 73.86, timezone: 'Asia/Kolkata' }],
};
const AIR = {
  current: { time: '2026-11-20T08:00', us_aqi: 162, pm2_5: 76.4, pm10: 98.1, nitrogen_dioxide: 41, ozone: 12 },
  hourly: {
    time: ['2026-11-20T07:00', '2026-11-20T08:00', '2026-11-20T09:00'],
    us_aqi: [170, 162, null],
    pm2_5: [80.2, 76.4, 60.1],
  },
};

/** Routes by host; counts calls; `fail` makes a host return HTTP 500 or throw. */
function fakeFetch({ geo = GEO, air = AIR, fail } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const isGeo = String(url).includes('geocoding-api');
    if (fail === 'throw') throw new TypeError('fetch failed');
    if (fail === (isGeo ? 'geo' : 'air')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (isGeo ? geo : air) };
  };
  return { impl, calls };
}

test('geocodes the city and maps current + hourly air data', async () => {
  const { impl, calls } = fakeFetch();
  const data = await createAirDataClient({ fetchImpl: impl }).getAirData('Pune');

  assert.deepEqual(data.location, { name: 'Pune', region: 'Maharashtra', country: 'India', latitude: 18.52, longitude: 73.86 });
  assert.deepEqual(data.current, { time: '2026-11-20T08:00', aqi: 162, pm25: 76.4, pm10: 98.1, no2: 41, o3: 12 });
  assert.deepEqual(data.hourly, [
    { time: '2026-11-20T07:00', aqi: 170, pm25: 80.2 },
    { time: '2026-11-20T08:00', aqi: 162, pm25: 76.4 },
  ], 'hours with missing values are dropped');
  assert.match(calls[0], /name=Pune/);
  assert.match(calls[1], /latitude=18\.52&longitude=73\.86/);
});

test('URL-encodes the city name', async () => {
  const { impl, calls } = fakeFetch();
  await createAirDataClient({ fetchImpl: impl }).getAirData('Navi Mumbai');
  assert.match(calls[0], /name=Navi(%20|\+)Mumbai/);
});

test('passes the UI language to the geocoder (helps Devanagari names), defaulting to en', async () => {
  const { impl, calls } = fakeFetch();
  const client = createAirDataClient({ fetchImpl: impl });
  await client.getAirData('पुणे', 'mr');
  await client.getAirData('Delhi');
  assert.match(calls[0], /language=mr/);
  assert.match(calls[2], /language=en/);
});

test('unknown city throws NotFoundError', async () => {
  const { impl } = fakeFetch({ geo: {} });
  await assert.rejects(createAirDataClient({ fetchImpl: impl }).getAirData('Atlantis'), NotFoundError);
});

test('upstream HTTP errors and network failures throw UpstreamError', async () => {
  for (const fail of ['geo', 'air', 'throw']) {
    const { impl } = fakeFetch({ fail });
    await assert.rejects(createAirDataClient({ fetchImpl: impl }).getAirData('Pune'), UpstreamError, fail);
  }
});

test('upstream errors carry an internal cause (host + status) for server logs', async () => {
  const { impl } = fakeFetch({ fail: 'air' });
  await assert.rejects(createAirDataClient({ fetchImpl: impl }).getAirData('Pune'),
    (err) => err instanceof UpstreamError && /air-quality-api\.open-meteo\.com: HTTP 500/.test(err.cause.message)
      && !/open-meteo/.test(err.message));
});

test('missing current readings throw UpstreamError', async () => {
  const { impl } = fakeFetch({ air: { ...AIR, current: { time: 'x', us_aqi: null, pm2_5: null } } });
  await assert.rejects(createAirDataClient({ fetchImpl: impl }).getAirData('Pune'), UpstreamError);
});

test('caches per city (case-insensitive) until the TTL expires', async () => {
  let clock = 0;
  const { impl, calls } = fakeFetch();
  const client = createAirDataClient({ fetchImpl: impl, now: () => clock, ttlMs: 1000 });

  await client.getAirData('Pune');
  await client.getAirData('pune');
  assert.equal(calls.length, 2, 'second call served from cache');

  clock = 1001;
  await client.getAirData('Pune');
  assert.equal(calls.length, 4, 'expired entry refetched');
});

test('concurrent requests for one city share a single upstream fetch', async () => {
  const { impl, calls } = fakeFetch();
  const client = createAirDataClient({ fetchImpl: impl });
  await Promise.all([client.getAirData('Pune'), client.getAirData('Pune')]);
  assert.equal(calls.length, 2);
});

test('failed lookups are not cached', async () => {
  let fail = 'air';
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (fail && String(url).includes('air-quality')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (String(url).includes('geocoding') ? GEO : AIR) };
  };
  const client = createAirDataClient({ fetchImpl: impl });
  await assert.rejects(client.getAirData('Pune'), UpstreamError);
  fail = null;
  const data = await client.getAirData('Pune');
  assert.equal(data.current.aqi, 162);
});

test('evicts the oldest city when the cache is full', async () => {
  const { impl, calls } = fakeFetch();
  const client = createAirDataClient({ fetchImpl: impl, maxEntries: 2 });
  await client.getAirData('Pune');
  await client.getAirData('Delhi');
  await client.getAirData('Agra');
  const before = calls.length;
  await client.getAirData('Pune');
  assert.equal(calls.length, before + 2, 'Pune was evicted and refetched');
});
