# SmogShift: Task List

Plan: [`plan.md`](plan.md) · Spec: [`../SPEC.md`](../SPEC.md)
Every task: `npm test` green before it's ticked. No task touches more than 5 files.

## Phase 1: Foundation

- [x] **T1 Scaffold + impact maths** (S)
  - Acceptance: `package.json` (type module, scripts from SPEC, engines ≥ 20, no deps), `.gitignore`
    (`.env`, `node_modules`, `coverage`), `.env.example`; `impact.js` exports `cigaretteEquivalent`,
    `exposureFactor({ indoors, windowsClosed, hasPurifier })`, `commuteCo2(mode, km)`,
    `streetMultiplier(value, neighbours)`; constants carry source comments.
  - Verify: `npm test`, which covers 0, boundary and invalid inputs.
  - Files: `package.json`, `.gitignore`, `.env.example`, `src/impact.js`, `test/impact.test.js`
  - Deps: none

- [x] **T2 Schemas** (S)
  - Acceptance: `schemas.js` = profile validator (moved from `validate.js`, file deleted) + `tasks`
    (≤ 12, `HH:MM`, 5–480 min, booleans) + `findings` (≤ 6, severity enum, strings ≤ 200 chars) +
    `photo` (data URL, jpeg/png/webp, ≤ 1.5 MB) + `language` (`en|hi|mr`). Each returns
    `{ ok, value | errors }`; never throws on bad input.
  - Verify: `npm test`, covering valid, missing, wrong-type, oversize and extra-field cases.
  - Files: `src/schemas.js`, `src/validate.js` (delete), `test/schemas.test.js`
  - Deps: none

- [x] **T3 Groq client** (S, high risk, do early)
  - Acceptance: `llm.js` exports `chatJson({ system, user, image?, language }, { apiKey, model,
    fetchImpl })` → parsed object or a typed `LlmError` (`no_key|timeout|http|bad_json`);
    `response_format: json_object`, 12 s timeout, temperature 0.3, max_tokens bounded.
  - Verify: `npm test` (fake fetch: ok, 429, 500, timeout, non-JSON, missing key) and a **manual**
    live call with a real key: EN + MR text, plus one image.
  - Files: `src/llm.js`, `test/llm.test.js`
  - Deps: none

- [x] **T4 Air data** (S)
  - Acceptance: `getAirData(city, { fetchImpl, now })` → `{ location, current: { aqi, pm25, pm10,
    no2, o3, time }, hourly: [{ time, aqi, pm25 }] }`; `NotFoundError` for unknown city,
    `UpstreamError` on failure/timeout (8 s); 10-min TTL cache capped at 500 entries.
  - Verify: `npm test`, covering mapping, unknown city, upstream 500, cache hit (fetch called once) and expiry.
  - Files: `src/airData.js`, `src/errors.js`, `test/airData.test.js`
  - Deps: none

### Checkpoint A (passed 2026-11-20)
- [x] `npm test` green (42 tests)
- [x] Live Groq call returns valid JSON in English and Marathi, plus one image request

## Phase 2: Vertical slices

- [x] **T5 US-1 advice engine** (M)
  - Acceptance: `buildAdvice({ air, profile })` → `{ category, actions[] }`, each action
    `{ id, area: routine|indoor|alternative, priority, impact: { cigarettesAvoided?, co2KgPerWeek?,
    street? } }`; ≥ 1 action per area when AQI > 50; AQI band boundaries 50/100/150/200/300 exact;
    asthma + AQI 180 → `exercise-indoors` first; AQI 40 → no mask action; street multiplier on
    heating/burning/car actions. Action text is i18n keys, not English strings.
  - Verify: `npm test` (table-driven cases per band and per profile flag).
  - Files: `src/advice.js`, `test/advice.test.js`
  - Deps: T1, T4 (shape only)

