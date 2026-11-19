# Spec: SmogShift — Urban Air Quality Assistant

> PromptWars Virtual · Challenge 6 · Vertical: **Urban Air Quality Assistant**
> Status: APPROVED 2026-11-20 (one Groq model, street multiplier in, no Playwright)

## Objective

**Problem (verbatim from the challenge):** Create a GenAI-powered assistant that helps families and
communities navigate severe winter smog and urban air pollution. The application should suggest
low-emission daily routines, indoor air quality hacks, and sustainable alternatives tailored to their
location and lifestyle, while clearly explaining the direct impact of their choices.

**What we build:** A web app that turns live air-quality data into decisions a family can act on today,
and expresses the impact of every choice in **cigarettes inhaled** (exposure) and **kg CO₂** (emissions).

**Users:** Families in smog-affected cities (e.g. Delhi, Mumbai, Pune, Lahore), including people who
read Hindi or Marathi better than English, elderly members, and parents of young children.

**Why it is different:** Most assistants show an AQI number plus generic tips. SmogShift:
1. **Reschedules your actual day** into the cleanest forecast hours (decision-making on user context).
2. **Audits a photo of your room** for indoor pollution sources (GenAI vision).
3. **Explains impact in cigarettes**, which people understand, instead of µg/m³.

### Capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `air-data` | Geocode city, fetch current + hourly PM2.5 / US AQI (Open-Meteo), cache | — |
| `impact` | Pure functions: cigarette-equivalent, indoor/outdoor exposure, commute & heating CO₂ | — |
| `advice` | Rules engine: profile + air data → ranked routines, indoor hacks, sustainable swaps, each with impact | `air-data`, `impact` |
| `scheduler` | Free-text day → tasks (Groq) → reshuffle flexible outdoor tasks into clean hours (code) | `air-data`, `impact`, `llm` |
| `photo-audit` | Room photo → pollution sources + fixes (Groq vision) | `llm` |
| `llm` | One Groq client: JSON-mode calls, timeouts, schema validation of output, fallback | — |
| `web` | HTTP server, static UI, i18n (en / hi / mr), security headers, rate limit | all |

Build order: `impact`, `llm`, `air-data` → `advice` → `scheduler`, `photo-audit` → `web`

### User stories & acceptance criteria

**US-1 Today's air & advice.** As a parent, I enter my city and household profile and get a ranked plan.
- [ ] City + profile (groups: children / elderly / respiratory / heart / pregnant; commute mode + km;
      heating fuel; owns purifier; exercises outdoors) → response in < 3 s (warm server).
