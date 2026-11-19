// SmogShift browser client. Builds every dynamic node with textContent (no innerHTML) for XSS safety.

const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = Object.freeze(['en', 'hi', 'mr']);
const LANGUAGE_STORAGE_KEY = 'smogshift.language';
const DAY_TEXT_MAX = 500;
const PLAN_ERRORS = Object.freeze({ 400: 'errors.invalid', 404: 'errors.notFound', 429: 'errors.rateLimited', 502: 'errors.upstream' });
const SCHEDULE_ERRORS = Object.freeze({
  400: 'errors.dayRequired', 404: 'errors.notFound', 422: 'errors.dayUnreadable',
  429: 'errors.rateLimited', 502: 'errors.aiBusy', 503: 'errors.aiUnavailable',
});

const AUDIT_ERRORS = Object.freeze({
  400: 'errors.photoInvalid', 413: 'errors.photoTooBig', 429: 'errors.rateLimited', 502: 'errors.aiBusy', 503: 'errors.aiUnavailable',
});
const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_MAX_INPUT_BYTES = 25 * 1024 * 1024; // refuse to decode absurdly large files
const PHOTO_MAX_SIDE = 1024;
const PHOTO_MIN_SIDE = 32; // Groq vision rejects smaller images
const PHOTO_JPEG_QUALITY = 0.8;

const state = {
  dict: {},
  language: DEFAULT_LANGUAGE,
  photo: null,
  last: { plan: null, schedule: null, audit: null }, // re-rendered when the language changes
};
const $ = (selector) => document.querySelector(selector);

// --- i18n helpers -------------------------------------------------------------

const lookup = (path) => path.split('.').reduce((node, key) => node?.[key], state.dict);

/** Translates a dotted key and fills {placeholders}; returns the key itself if missing. */
function t(path, params = {}) {
  const text = lookup(path);
  if (typeof text !== 'string') return path;
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
}

const formatNumber = (n, digits = 1) =>
  new Intl.NumberFormat(state.language, { maximumFractionDigits: digits }).format(n);

async function loadDictionary(language) {
  const res = await fetch(`/i18n/${language}.json`);
  if (!res.ok) throw new Error(`Missing dictionary: ${language}`);
  return res.json();
}

function applyStaticText() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
}

// --- DOM helpers ----------------------------------------------------------------

