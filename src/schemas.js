// Validators for everything crossing a trust boundary: browser input and LLM output.
// Each returns { ok: true, value } or { ok: false, errors } and never throws on bad input.

export const GROUPS = Object.freeze(['children', 'elderly', 'respiratory', 'heart', 'pregnant']);
export const COMMUTE_MODES = Object.freeze(['car', 'motorbike', 'bus', 'metro', 'cycle', 'walk', 'remote']);
export const HEATING_TYPES = Object.freeze(['none', 'wood', 'coal', 'kerosene', 'gas', 'electric', 'heatpump']);
export const LANGUAGES = Object.freeze(['en', 'hi', 'mr']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);

export const MAX_COMMUTE_KM = 200;
export const MAX_TASKS = 12;
export const MAX_FINDINGS = 6;
export const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;

const CITY_PATTERN = /^[\p{L}\p{M} .,'-]{2,80}$/u;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHOTO_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const TASK_NAME_MAX = 60;
const FINDING_TEXT_MAX = 200;
const SUMMARY_MAX = 1200; // ~120 words in Devanagari plus headroom
const DAY_TEXT_MIN = 3;
const DAY_TEXT_MAX = 500;
const DURATION_MIN = 5;
const DURATION_MAX = 480;

const ok = (value) => ({ ok: true, value });
const fail = (...errors) => ({ ok: false, errors });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: string } | { ok: false, errors: string[] }}
 */
export function validateCity(input) {
  const city = typeof input === 'string' ? input.trim() : '';
  return CITY_PATTERN.test(city)
    ? ok(city)
    : fail('City must be 2–80 letters (spaces, commas, dots, hyphens and apostrophes allowed).');
}

/**
 * Free-text description of the user's day for the Smog Scheduler. It's passed to the LLM as
 * data, so it's only length-checked here; the LLM's output is what gets strictly validated.
 * @param {unknown} input
 * @returns {{ ok: true, value: string } | { ok: false, errors: string[] }}
 */
export function validateDayText(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  return text.length >= DAY_TEXT_MIN && text.length <= DAY_TEXT_MAX
    ? ok(text)
    : fail(`Describe your day in ${DAY_TEXT_MIN}–${DAY_TEXT_MAX} characters.`);
}

/**
 * Household profile from the browser.
 * @param {unknown} input
 * @returns {{ ok: true, value: Readonly<object> } | { ok: false, errors: string[] }}
 */
export function validateProfile(input) {
  if (!isObject(input)) return fail('Request body must be a JSON object.');

  const cityResult = validateCity(input.city);
  const errors = cityResult.ok ? [] : [...cityResult.errors];
  const city = cityResult.value;

  const groups = input.groups ?? [];
  if (!Array.isArray(groups) || !groups.every((g) => GROUPS.includes(g))) {
    errors.push(`Groups must be a list containing only: ${GROUPS.join(', ')}.`);
  }
  if (!COMMUTE_MODES.includes(input.commuteMode)) {
    errors.push(`Commute mode must be one of: ${COMMUTE_MODES.join(', ')}.`);
  }

  const commuteKm = Number(input.commuteKm ?? 0);
  if (!Number.isFinite(commuteKm) || commuteKm < 0 || commuteKm > MAX_COMMUTE_KM) {
    errors.push(`Commute distance must be between 0 and ${MAX_COMMUTE_KM} km.`);
  }
  if (!HEATING_TYPES.includes(input.heating)) {
    errors.push(`Heating must be one of: ${HEATING_TYPES.join(', ')}.`);
  }
  for (const flag of ['hasPurifier', 'exercisesOutdoors']) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') errors.push(`${flag} must be true or false.`);
  }
  if (errors.length > 0) return fail(...errors);

  return ok(Object.freeze({
    city,
    groups: Object.freeze([...new Set(groups)]),
    commuteMode: input.commuteMode,
    commuteKm: input.commuteMode === 'remote' ? 0 : commuteKm,
    heating: input.heating,
    hasPurifier: input.hasPurifier === true,
    exercisesOutdoors: input.exercisesOutdoors === true,
  }));
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: 'en' | 'hi' | 'mr' } | { ok: false, errors: string[] }}
 */
