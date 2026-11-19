// SmogShift HTTP server: static UI + JSON API. Zero runtime dependencies.

import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { AppError, ValidationError } from './src/errors.js';
import { send, sendJson, sendStatic, readJsonBody, clientIp, loadStaticFiles, prepareStaticFiles } from './src/http.js';
import {
  validateProfile, validateLanguage, validateSummary, validateCity, validateDayText, validateTasks,
  validatePhoto, validateFindings, MAX_PHOTO_BYTES,
} from './src/schemas.js';
import { buildAdvice } from './src/advice.js';
import { reschedule } from './src/scheduler.js';
import { summaryPrompt, tasksPrompt, auditPrompt } from './src/prompts.js';
import { createAirDataClient } from './src/airData.js';
import { createRateLimiter } from './src/rateLimit.js';
import { chatJson, LlmError } from './src/llm.js';

const MAX_BODY_BYTES = 8 * 1024;
// base64 grows data by 4/3; plus a few KB for the JSON wrapper and language field
const MAX_AUDIT_BODY_BYTES = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT = Object.freeze({ limit: 20, windowMs: 60_000 });
const AI_RETRY_AFTER_SEC = 20; // Groq free-tier limits reset within a minute

/** One-line error log to stderr. Never logs request bodies, photos or keys. */
function logError(context, err) {
  const cause = err?.cause ? ` (cause: ${err.cause.message ?? err.cause})` : '';
  process.stderr.write(`${new Date().toISOString()} ${context}: ${err?.name ?? 'Error'}: ${err?.message ?? err}${cause}\n`);
}

function validated(...results) {
  const errors = results.flatMap((r) => (r.ok ? [] : r.errors));
  if (errors.length > 0) throw new ValidationError(errors);
  return results.map((r) => r.value);
}

async function aiSummary(chat, facts, language) {
  try {
    const result = validateSummary(await chat({ ...summaryPrompt(facts), language }));
    return result.ok ? result.value : null;
  } catch (err) {
    logError('summary', err);
    return null;
  }
}

async function handlePlan(req, { getAirData, chat }) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const [profile, language] = validated(validateProfile(body?.profile), validateLanguage(body?.language));

  const air = await getAirData(profile.city, language);
  const advice = buildAdvice({ air, profile });
  const summary = await aiSummary(chat, { location: air.location, air, advice, profile }, language);

  return {
    location: air.location,
    air: { current: air.current, hourly: air.hourly },
    advice,
    summary,
    summarySource: summary ? 'ai' : 'none',
  };
}

/** Maps AI failures to user-safe HTTP errors for features that can't work without the model. */
function aiUnavailable(err) {
  logError('ai', err);
  if (err instanceof LlmError && err.code === 'no_key') {
    return new AppError('AI features are not available on this server right now.', 503);
  }
  if (err instanceof LlmError && err.status === 429) {
    return Object.assign(new AppError('The AI is busy right now. Please wait a moment and try again.', 429),
      { retryAfterSec: AI_RETRY_AFTER_SEC });
  }
  return new AppError('The AI service is busy. Please try again in a moment.', 502);
}

async function extractTasks(chat, text, language) {
  let raw;
  try {
    raw = await chat({ ...tasksPrompt(text), language });
  } catch (err) {
    throw aiUnavailable(err);
  }
  const tasks = validateTasks(raw);
  if (!tasks.ok) {
    throw new AppError('We couldn\'t read times and activities from that. Try e.g. "9am market 1 hr, 6pm walk".', 422);
  }
  return tasks.value;
}

async function handleSchedule(req, { getAirData, chat }) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const [city, text, language] = validated(
    validateCity(body?.city), validateDayText(body?.text), validateLanguage(body?.language),
  );
  const [air, tasks] = await Promise.all([getAirData(city, language), extractTasks(chat, text, language)]);
  return { location: air.location, schedule: reschedule(tasks, air.hourly, { now: air.current.time }) };
}

/** The photo exists only for the duration of this request: it is never stored or logged. */
async function handleAudit(req, { chat }) {
  const body = await readJsonBody(req, MAX_AUDIT_BODY_BYTES);
  const [photo, language] = validated(validatePhoto(body?.photo), validateLanguage(body?.language));
  let raw;
  try {
    raw = await chat({ ...auditPrompt(), image: photo, language });
  } catch (err) {
    throw aiUnavailable(err);
  }
  const findings = validateFindings(raw);
  if (!findings.ok) throw new AppError('The AI returned an answer we could not read. Please try again.', 502);
  return { findings: findings.value };
}

const API_ROUTES = Object.freeze({ '/api/plan': handlePlan, '/api/schedule': handleSchedule, '/api/audit': handleAudit });

async function route(req, res, deps) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });

  if (pathname.startsWith('/api/')) {
    const handler = API_ROUTES[pathname];
    if (!handler) return sendJson(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
    const limit = deps.rateLimiter.check(clientIp(req));
    if (!limit.allowed) {
      return sendJson(res, 429, { error: 'Too many requests. Please wait a minute.' }, { 'Retry-After': String(limit.retryAfterSec) });
    }
    return sendJson(res, 200, await handler(req, deps));
  }

  const file = (req.method === 'GET' || req.method === 'HEAD') && deps.staticFiles.get(pathname);
  if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  return sendStatic(req, res, file);
}

function handleError(res, err) {
  if (res.headersSent) return res.destroy();
  if (err instanceof AppError) {
    if (err.status >= 500) logError('request', err); // our side or upstream: worth a log line
    const headers = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {};
    return sendJson(res, err.status, { error: err.message, details: err.errors }, headers);
  }
  logError('request', err);
  return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
}

/**
 * Builds the HTTP server. All I/O is injected so tests run offline.
 * @param {{
 *   getAirData: (city: string, language: string) => Promise<object>,
 *   chat: (prompt: object) => Promise<object>,
 *   rateLimiter: { check: (key: string) => { allowed: boolean, retryAfterSec?: number } },
 *   staticFiles: Map<string, { type: string, body: Buffer }>,
 * }} deps
 * @returns {import('node:http').Server}
 */
export function createApp(deps) {
  const ready = { ...deps, staticFiles: prepareStaticFiles(deps.staticFiles) };
  const server = http.createServer((req, res) => route(req, res, ready).catch((err) => handleError(res, err)));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

async function start() {
  const root = dirname(fileURLToPath(import.meta.url));
  const { GROQ_API_KEY: apiKey, GROQ_MODEL: model, PORT } = process.env;
  if (!apiKey) process.stderr.write('GROQ_API_KEY is not set: AI features will use fallbacks.\n');

  const app = createApp({
    getAirData: createAirDataClient().getAirData,
    chat: (prompt) => chatJson(prompt, { apiKey, model: model || undefined }),
    rateLimiter: createRateLimiter(RATE_LIMIT),
    staticFiles: await loadStaticFiles(join(root, 'public')),
  });
  const port = Number(PORT) || 3000;
  app.listen(port, () => process.stdout.write(`SmogShift listening on http://localhost:${port}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    logError('startup', err);
    process.exit(1);
  });
}