function el(tag, { className, text, attrs = {} } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** Fills selects and checkbox groups from dictionary sections, keeping the user's current choices. */
function fillOptions() {
  for (const container of document.querySelectorAll('[data-options]')) {
    const section = state.dict[container.dataset.options] ?? {};
    if (container.tagName === 'SELECT') {
      const current = container.value;
      container.replaceChildren(...Object.entries(section).map(([value, label]) => el('option', { text: label, attrs: { value } })));
      if (current) container.value = current;
    } else {
      const checked = new Set([...container.querySelectorAll('input:checked')].map((input) => input.value));
      container.replaceChildren(...Object.entries(section).map(([value, label]) => {
        const input = el('input', { attrs: { type: 'checkbox', name: container.id, value, 'aria-describedby': `${container.id}-hint` } });
        input.checked = checked.has(value);
        return el('label', { className: 'check' }, [input, el('span', { text: label })]);
      }));
    }
  }
}

function showResults(region, heading, children, focus = true) {
  region.replaceChildren(heading, ...children);
  region.hidden = false;
  if (focus) heading.focus();
}

// --- errors + requests ------------------------------------------------------------

function showError(target, message, field) {
  $(target).textContent = message;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function clearError(target) {
  $(target).textContent = '';
  for (const node of document.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
}

/** POSTs JSON and returns the parsed body; failures become translated messages. */
async function postJson(url, body, errorKeys) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(t('errors.network'));
  }
  if (!res.ok) throw new Error(t(errorKeys[res.status] ?? 'errors.generic'));
  return res.json();
}

/** Disables the button and marks the region busy while `work` runs; restores both afterwards. */
async function whileBusy({ button, region, loadingKey, idleKey }, work) {
  button.disabled = true;
  button.textContent = t(loadingKey);
  region.setAttribute('aria-busy', 'true');
  try {
    await work();
  } finally {
    button.disabled = false;
    button.textContent = t(idleKey);
    region.setAttribute('aria-busy', 'false');
  }
}

// --- today's plan ---------------------------------------------------------------

/** Remote workers have no commute: disable the distance field (disabled inputs aren't submitted). */
function syncCommuteDistance() {
  $('#commuteKm').disabled = $('#commuteMode').value === 'remote';
}

function readProfile(form) {
  const data = new FormData(form);
  return {
    city: String(data.get('city') ?? '').trim(),
    groups: data.getAll('groups'),
    commuteMode: data.get('commuteMode'),
    commuteKm: Number(data.get('commuteKm') || 0),
    heating: data.get('heating'),
    hasPurifier: data.has('hasPurifier'),
    exercisesOutdoors: data.has('exercisesOutdoors'),
  };
}

/** Translates enum-valued params (commute mode, fuel, groups) and formats numbers. */
function displayParams(params) {
  const out = { ...params };
  if (params.mode) out.mode = t(`commuteModes.${params.mode}`);
  if (params.target) out.target = t(`commuteModes.${params.target}`);
  if (params.fuel) out.fuel = t(`heatingTypes.${params.fuel}`);
  if (params.groups) {
    out.groups = new Intl.ListFormat(state.language).format(params.groups.map((g) => t(`groups.${g}`)));
  }
  if (params.pm25 !== undefined) out.pm25 = formatNumber(params.pm25);
  if (params.km !== undefined) out.km = formatNumber(params.km);
  return out;
}

function impactLines({ cigarettesAvoided, co2KgPerWeek, street }) {
  const lines = [];
  if (cigarettesAvoided > 0) lines.push(t('impact.cigarettes', { n: formatNumber(cigarettesAvoided, 2) }));
  if (co2KgPerWeek > 0) lines.push(t('impact.co2', { n: formatNumber(co2KgPerWeek) }));
  if (street?.co2KgPerWeek) lines.push(t('impact.streetCo2', { neighbours: street.neighbours, n: formatNumber(street.co2KgPerWeek, 0) }));
  if (street?.households) lines.push(t('impact.streetHouseholds', { neighbours: street.neighbours, n: street.households }));
  return lines;
}

function renderAction({ id, area, impact, params }) {
  const shown = displayParams(params);
  const lines = impactLines(impact);
  return el('li', { className: 'action' }, [
    el('p', { className: `tag tag-${area}`, text: t(`area.${area}`) }),
    el('h4', { text: t(`actions.${id}.title`, shown) }),
    el('p', { text: t(`actions.${id}.detail`, shown) }),
    ...(lines.length ? [el('ul', { className: 'impact', attrs: { 'aria-label': t('results.impactLabel') } },
      lines.map((line) => el('li', { text: line })))] : []),
  ]);
}

function renderAirCard({ air, advice }) {
  const { aqi, pm25, time } = air.current;
  return el('div', { className: `aqi-card cat-${advice.category.id}` }, [
    el('p', { className: 'aqi-value' }, [
      el('span', { className: 'aqi-number', text: formatNumber(aqi, 0) }),
      el('span', { className: 'aqi-unit', text: t('results.aqiUnit') }),
    ]),
    el('p', { className: 'aqi-label', text: t(`category.${advice.category.id}`) }),
    el('p', { className: 'muted', text: t('results.pm25', { pm25: formatNumber(pm25), time: time.slice(11, 16) }) }),
  ]);
}

function renderSummary(plan) {
  const top = plan.advice.actions[0];
  const fallback = t('results.summaryFallback', {
    city: plan.location.name,
    category: t(`category.${plan.advice.category.id}`).toLowerCase(),
    aqi: formatNumber(plan.air.current.aqi, 0),
    pm25: formatNumber(plan.air.current.pm25),
    top: top ? t(`actions.${top.id}.title`, displayParams(top.params)) : '',
  });
  return el('section', { className: 'summary', attrs: { 'aria-labelledby': 'summary-heading' } }, [
    el('h3', { text: t('results.summaryHeading'), attrs: { id: 'summary-heading' } }),
    el('p', { text: plan.summary ?? fallback }),
    el('p', { className: 'muted small', text: t(plan.summary ? 'results.summaryAi' : 'results.summaryAuto') }),
  ]);
}

function renderPlan(plan, focus = true) {
  state.last.plan = plan;
  showResults($('#results'), el('h2', { text: t('results.heading', { city: plan.location.name }), attrs: { tabindex: '-1' } }), [
    renderAirCard(plan),
    renderSummary(plan),
    el('h3', { text: t('results.actionsHeading') }),
    el('ol', { className: 'actions' }, plan.advice.actions.map(renderAction)),
  ], focus);
}

async function onPlanSubmit(event) {
  event.preventDefault();
  clearError('#form-error');
  const profile = readProfile(event.currentTarget);
  if (profile.city.length < 2) return showError('#form-error', t('errors.cityRequired'), $('#city'));

  const ui = { button: $('#submit'), region: $('#results'), loadingKey: 'form.loading', idleKey: 'form.submit' };
  await whileBusy(ui, async () => {
    try {
      renderPlan(await postJson('/api/plan', { profile, language: state.language }, PLAN_ERRORS));
    } catch (err) {
      showError('#form-error', err.message);
    }
  });
}

// --- smog scheduler -------------------------------------------------------------

function stayReason(task) {
  if (task.past) return 'past';
  if (!task.outdoor) return 'indoor';
  if (!task.flexible) return 'fixed';
  return 'noBetter';
}

function renderTask(task) {
  const timing = task.moved
    ? t('schedule.moved', { from: task.start, to: task.newStart })
    : `${t('schedule.stays', { time: task.start })} (${t(`schedule.reason.${stayReason(task)}`)})`;
  const details = [];
  if (task.before !== null && task.after !== null) {
    details.push(t('schedule.cigs', { before: formatNumber(task.before, 2), after: formatNumber(task.after, 2) }));
  }
  if (task.mitigation === 'n95') details.push(t('schedule.n95'));
  return el('li', { className: `action ${task.moved ? 'is-moved' : ''}` }, [
    el('h4', { text: task.name }),
    el('p', { className: 'tag', text: timing }),
    ...details.map((line) => el('p', { text: line })),
  ]);
}

function renderSchedule(result, focus = true) {
  state.last.schedule = result;
  const { location, schedule } = result;
  const { before, after } = schedule.totals;
  showResults($('#schedule-results'), el('h2', { text: t('schedule.resultsHeading', { city: location.name }), attrs: { tabindex: '-1' } }), [
    el('p', { className: 'total', text: t('schedule.total', { before: formatNumber(before, 2), after: formatNumber(after, 2) }) }),
    el('ol', { className: 'actions' }, schedule.tasks.map(renderTask)),
  ], focus);
}

function updateCounter() {
  $('#day-counter').textContent = t('schedule.counter', { n: $('#day-text').value.length, max: DAY_TEXT_MAX });
}

async function onScheduleSubmit(event) {
  event.preventDefault();
  clearError('#schedule-error');
  const city = $('#city').value.trim();
  const text = $('#day-text').value.trim();
  if (city.length < 2) return showError('#schedule-error', t('errors.cityFirst'), $('#city'));
  if (text.length < 3) return showError('#schedule-error', t('errors.dayRequired'), $('#day-text'));

  const ui = { button: $('#schedule-submit'), region: $('#schedule-results'), loadingKey: 'schedule.loading', idleKey: 'schedule.submit' };
  await whileBusy(ui, async () => {
    try {
      renderSchedule(await postJson('/api/schedule', { city, text, language: state.language }, SCHEDULE_ERRORS));
    } catch (err) {
      showError('#schedule-error', err.message);
    }
  });
}

// --- photo audit ----------------------------------------------------------------

/**
 * Decodes, auto-rotates and shrinks the photo to ≤ 1024 px, then re-encodes it as JPEG.
 * Re-encoding through a canvas drops all EXIF metadata, including GPS location.
 */
async function downscalePhoto(file) {
  if (!PHOTO_TYPES.includes(file.type)) throw new Error(t('errors.photoInvalid'));
  if (file.size > PHOTO_MAX_INPUT_BYTES) throw new Error(t('errors.photoTooBig'));
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(t('errors.photoInvalid'));
  }
  try {
    if (bitmap.width < PHOTO_MIN_SIDE || bitmap.height < PHOTO_MIN_SIDE) throw new Error(t('errors.photoTooSmall'));
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

async function onPhotoChange(event) {
  clearError('#audit-error');
  const preview = $('#photo-preview');
  state.photo = null;
  preview.hidden = true;
  const [file] = event.currentTarget.files;
  if (!file) return;
  try {
    state.photo = await downscalePhoto(file);
    preview.src = state.photo;
    preview.alt = t('audit.previewAlt');
    preview.hidden = false;
  } catch (err) {
    showError('#audit-error', err.message, $('#photo'));
  }
}

function renderFinding({ source, severity, fix, why }) {
  return el('li', { className: `action sev-${severity}` }, [
    el('p', { className: 'tag', text: t(`audit.severity.${severity}`) }),
    el('h4', { text: source }),
    el('p', { text: fix }),
    el('p', { className: 'muted', text: t('audit.why', { why }) }),
  ]);
}

function renderFindings(result, focus = true) {
  state.last.audit = result;
  const body = result.findings.length
    ? [el('ol', { className: 'actions' }, result.findings.map(renderFinding))]
    : [el('p', { text: t('audit.none') })];
  showResults($('#audit-results'), el('h2', { text: t('audit.resultsHeading'), attrs: { tabindex: '-1' } }), body, focus);
}

async function onAuditSubmit(event) {
  event.preventDefault();
  clearError('#audit-error');
  if (!state.photo) return showError('#audit-error', t('errors.photoRequired'), $('#photo'));

  const ui = { button: $('#audit-submit'), region: $('#audit-results'), loadingKey: 'audit.loading', idleKey: 'audit.submit' };
  await whileBusy(ui, async () => {
    try {
      renderFindings(await postJson('/api/audit', { photo: state.photo, language: state.language }, AUDIT_ERRORS));
    } catch (err) {
      showError('#audit-error', err.message);
    }
  });
}

// --- language -------------------------------------------------------------------

function savedLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.includes(saved) ? saved : null;
  } catch {
    return null; // storage blocked (private mode etc.): fall back silently
  }
}