export function validateLanguage(input) {
  return LANGUAGES.includes(input) ? ok(input) : fail(`Language must be one of: ${LANGUAGES.join(', ')}.`);
}

function taskErrors(task, index) {
  const where = `Task ${index + 1}`;
  if (!isObject(task)) return [`${where} must be an object.`];
  const errors = [];
  if (!isText(task.name, TASK_NAME_MAX)) errors.push(`${where}: name must be 1–${TASK_NAME_MAX} characters.`);
  if (!TIME_PATTERN.test(task.start)) errors.push(`${where}: start must be HH:MM (24 h).`);
  const d = task.durationMin;
  if (!Number.isInteger(d) || d < DURATION_MIN || d > DURATION_MAX) {
    errors.push(`${where}: duration must be ${DURATION_MIN}–${DURATION_MAX} whole minutes.`);
  }
  if (typeof task.outdoor !== 'boolean' || typeof task.flexible !== 'boolean') {
    errors.push(`${where}: outdoor and flexible must be true or false.`);
  }
  return errors;
}

/**
 * Tasks extracted by the LLM from the user's day. Strict: one bad task rejects the whole list,
 * so we never silently change someone's day.
 * @param {unknown} input expected shape { tasks: [...] }
 */
export function validateTasks(input) {
  if (!isObject(input) || !Array.isArray(input.tasks)) return fail('Expected an object with a "tasks" list.');
  const { tasks } = input;
  if (tasks.length === 0) return fail('No tasks found in your day.');
  if (tasks.length > MAX_TASKS) return fail(`At most ${MAX_TASKS} tasks are supported.`);

  const errors = tasks.flatMap(taskErrors);
  if (errors.length > 0) return fail(...errors);

  return ok(Object.freeze(tasks.map(({ name, start, durationMin, outdoor, flexible }) =>
    Object.freeze({ name: name.trim(), start, durationMin, outdoor, flexible }))));
}

const isValidFinding = (f) =>
  isObject(f) &&
  SEVERITIES.includes(f.severity) &&
  ['source', 'fix', 'why'].every((key) => isText(f[key], FINDING_TEXT_MAX));

/**
 * Photo-audit findings from the vision model. Lenient: invalid items are dropped, the rest kept.
 * @param {unknown} input expected shape { findings: [...] }
 */
export function validateFindings(input) {
  if (!isObject(input) || !Array.isArray(input.findings)) return fail('Expected an object with a "findings" list.');
  return ok(Object.freeze(input.findings
    .filter(isValidFinding)
    .slice(0, MAX_FINDINGS)
    .map(({ source, severity, fix, why }) =>
      Object.freeze({ source: source.trim(), severity, fix: fix.trim(), why: why.trim() }))));
}

/**
 * Plain-text summary written by the LLM.
 * @param {unknown} input expected shape { summary: string }
 * @returns {{ ok: true, value: string } | { ok: false, errors: string[] }}
 */
export function validateSummary(input) {
  return isObject(input) && isText(input.summary, SUMMARY_MAX)
    ? ok(input.summary.trim())
    : fail('Expected an object with a "summary" string.');
}

/**
 * Base64 image data URL produced by the browser's canvas downscale.
 * @param {unknown} input
 * @returns {{ ok: true, value: string } | { ok: false, errors: string[] }}
 */
export function validatePhoto(input) {
  const match = typeof input === 'string' ? PHOTO_PATTERN.exec(input) : null;
  if (!match || match[1].length % 4 !== 0) return fail('Photo must be a JPEG, PNG or WebP image.');
  const base64 = match[1];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  if (bytes > MAX_PHOTO_BYTES) return fail('Photo is too large (max 1.5 MB after resizing).');
  return ok(input);
}