- [ ] Shows current US AQI with a **text** category label (not colour only) and PM2.5 µg/m³.
- [ ] Returns ≥ 3 actions across the three required categories: *low-emission routine*,
      *indoor air hack*, *sustainable alternative*. Each action has a one-line **impact** stating
      cigarettes avoided and/or kg CO₂ saved. Exception: fuel-switch and no-burning actions have no
      sourced per-household figure, so their impact is the household count ("you + 20 neighbours =
      21 fewer smoke sources"). We do not invent numbers.
- [ ] Hour-level advice shows **PM2.5** for that hour, not AQI. US AQI is a rolling average and
      lags behind hourly PM2.5, so showing AQI would make a cleaner hour look almost as bad.
- [ ] Advice changes with context: e.g. AQI 180 + asthma → "move exercise indoors" ranks first;
      AQI 40 → no mask advice.
- [ ] **Street multiplier** (communities): for polluting habits (wood/coal/kerosene heating, leaf or
      waste burning, car commute) show the household impact × N neighbours (default 20), e.g.
      "If you + 20 neighbours switch to the metro: 71 kg CO₂ saved per week."
- [ ] Groq writes a short (≤ 120 words) friendly summary in the selected language, using only the
      facts the code supplies. If Groq fails, a template summary is shown (app never breaks).

**US-2 Smog Scheduler.** As a commuter, I type my day in plain words and get a smog-smart version.
- [ ] Input: free text ≤ 500 chars, e.g. "9am school drop 20 min, 11am market 1 hr, 6pm walk 45 min".
- [ ] Groq extracts tasks as JSON `{ name, start "HH:MM", durationMin, outdoor, flexible }`;
      the server validates it against a schema and rejects anything else.
- [ ] Code (not the LLM) moves each **flexible outdoor** task to the lowest-PM2.5 window between
      06:00–21:00 today, with no overlaps; fixed tasks stay and get a mitigation tip (N95, route).
- [ ] Shows before → after for each task and a day total: "4.1 → 1.6 cigarettes".
- [ ] Deterministic: same tasks + same forecast → same schedule.

**US-3 Photo Audit.** As a family member, I photograph my kitchen or bedroom and learn what pollutes it.
- [ ] Accepts JPEG/PNG/WebP; the browser downscales it to ≤ 1024 px and re-encodes it (strips EXIF/GPS)
      before upload; the server rejects > 1.5 MB or non-image MIME types.
- [ ] Groq vision returns JSON `{ findings: [{ source, severity: low|medium|high, fix, why }] }`,
      validated server-side; max 6 findings.
- [ ] Photos are never stored or logged; they exist only for the duration of the request.
- [ ] If nothing is found → "No obvious sources spotted" plus general indoor tips.

**US-4 Languages & accessibility.**
- [ ] UI language switch: English / हिन्दी / मराठी; Groq answers in the chosen language.
- [ ] Every input has a visible label; full keyboard use; visible focus; results in an
      `aria-live="polite"` region; errors in `role="alert"`; contrast ≥ 4.5:1;
      respects `prefers-reduced-motion`; works at 320 px width.

## Tech Stack

- **Runtime:** Node.js ≥ 20 (local: v25), ES modules. **Zero runtime dependencies**: `node:http`,
  global `fetch`, `AbortSignal.timeout`, `node:test`.
- **AI:** Groq API (OpenAI-compatible `POST https://api.groq.com/openai/v1/chat/completions`),
  model from env `GROQ_MODEL`, default `qwen/qwen3.8-27b` (text + vision, multilingual; verify at build).
- **Data:** Open-Meteo Geocoding + Air Quality APIs (free, no key).
- **Frontend:** Plain HTML + CSS + vanilla JS modules (no build step), served by the same server.
- **Deploy:** Render free web service from the GitHub repo (`npm start`).

## Commands

```
Install:   npm install            # dev-only tooling, no runtime deps
Dev:       npm run dev            # node --watch --env-file-if-exists=.env server.js
Start:     npm start              # node server.js  (Render uses this)
Test:      npm test               # node --test
Coverage:  npm run coverage       # node --test --experimental-test-coverage
```

Environment (`.env.example` committed, `.env` git-ignored):
```
GROQ_API_KEY=        # required for AI features; app degrades gracefully without it
GROQ_MODEL=qwen/qwen3.8-27b
PORT=3000
```

## Project Structure

```
smogshift/
  server.js              → HTTP entry: routing, static files, headers, rate limit
  src/
    airData.js           → Open-Meteo geocode + air quality, TTL cache
    impact.js            → cigarette-equivalent, exposure, CO₂ maths (pure)
    advice.js            → rules engine → ranked actions (pure)
    scheduler.js         → reschedule tasks into clean hours (pure)
    llm.js               → Groq client: JSON mode, timeout, fallback
    schemas.js           → validators for profile, tasks, findings, photo
    i18n/en.json hi.json mr.json → UI strings
  public/
    index.html  app.js  styles.css
  test/
    *.test.js            → one file per src module + server.test.js
  README.md  SPEC.md  .env.example  .gitignore  package.json
```

## Code Style

```js
/**
 * Cigarettes "smoked" by breathing a PM2.5 concentration for some hours.
 * Basis: Berkeley Earth — 22 µg/m³ averaged over 24 h ≈ 1 cigarette.
 * @param {number} pm25 µg/m³
 * @param {number} hours
 * @returns {number}
 */
export function cigaretteEquivalent(pm25, hours) {
  if (!(pm25 >= 0) || !(hours >= 0)) throw new RangeError('pm25 and hours must be ≥ 0');
  return (pm25 / CIGARETTE_PM25) * (hours / 24);
}
```

- Small pure functions; I/O only in `airData.js`, `llm.js`, `server.js`.
- JSDoc on every export. Named constants for every factor, with a source comment.
- No mutation of inputs; return new objects (`Object.freeze` on module constants).
- Errors: typed (`ValidationError` 400, `NotFoundError` 404, `UpstreamError` 502); the client gets a
  safe message, never a stack trace.
- No `console.log`; one `logError()` helper writing a single line to stderr, never logging photos,
  keys or full user text.
- Files ≤ 300 lines; functions ≤ 50 lines.

## Testing Strategy

- **Framework:** `node:test` + `node:assert/strict` (built in, no deps). Tests in `test/`.
- **Unit (most tests):** `impact`, `advice`, `scheduler`, `schemas`: edge cases (AQI bands at
  boundaries, zero km, overlapping tasks, no clean window, invalid LLM JSON).
- **Integration:** `server.test.js` starts the server on port 0 with **fake `fetch`** (no network,
  no Groq credits used): 200 happy paths, 400 validation, 404, 413 oversize body, 429 rate limit,
  502 upstream failure, security headers present.
- **LLM contract:** `llm.test.js` covers good JSON, malformed JSON, timeouts and missing key, each
  falling back correctly.
- **Coverage target:** ≥ 80 % lines on `src/` (`npm run coverage`).
- **Manual check:** keyboard-only walkthrough + Lighthouse accessibility ≥ 95 on the deployed URL.

## Boundaries

- **Always:** validate every input at the server boundary (body, LLM output, image); keep the Groq
  key server-side only; set CSP / nosniff / referrer / frame headers; render all dynamic text with
  `textContent`; run `npm test` before every commit; keep the repo < 10 MB on one `main` branch;
  update SPEC.md when scope changes.
- **Ask first:** adding any dependency (incl. dev deps like ESLint/Playwright); changing the AI
  provider or model; adding storage, accounts or analytics; pushing to GitHub; deploying.
- **Never:** commit `.env` or keys; store or log photos; let the LLM produce numbers shown as facts
  (all numbers come from code); use `innerHTML` with dynamic data; make medical diagnoses (advice
  says "consult a doctor" for symptoms).

## Assumptions (stated in the README too)

- Cigarette-equivalent uses Berkeley Earth's 22 µg/m³-for-24 h ≈ 1 cigarette rule; it's an
  awareness metric, not a medical dose.
- Indoor PM2.5 ≈ 0.8 × outdoor with windows open; ≈ 0.5 × outdoor with windows closed; ≈ 0.2 × outdoor with a running HEPA purifier
  sized to the room (conservative mid-range of published studies).
- CO₂ per passenger-km: car 0.17, motorbike 0.11, bus 0.10, metro 0.035, cycle/walk 0 kg.
- Forecast = Open-Meteo hourly model data (CAMS), not ground-station readings.
- Render's free tier sleeps when idle; the first request after a sleep may take ~30 s.

## Success Criteria

1. All acceptance-criteria checkboxes above pass on the deployed Render URL.
2. `npm test` is green with ≥ 80 % `src/` line coverage.
3. With `GROQ_API_KEY` unset, US-1 still works (template summary) and US-2/3 show a clear
   "AI unavailable" message, with no crash or 500 errors.
4. Repo is public, one branch, < 10 MB, with a README covering vertical, approach, how it works and
   assumptions.
5. Lighthouse on the deployed URL: Accessibility ≥ 95, Best Practices ≥ 95, Performance ≥ 90.

## Decisions (resolved 2026-11-20)

1. Name **SmogShift**, folder `smogshift/`.
2. **One Groq model** for text + vision (`GROQ_MODEL`, default `qwen/qwen3.8-27b`); Marathi output
   quality is checked manually during the build.
3. **Street multiplier: in** (see US-1).
4. **No Playwright / E2E dependency**; integration tests through `server.test.js` instead.