- [x] **T6a US-1 backend** (M). Split from T6 because the slice touched about 10 files.
  - Done: `server.js` `createApp(deps)`, `src/http.js`, `src/rateLimit.js`, `src/prompts.js`,
    `validateSummary`; 17 new tests; live Delhi/Marathi smoke test 200 in 1.9 s.
  - Decision: AI failure → `summary: null`, and the UI renders a template summary from its i18n
    dictionary, so all user-facing text stays in one place per language.
- [x] **T6b US-1 UI** (M): `public/index.html`, `app.js`, `styles.css`, `i18n/en.json`, plus a
  `loadStaticFiles` test against the real `public/` directory. Show PM2.5, not AQI, for hour-level advice.
- (original T6 acceptance, kept for reference) `server.js` exports `createServer(deps)`; routes `GET /`, static whitelist,
    `GET /healthz`, `POST /api/plan` (validate → air → advice → Groq summary or template
    fallback); JSON body ≤ 8 KB, `Content-Type` check; headers: CSP `default-src 'self'`,
    nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, Permissions-Policy;
    rate limit 20/min/IP → 429; safe error messages. UI: labelled form → AQI card (text label) +
    action cards + summary, rendered via `textContent`.
  - Verify: `npm test` (`server.test.js`: 200, 400, 404, 413, 415, 429, 502, headers);
    manual run with `npm run dev`.
  - Files: `server.js`, `src/rateLimit.js`, `public/index.html`, `public/app.js`, `public/styles.css`
    (+ `test/server.test.js`)
  - Deps: T2, T3, T4, T5

### Checkpoint B (passed 2026-11-20)
- [x] US-1 works in the browser, with key (Delhi, AI summary) and with key unset (Pune, template summary)

- [x] **T7a US-2 scheduler logic + `/api/schedule`** (M). Split from T7 (about 9 files).
  - Done: `src/scheduler.js` (30-min grid, 06:00–21:00, no overlaps, ≥10 % gain to move, earliest
    tie, N95 tip above 35.5 µg/m³), `tasksPrompt`, `validateCity`/`validateDayText`, route with air +
    LLM in parallel; 17 new tests (95 total).
  - Live: Delhi day 0.81 → 0.44 cigarettes in 1.3 s; Marathi day parsed; 2 prompt-injection attempts
    handled safely (422 and ignored).
  - Found: Groq free tier returned **429 after 3 quick calls**. It degrades to a friendly 502, but see T10.
- [x] **T7b US-2 UI** (done 2026-11-20, browser-verified on Delhi: 0.48 → 0.3 cigarettes): day textarea (labelled, 500-char counter), results table before → after with
  a moved/fixed text label, N95 tip, day total in cigarettes; `en.json` strings + static test coverage.
- (original T7 acceptance, kept for reference)
  - Acceptance: `scheduler.js` `reschedule(tasks, hourly, { from: '06:00', to: '21:00', now })` →
    `{ tasks: [{ ...task, newStart, before, after }], totals }`; only flexible outdoor tasks move;
    no overlaps; stays at the original time if no cleaner slot; deterministic tie-break (earliest).
    `POST /api/schedule`: text ≤ 500 chars → Groq tasks → `schemas.tasks` → reschedule. UI section
    with a before/after list and a total in cigarettes.
  - Verify: `npm test` (overlap, all-fixed, no-clean-slot, tie, past hours skipped,
    invalid LLM output → 502 friendly).
  - Files: `src/scheduler.js`, `test/scheduler.test.js`, `server.js`, `public/app.js`, `public/index.html`
  - Deps: T6

- [x] **T8 US-3 Photo Audit** (M). Done 2026-11-20: 103 tests; browser-verified 1600×1200 PNG →
  1024×768 JPEG (9 KB) → Groq vision → "none spotted" fallback. Still to check by hand: a real room photo.
  - Acceptance: `POST /api/audit` (body ≤ 2 MB) → `schemas.photo` → Groq vision → `schemas.findings`;
    photo never logged or stored. Client: file input with label, canvas downscale ≤ 1024 px JPEG
    q0.8, preview with alt text, findings list with a severity text label. Client rejects images
    under 32 px on either side (Groq returns 400 below that, verified live 2026-11-20).
  - Verify: `npm test` (bad MIME 400, oversize 413, LLM bad JSON 502, empty findings → fallback tips);
    manual run with a real kitchen photo.
  - Files: `server.js`, `public/app.js`, `public/index.html`, `test/server.test.js`
  - Deps: T6

