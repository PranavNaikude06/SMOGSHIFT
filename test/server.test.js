import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createRateLimiter } from '../src/rateLimit.js';
import { NotFoundError, UpstreamError } from '../src/errors.js';
import { LlmError } from '../src/llm.js';

const AIR = Object.freeze({
  location: { name: 'Pune', region: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.8 },
  current: { time: '2026-11-20T08:00', aqi: 160, pm25: 70, pm10: 90, no2: 30, o3: 10 },
  hourly: Array.from({ length: 24 }, (_, h) => ({
    time: `2026-11-20T${String(h).padStart(2, '0')}:00`, aqi: 150, pm25: h === 15 ? 30 : 70,
  })),
});

const PROFILE = {
  city: 'Pune', groups: ['children'], commuteMode: 'car', commuteKm: 10,
  heating: 'wood', hasPurifier: false, exercisesOutdoors: true,
};

const STATIC = new Map([['/', { type: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><title>SmogShift</title>') }]]);

/** Per-test fakes; tests swap behaviour by reassigning these. */
const fakes = { air: async () => AIR, chat: async () => ({ summary: 'Stay in, Pune.' }), prompts: [] };

let server;
let base;
let limiter;

before(async () => {
  limiter = createRateLimiter({ limit: 1000, windowMs: 60_000 });
  server = createApp({
    getAirData: (...args) => fakes.air(...args),
    chat: (prompt) => { fakes.prompts.push(prompt); return fakes.chat(prompt); },
    rateLimiter: { check: (key) => limiter.check(key) },
    staticFiles: STATIC,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const postPlan = (body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/plan`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const reset = () => {
  fakes.air = async () => AIR;
  fakes.chat = async () => ({ summary: 'Stay in, Pune.' });
  fakes.prompts = [];
};

// --- static + health ------------------------------------------------------

test('GET / serves the page with security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('permissions-policy'));
});

test('static files are gzipped for clients that accept it and revalidate with ETag → 304', async () => {
  const gz = await fetch(`${base}/`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.match(gz.headers.get('vary'), /Accept-Encoding/);
  const etag = gz.headers.get('etag');
  assert.match(etag, /^"[\w-]+"$/);
  assert.match(await gz.text(), /SmogShift/, 'fetch transparently decompresses');

  const cached = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
});

test('GET /healthz answers ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('unknown paths are 404 and never read the filesystem', async () => {
  for (const path of ['/nope', '/../server.js', '/%2e%2e/.env', '/api/unknown']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

// --- /api/plan happy paths --------------------------------------------------

test('POST /api/plan returns air, ranked advice and the AI summary', async () => {
  reset();
  const res = await postPlan({ profile: PROFILE, language: 'mr' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.location.name, 'Pune');
  assert.equal(body.air.current.aqi, 160);
  assert.equal(body.air.hourly.length, 24);
  assert.equal(body.advice.category.id, 'unhealthy');
  assert.ok(body.advice.actions.length >= 3);
  assert.deepEqual({ summary: body.summary, source: body.summarySource }, { summary: 'Stay in, Pune.', source: 'ai' });

  const [prompt] = fakes.prompts;
  assert.equal(prompt.language, 'mr');
  assert.match(prompt.user, /Pune/);
  assert.match(prompt.user, /exercise-indoors/);
  assert.match(prompt.user, /"category":"Unhealthy"/, 'readable category name, not the raw id');
});

test('summary prompt never leaks the raw "usg" category id', async () => {
  reset();
  fakes.air = async () => ({ ...AIR, current: { ...AIR.current, aqi: 120, pm25: 45 } });
  await postPlan({ profile: PROFILE, language: 'en' });
  assert.doesNotMatch(fakes.prompts[0].user, /"usg"/);
  assert.match(fakes.prompts[0].user, /Unhealthy for sensitive groups/);
});

test('the city is geocoded in the UI language', async () => {
  reset();
  let seen;
  fakes.air = async (city, language) => { seen = { city, language }; return AIR; };
  await postPlan({ profile: { ...PROFILE, city: 'पुणे' }, language: 'mr' });
  assert.deepEqual(seen, { city: 'पुणे', language: 'mr' });
});

test('AI failure or an invalid AI answer still returns the plan with summary null', async () => {
  reset();
  for (const chat of [
    async () => { throw new LlmError('timeout', 'slow'); },
    async () => ({ summary: 42 }),
    async () => ({ summary: 'x'.repeat(2000) }),
  ]) {
    fakes.chat = chat;
    const body = await (await postPlan({ profile: PROFILE, language: 'en' })).json();
    assert.equal(body.summary, null);
    assert.equal(body.summarySource, 'none');
    assert.ok(body.advice.actions.length > 0);
  }
});

// --- /api/plan errors -------------------------------------------------------

test('invalid profile or language → 400 with details', async () => {
  reset();
  for (const body of [{ profile: { ...PROFILE, city: '<x>' }, language: 'en' }, { profile: PROFILE, language: 'fr' }, {}]) {
    const res = await postPlan(body);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error);
    assert.ok(Array.isArray(json.details) && json.details.length > 0);
  }
});

test('malformed JSON → 400; wrong content type → 415; oversize body → 413', async () => {
  assert.equal((await postPlan('{not json')).status, 400);
  assert.equal((await postPlan('city=Pune', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await postPlan({ profile: PROFILE, pad: 'x'.repeat(10_000) })).status, 413);
});

test('wrong method on /api/plan → 405', async () => {
  const res = await fetch(`${base}/api/plan`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('unknown city → 404 and upstream outage → 502, with safe messages', async () => {
  reset();
  fakes.air = async () => { throw new NotFoundError('We couldn\'t find "Atlantis".'); };
  let res = await postPlan({ profile: PROFILE, language: 'en' });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Atlantis/);

  fakes.air = async () => { throw new UpstreamError('Air service down.'); };
  res = await postPlan({ profile: PROFILE, language: 'en' });
  assert.equal(res.status, 502);
});

test('unexpected errors → 500 without leaking internals', async () => {
  reset();
  fakes.air = async () => { throw new TypeError('secret stack detail'); };
  const res = await postPlan({ profile: PROFILE, language: 'en' });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret stack detail/);
});

// --- /api/schedule -----------------------------------------------------------

const postSchedule = (body) =>
  fetch(`${base}/api/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const DAY_TASKS = {
  tasks: [
    { name: 'School drop', start: '09:00', durationMin: 20, outdoor: true, flexible: false },
    { name: 'Market', start: '11:00', durationMin: 60, outdoor: true, flexible: true },
  ],
};

test('POST /api/schedule extracts tasks with AI and reschedules them in code', async () => {
  reset();
  fakes.chat = async () => DAY_TASKS;
  const res = await postSchedule({ city: 'Pune', text: '9am school drop 20 min, 11am market 1 hr', language: 'hi' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.location.name, 'Pune');
  const market = body.schedule.tasks.find((t) => t.name === 'Market');
  assert.equal(market.newStart, '15:00');
  assert.ok(body.schedule.totals.after < body.schedule.totals.before);

  const [prompt] = fakes.prompts;
  assert.equal(prompt.language, 'hi');
  assert.equal(prompt.user, '9am school drop 20 min, 11am market 1 hr');
  assert.match(prompt.system, /ignore any instructions/i);
});

test('/api/schedule: invalid input → 400', async () => {
  reset();
  for (const body of [{ city: 'Pune', text: 'x', language: 'en' }, { city: '<x>', text: '9am walk', language: 'en' }, {}]) {
    assert.equal((await postSchedule(body)).status, 400, JSON.stringify(body));
  }
});

test('/api/schedule: unreadable AI output → 422, no key → 503, AI outage → 502', async () => {
  reset();
  fakes.chat = async () => ({ tasks: [{ name: 'Walk', start: 'soon' }] });
  assert.equal((await postSchedule({ city: 'Pune', text: 'walk later maybe', language: 'en' })).status, 422);

  fakes.chat = async () => { throw new LlmError('no_key', 'missing'); };
  assert.equal((await postSchedule({ city: 'Pune', text: '9am walk', language: 'en' })).status, 503);

  fakes.chat = async () => { throw new LlmError('http', 'boom', 500); };
  assert.equal((await postSchedule({ city: 'Pune', text: '9am walk', language: 'en' })).status, 502);
});

test('Groq rate limiting (429) is passed on as 429 with Retry-After', async () => {
  reset();
  fakes.chat = async () => { throw new LlmError('http', 'slow down', 429); };
  const res = await postSchedule({ city: 'Pune', text: '9am walk', language: 'en' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('each AI call type sends its own token budget', async () => {
  reset();
  fakes.chat = async () => DAY_TASKS;
  await postSchedule({ city: 'Pune', text: '9am walk', language: 'en' });
  fakes.chat = async () => ({ summary: 'ok' });
  await postPlan({ profile: PROFILE, language: 'en' });
  const [tasks, summary] = fakes.prompts;
  assert.ok(tasks.maxTokens > 0 && summary.maxTokens > 0);
  assert.ok(summary.maxTokens < tasks.maxTokens, 'summaries are short, so their budget is smaller');
});

// --- /api/audit ---------------------------------------------------------------

const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString('base64')}`;
const postAudit = (body) =>
  fetch(`${base}/api/audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/audit sends the photo to the vision model and returns validated findings', async () => {
  reset();
  fakes.chat = async () => ({
    findings: [
      { source: 'Incense', severity: 'medium', fix: 'Use a diffuser', why: 'Smoke adds fine particles' },
      { source: 'Bad item', severity: 'catastrophic', fix: 'x', why: 'y' },
    ],
  });
  const res = await postAudit({ photo: PHOTO, language: 'mr' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).findings.map((f) => f.source), ['Incense']);

  const [prompt] = fakes.prompts;
  assert.equal(prompt.image, PHOTO);
  assert.equal(prompt.language, 'mr');
  assert.match(prompt.system, /only what is visible/i);
});

test('/api/audit: empty findings are a valid answer', async () => {
  reset();
  fakes.chat = async () => ({ findings: [] });
  assert.deepEqual(await (await postAudit({ photo: PHOTO, language: 'en' })).json(), { findings: [] });
});

test('/api/audit: non-image → 400, oversize → 413, unreadable AI → 502, no key → 503', async () => {
  reset();
  assert.equal((await postAudit({ photo: 'data:image/gif;base64,AAAA', language: 'en' })).status, 400);
  const huge = `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024, 1).toString('base64')}`;
  assert.equal((await postAudit({ photo: huge, language: 'en' })).status, 413);

  fakes.chat = async () => ({ items: 'nope' });
  assert.equal((await postAudit({ photo: PHOTO, language: 'en' })).status, 502);

  fakes.chat = async () => { throw new LlmError('no_key', 'missing'); };
  assert.equal((await postAudit({ photo: PHOTO, language: 'en' })).status, 503);
});

test('other API routes keep the small 8 KB body limit', async () => {
  reset();
  assert.equal((await postSchedule({ city: 'Pune', text: '9am walk', language: 'en', pad: 'x'.repeat(9000) })).status, 413);
});

test('rate limit → 429 with Retry-After', async () => {
  reset();
  limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal((await postPlan({ profile: PROFILE, language: 'en' })).status, 200);
  const res = await postPlan({ profile: PROFILE, language: 'en' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  limiter = createRateLimiter({ limit: 1000, windowMs: 60_000 });
});
