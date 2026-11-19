// Live air quality from Open-Meteo (free, no key): geocode the city, then current + hourly PM2.5/AQI.

import { NotFoundError, UpstreamError } from './errors.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // upstream model updates hourly; 10 min keeps data fresh
const DEFAULT_MAX_ENTRIES = 500;

const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

async function fetchJson(fetchImpl, url) {
  let response;
  const host = new URL(url).host;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new UpstreamError('The air-quality service is unreachable right now. Please try again.',
      { cause: new Error(`${host}: ${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim()) });
  }
  if (!response.ok) {
    throw new UpstreamError('The air-quality service is having problems. Please try again.',
      { cause: new Error(`${host}: HTTP ${response.status}`) });
  }
  return response.json();
}

async function geocode(fetchImpl, city, language) {
  // `language` lets the geocoder match Devanagari names such as पुणे (coverage is partial upstream).
  const params = new URLSearchParams({ name: city, count: '1', format: 'json', language });
  const place = (await fetchJson(fetchImpl, `${GEOCODE_URL}?${params}`)).results?.[0];
  if (!place) throw new NotFoundError(`We couldn't find "${city}". Try a nearby larger city.`);
  return {
    name: place.name,
    region: place.admin1 ?? '',
    country: place.country ?? '',
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

function mapAir({ current = {}, hourly = {} }) {
  if (!isNumber(current.us_aqi) || !isNumber(current.pm2_5)) {
    throw new UpstreamError('No current air-quality reading is available for this location.');
  }
  const times = hourly.time ?? [];
  return {
    current: {
      time: current.time,
      aqi: current.us_aqi,
      pm25: current.pm2_5,
      pm10: current.pm10 ?? null,
      no2: current.nitrogen_dioxide ?? null,
      o3: current.ozone ?? null,
    },
    hourly: times
      .map((time, i) => ({ time, aqi: hourly.us_aqi?.[i], pm25: hourly.pm2_5?.[i] }))
      .filter((h) => isNumber(h.aqi) && isNumber(h.pm25)),
  };
}

async function loadAirData(fetchImpl, city, language) {
  const location = await geocode(fetchImpl, city, language);
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone',
    hourly: 'us_aqi,pm2_5',
    forecast_days: '1',
    timezone: 'auto', // times come back in the city's local time
  });
  const air = mapAir(await fetchJson(fetchImpl, `${AIR_URL}?${params}`));
  return Object.freeze({ location, ...air });
}

/**
 * Air-data client with an in-memory TTL cache shared by concurrent callers.
 * shortcut: per-process cache, so it resets on restart and isn't shared across instances; fine for one Render instance.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, ttlMs?: number, maxEntries?: number }} [options]
 */
export function createAirDataClient({
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const cache = new Map(); // key → { expires, promise }

  /**
   * @param {string} city already validated by schemas.validateProfile
   * @param {'en' | 'hi' | 'mr'} [language] UI language, used for geocoding only
   * @returns {Promise<{ location: object, current: object, hourly: Array<{ time: string, aqi: number, pm25: number }> }>}
   */
  async function getAirData(city, language = 'en') {
    const key = city.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.promise;

    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value); // Map keeps insertion order
    const promise = loadAirData(fetchImpl, city, language);
    cache.set(key, { expires: now() + ttlMs, promise });
    promise.catch(() => cache.delete(key)); // never cache failures
    return promise;
  }

  return { getAirData };
}
