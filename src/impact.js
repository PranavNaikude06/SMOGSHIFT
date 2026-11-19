// Pure impact maths. Every number SmogShift shows as a fact comes from here, never from the LLM.

/** Berkeley Earth: breathing 22 µg/m³ of PM2.5 averaged over 24 h ≈ smoking 1 cigarette. */
export const CIGARETTE_PM25 = 22;

/**
 * Share of outdoor PM2.5 reaching you. Conservative mid-range of published infiltration and
 * portable-HEPA studies; see README "Assumptions".
 */
export const EXPOSURE = Object.freeze({
  outdoors: 1,
  indoorsWindowsOpen: 0.8,
  indoorsWindowsClosed: 0.5,
  indoorsWithPurifier: 0.2,
});

/** kg CO₂ per passenger-km (typical urban averages; DEFRA / ICCT ranges). */
export const COMMUTE_CO2_PER_KM = Object.freeze({
  car: 0.17,
  motorbike: 0.11,
  bus: 0.1,
  metro: 0.035,
  cycle: 0,
  walk: 0,
  remote: 0,
});

export const DEFAULT_NEIGHBOURS = 20;
const MAX_NEIGHBOURS = 1000;

const isNonNegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Cigarettes "smoked" by breathing a PM2.5 concentration for a number of hours.
 * @param {number} pm25 PM2.5 concentration in µg/m³
 * @param {number} hours time spent breathing it
 * @returns {number}
 */
export function cigaretteEquivalent(pm25, hours) {
  if (!isNonNegative(pm25) || !isNonNegative(hours)) {
    throw new RangeError('pm25 and hours must be finite numbers ≥ 0');
  }
  return (pm25 / CIGARETTE_PM25) * (hours / 24);
}

/**
 * Fraction of outdoor PM2.5 a person breathes in a given setting.
 * @param {{ indoors: boolean, windowsClosed?: boolean, hasPurifier?: boolean }} setting
 * @returns {number} between 0 and 1
 */
export function exposureFactor({ indoors, windowsClosed = false, hasPurifier = false }) {
  if (!indoors) return EXPOSURE.outdoors;
  if (hasPurifier) return EXPOSURE.indoorsWithPurifier;
  return windowsClosed ? EXPOSURE.indoorsWindowsClosed : EXPOSURE.indoorsWindowsOpen;
}

/**
 * kg CO₂ emitted travelling a distance by a commute mode.
 * @param {keyof typeof COMMUTE_CO2_PER_KM} mode
 * @param {number} km
 * @returns {number} kg CO₂, rounded to grams
 */
export function commuteCo2(mode, km) {
  if (!Object.hasOwn(COMMUTE_CO2_PER_KM, mode)) throw new RangeError(`Unknown commute mode: ${mode}`);
  if (!isNonNegative(km)) throw new RangeError('km must be a finite number ≥ 0');
  return round3(COMMUTE_CO2_PER_KM[mode] * km);
}

/**
 * Scales a household impact to "you + N neighbours" for the community view.
 * @param {number} value impact of one household
 * @param {number} [neighbours]
 * @returns {number}
 */
export function streetMultiplier(value, neighbours = DEFAULT_NEIGHBOURS) {
  if (!Number.isInteger(neighbours) || neighbours < 0 || neighbours > MAX_NEIGHBOURS) {
    throw new RangeError(`neighbours must be an integer 0–${MAX_NEIGHBOURS}`);
  }
  return round3(value * (neighbours + 1));
}