function preferredLanguage() {
  const browser = (navigator.languages ?? []).map((tag) => tag.slice(0, 2)).find((code) => SUPPORTED_LANGUAGES.includes(code));
  return savedLanguage() ?? browser ?? DEFAULT_LANGUAGE;
}

/** Re-renders results already on screen. AI-written text (summary, task names, findings) stays as written. */
function rerenderResults() {
  const { plan, schedule, audit } = state.last;
  if (plan) renderPlan(plan, false);
  if (schedule) renderSchedule(schedule, false);
  if (audit) renderFindings(audit, false);
  if (state.photo) $('#photo-preview').alt = t('audit.previewAlt');
}

async function setLanguage(language) {
  state.dict = await loadDictionary(language);
  state.language = language;
  document.documentElement.lang = language;
  $('#language').value = language;
  applyStaticText();
  fillOptions();
  updateCounter();
  rerenderResults();
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // not persisted; the choice still applies to this page view
  }
}

async function onLanguageChange(event) {
  try {
    await setLanguage(event.currentTarget.value);
  } catch {
    showError('#form-error', t('errors.generic'));
  }
}

// --- wiring ---------------------------------------------------------------------

async function init() {
  try {
    await setLanguage(preferredLanguage());
  } catch {
    try {
      await setLanguage(DEFAULT_LANGUAGE);
    } catch {
      return showError('#form-error', 'Could not load the app text. Please reload the page.');
    }
  }
  syncCommuteDistance();
  $('#language').addEventListener('change', onLanguageChange);
  $('#commuteMode').addEventListener('change', syncCommuteDistance);
  $('#plan-form').addEventListener('submit', onPlanSubmit);
  $('#schedule-form').addEventListener('submit', onScheduleSubmit);
  $('#day-text').addEventListener('input', updateCounter);
  $('#photo').addEventListener('change', onPhotoChange);
  $('#audit-form').addEventListener('submit', onAuditSubmit);
}

init();
