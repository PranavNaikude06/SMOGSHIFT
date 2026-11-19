// Rules engine: live air data + household profile → ranked, quantified actions.
// Pure and deterministic. Action text lives in the UI dictionaries (public/i18n), keyed by action id.

import { cigaretteEquivalent, exposureFactor, commuteCo2, streetMultiplier, DEFAULT_NEIGHBOURS } from './impact.js';

/** US EPA AQI bands (upper bound inclusive). */
const BANDS = Object.freeze([
  { id: 'good', max: 50 },
  { id: 'moderate', max: 100 },
  { id: 'usg', max: 150 }, // unhealthy for sensitive groups
  { id: 'unhealthy', max: 200 },
  { id: 'very_unhealthy', max: 300 },
  { id: 'hazardous', max: Infinity },
]);

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 21;
const EXERCISE_HOURS = 1;
const OUTDOOR_HOURS = 2; // typical errands + waiting outside on a weekday
const HOURS_AT_HOME = 14;
const SLEEP_HOURS = 8;
const N95_REAL_WORLD = 0.8; // 95 % rated; ~80 % with typical (imperfect) fit
const WORKDAYS = 5;
const SWITCHABLE_COMMUTES = Object.freeze(['car', 'motorbike']);
const SOLID_FUELS = Object.freeze(['wood', 'coal', 'kerosene']);

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const clock = (isoTime) => isoTime.slice(11, 16);
const cigs = (pm25, hours, share = 1) => round2(cigaretteEquivalent(pm25, hours) * share);

const action = (id, area, priority, impact = {}, params = {}) =>
  Object.freeze({ id, area, priority, impact: Object.freeze(impact), params: Object.freeze(params) });

/**
 * @param {number} aqi US AQI
 * @returns {{ id: string, band: number }} band 0 (good) … 5 (hazardous)
 */
export function aqiCategory(aqi) {
  const band = BANDS.findIndex((b) => aqi <= b.max);
  return { id: BANDS[band].id, band };
}

/**
 * Lowest-PM2.5 hour from the current hour until 21:00 today (earliest wins ties).
 * @param {Array<{ time: string, aqi: number, pm25: number }>} hourly local ISO times
 * @param {string} now local ISO time of the current reading
 * @returns {{ time: string, aqi: number, pm25: number } | null}
 */
export function cleanestHour(hourly, now) {
  const currentHour = now.slice(0, 13);
  let best = null;
  for (const h of hourly) {
    const hour = Number(h.time.slice(11, 13));
    if (h.time.slice(0, 13) < currentHour || hour < DAY_START_HOUR || hour > DAY_END_HOUR) continue;
    if (!best || h.pm25 < best.pm25) best = h;
  }
  return best ? { time: best.time, aqi: best.aqi, pm25: best.pm25 } : null;
}

function routineActions({ band, sensitive, pm25, clean, profile }) {
  if (band === 0) return [];
  const actions = [];
  const goIndoors = profile.exercisesOutdoors && (band >= 3 || (sensitive && band >= 2));
  const indoorShare = 1 - exposureFactor({ indoors: true, windowsClosed: true, hasPurifier: profile.hasPurifier });

  if (goIndoors) {
    actions.push(action('exercise-indoors', 'routine', 100, { cigarettesAvoided: cigs(pm25, EXERCISE_HOURS, indoorShare) }));
  } else if (profile.exercisesOutdoors && clean) {
    actions.push(action('exercise-clean-hour', 'routine', 65,
      { cigarettesAvoided: cigs(pm25 - clean.pm25, EXERCISE_HOURS) }, { time: clock(clean.time), pm25: clean.pm25 }));
  }
  if (sensitive && band >= 2) actions.push(action('protect-sensitive', 'routine', 95, {}, { groups: profile.groups }));
  if (band >= 2 || sensitive) {
    actions.push(action('wear-n95', 'routine', 90, { cigarettesAvoided: cigs(pm25, OUTDOOR_HOURS, N95_REAL_WORLD) }));
  }
  actions.push(clean
    ? action('errands-clean-hour', 'routine', 60, { cigarettesAvoided: cigs(pm25 - clean.pm25, 1) },
      { time: clock(clean.time), pm25: clean.pm25 })
    : action('short-trips', 'routine', 60, { cigarettesAvoided: cigs(pm25, OUTDOOR_HOURS / 2) }));
  return actions;
}

function indoorActions({ band, pm25, profile }) {
  if (band === 0) return [action('ventilate-now', 'indoor', 40)];
  const closed = exposureFactor({ indoors: true, windowsClosed: true });
  const open = exposureFactor({ indoors: true, windowsClosed: false });
  const purified = exposureFactor({ indoors: true, hasPurifier: true });
  const purifierImpact = { cigarettesAvoided: cigs(pm25, SLEEP_HOURS, closed - purified) };
  return [
    action('close-windows', 'indoor', 80, { cigarettesAvoided: cigs(pm25, HOURS_AT_HOME, open - closed) }),
    action(profile.hasPurifier ? 'run-purifier' : 'diy-purifier', 'indoor', 75, purifierImpact),
    action('avoid-indoor-smoke', 'indoor', 50),
  ];
}

function alternativeActions({ band, profile }) {
  const actions = [];
  const { commuteMode, commuteKm, heating } = profile;

  if (SWITCHABLE_COMMUTES.includes(commuteMode) && commuteKm > 0) {
    const roundTripKm = commuteKm * 2;
    const co2KgPerWeek = round1((commuteCo2(commuteMode, roundTripKm) - commuteCo2('metro', roundTripKm)) * WORKDAYS);
    actions.push(action('switch-commute', 'alternative', 70, {
      co2KgPerWeek,
      street: { neighbours: DEFAULT_NEIGHBOURS, co2KgPerWeek: streetMultiplier(co2KgPerWeek) },
    }, { mode: commuteMode, km: commuteKm, target: 'metro' }));
  }
  // No sourced per-household PM2.5 figure for fuel swaps or open burning, so impact is counted in households.
  const households = { neighbours: DEFAULT_NEIGHBOURS, households: streetMultiplier(1) };
  if (SOLID_FUELS.includes(heating)) {
    actions.push(action('switch-heating', 'alternative', 72, { street: households }, { fuel: heating }));
  }
  if (band >= 1) actions.push(action('no-burning', 'alternative', 45, { street: households }));
  return actions;
}

const byPriority = (a, b) => b.priority - a.priority || a.id.localeCompare(b.id);

/**
 * Ranked plan for today.
 * @param {{ air: { current: { time: string, aqi: number, pm25: number }, hourly: Array<object> }, profile: object }} input
 * @returns {{ category: { id: string, band: number }, sensitive: boolean, cleanestHour: object | null, actions: object[] }}
 */
export function buildAdvice({ air, profile }) {
  const category = aqiCategory(air.current.aqi);
  const pm25 = air.current.pm25;
  const candidate = cleanestHour(air.hourly, air.current.time);
  const clean = candidate && candidate.pm25 < pm25 ? candidate : null;
  const ctx = { band: category.band, sensitive: profile.groups.length > 0, pm25, clean, profile };

  const actions = [...routineActions(ctx), ...indoorActions(ctx), ...alternativeActions(ctx)].sort(byPriority);
  return Object.freeze({ category, sensitive: ctx.sensitive, cleanestHour: clean, actions: Object.freeze(actions) });
}