### Checkpoint C
- [x] All three features work locally; reviewed by the human (asked for the remote-commute fix, done)

## Phase 3: Polish and ship

- [x] **T9 i18n en / hi / mr** (M). Done: hand-written hi/mr dictionaries, key and placeholder parity
  tests, a labelled picker that sets `<html lang>`, persisted with try/catch, browser-language fallback.
  Browser-verified in Marathi (Devanagari numerals via Intl). Fixed the raw "usg" id leaking into the
  AI summary. Also: commute distance is disabled for "work from home" (user request) and 5xx causes are now logged.
  - Acceptance: `public/i18n/{en,hi,mr}.json` share an identical key set; a language `<select>` with a
    label sets `<html lang>`; choice persisted in `localStorage` (try/catch); `language` sent to the
    API and Groq answers in it. City field hint: "English spelling works best". The geocoder
    finds पुणे with `language=mr`, but not मुंबई (checked live).
  - Verify: test asserting the key sets are identical; manual check in all 3 languages.
  - Files: `public/i18n/*.json`, `public/app.js`, `public/index.html`, `test/i18n.test.js`
  - Deps: T6–T8

- [x] **T10 Accessibility + performance pass** (S). Done: Lighthouse mobile scored 100 on Accessibility,
  Best Practices, SEO and Agentic Browsing (49/49; CLS 0.095 fixed by reserving checkbox space); gzip +
  ETag/304 for static files; per-call Groq token budgets (400/600/600); Groq 429 → our 429 + Retry-After.
  - Acceptance: skip link, `aria-live` results, `role="alert"` errors, focus moved to result
    headings, contrast ≥ 4.5:1, `prefers-reduced-motion`, 320 px layout; static files served with
    `Cache-Control` and gzip. Groq budget: lower `max_completion_tokens` per call type
    (summary about 400, tasks about 600); map Groq 429 to 503 + Retry-After so the UI says "AI busy, retry in N s".
  - Verify: keyboard-only walkthrough; Lighthouse a11y ≥ 95, perf ≥ 90 locally.
  - Files: `public/styles.css`, `public/index.html`, `server.js`
  - Deps: T9

- [x] **T11 README + coverage** (S). Done: README covers vertical, approach, how it works, Gen AI use, assumptions with sources, a criteria map; 98.25 % line coverage
  - Acceptance: README covers vertical, approach and logic, how it works (diagram), assumptions with
    sources, run/test/deploy, security and accessibility notes, where Groq is used;
    `npm run coverage` ≥ 80 % lines on `src/`.
  - Verify: `npm run coverage`
  - Files: `README.md`, extra tests as needed
  - Deps: T10

### Checkpoint D
- [x] Spec success criteria 2–4 met locally (113 tests, 98 % coverage, keyless mode verified); repo is 206 KB

- [ ] **T12 Ship** (S, **ask first**)
  - Acceptance: `git init -b main`, one branch, first commit; human creates the public GitHub repo;
    push; Render web service (`npm start`, env `GROQ_API_KEY`); deployed `/healthz` 200.
  - Verify: open the deployed URL and run US-1/2/3; Lighthouse on the deployed URL.
  - Deps: T11

- [x] **T13 Submission pack** (S). Done: tasks/submission.md (git-ignored); answers 898 / 911 / 972 chars
  - Acceptance: text for "changes in deployed version" (≤ 1024 chars) and "Gen AI services used +
    where" (≤ 1024 chars), a 2–3 min demo-video script with a shot list, and a LinkedIn post draft.
  - Files: `tasks/submission.md` (not required in the repo; can be git-ignored)
  - Deps: T12

### Checkpoint E
- [ ] Deployed URL passes every SPEC acceptance criterion → human submits attempt 1
