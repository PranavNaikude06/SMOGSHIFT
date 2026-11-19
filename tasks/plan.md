# Implementation Plan: SmogShift

Source of truth: [`../SPEC.md`](../SPEC.md). Task checklist: [`todo.md`](todo.md).

## Overview

Zero-dependency Node web app. Pure, tested modules (`impact`, `advice`, `scheduler`, `schemas`) do
all decisions and numbers; thin I/O modules (`airData`, `llm`) talk to Open-Meteo and Groq; one
`server.js` serves a vanilla-JS accessible UI. Built bottom-up, then in vertical slices per user
story so each slice works end-to-end before the next starts.

## Architecture Decisions

- **Numbers from code, words from the LLM.** Groq only (a) parses free text into tasks, (b) reads
  photos, (c) phrases summaries. Its output is schema-validated; nothing it returns is shown as a
  computed fact. This makes the result testable and safe against prompt injection.
- **Dependency injection of `fetch`.** `airData` and `llm` take `fetchImpl` so every test runs
  offline and burns no Groq credits.
- **No runtime deps.** `node:http` + static whitelist (no path traversal possible), in-memory TTL
  cache (10 min per city), in-memory fixed-window rate limiter. Fewer packages means a smaller
  attack surface and no `npm audit` noise.
- **Client-side image downscale.** Canvas → JPEG ≤ 1024 px: smaller uploads (efficiency), EXIF/GPS
  stripped (privacy), stays under Groq's base64 limit.
- **i18n as JSON dictionaries** loaded by the client; the chosen language is passed to Groq.

## Dependency Graph

```
impact ─┬──────────────► advice ─┐
        │                         ├─► server.js + public/ (web)
airData ┼──────────────► scheduler┤
        │                         │
schemas ┼─► llm ─────────► audit ─┘
```

## Task List

### Phase 1: Foundation
- [x] T1 Scaffold + `impact.js`
- [x] T2 `schemas.js` (absorbs `validate.js`)
- [x] T3 `llm.js` Groq client (**riskiest: verify model + JSON mode first**)
- [x] T4 `airData.js` Open-Meteo client + cache
### Checkpoint A: `npm test` green; a live Groq call returns valid JSON in English and Marathi

### Phase 2: Vertical slices
- [x] T5 US-1 logic: `advice.js` incl. street multiplier
- [x] T6a US-1 backend: `server.js` + `/api/plan`
- [x] T6b US-1 UI: form, AQI card, action cards, summary
### Checkpoint B: US-1 works in the browser locally, with and without `GROQ_API_KEY`
- [x] T7a US-2 scheduler logic + `/api/schedule`
- [x] T7b US-2 Smog Scheduler UI
- [x] T8 US-3 Photo Audit end-to-end
### Checkpoint C: all three features work locally; review with human

### Phase 3: Polish and ship
- [x] T9 i18n en / hi / mr
- [x] T10 Accessibility + performance pass
- [x] T11 README + coverage ≥ 80 %
### Checkpoint D: spec success criteria 2–4 met locally
- [ ] T12 GitHub + Render deploy (**ask first**)
- [x] T13 Submission pack: form answers, demo-video script, LinkedIn post
### Checkpoint E: deployed URL passes all acceptance criteria; human submits attempt 1

## Submission Strategy (3 attempts max, deadline 29 Nov 2026 23:59 IST)

1. Attempt 1 after Checkpoint E, to read the AI judge's per-criterion feedback.
2. Fix the weakest *high-impact* criteria (Code Quality, Problem Alignment) first, then medium.
3. Attempt 2 is the polished one; keep attempt 3 as a buffer for a regression or a late fix.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Groq model ID wrong / JSON mode unsupported with images | High | T3 first; model is env-configurable; fall back to text-only JSON parse with schema check |
| Groq free-tier rate limits during judging | Med | Rules-only fallback for US-1; clear "AI busy" message for US-2/3; cache nothing personal |
| Open-Meteo slow or down | Med | 8 s timeout, 10 min cache, 502 with a friendly message |
| Render cold start (~30 s) when the judge opens the link | Med | README notes it; demo video shows warm app; `/healthz` for a quick wake-up |
| Weak Marathi/Hindi output | Low | Manual check at Checkpoint A; UI strings hand-written, only the summary is generated |
| Repo > 10 MB or extra branches | High | No binaries/screenshots in repo; single `main` branch; check size before push |

## Open Questions

- Do you have the Groq API key yet? (Needed at Checkpoint A, put in `.env`, never committed.)
- GitHub: no `gh` CLI here, so you'll create an empty public repo `smogshift` in the browser and
  give me the URL at T12.
