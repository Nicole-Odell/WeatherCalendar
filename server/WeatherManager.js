import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'currentWeather';
const CACHE_DURATION_MS = 15 * 60 * 1000;
// A forced refresh still uses the cache if it is newer than this
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// Every variable Open-Meteo offers for current conditions, plus cloud cover by
// height (low is up to 3 km, mid 3–8 km, high above 8 km)
const CURRENT_FIELDS = [
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
];

// Haze and the US Air Quality Index, from Open-Meteo's air quality API. (Its
// pollen data only covers Europe.)
const AIR_QUALITY_FIELDS = ['aerosol_optical_depth', 'us_aqi'];

// The moon's phase from Open-Meteo, as a fraction of its cycle (0 new, 0.25
// first quarter, 0.5 full, 0.75 last quarter). Its daily value is the phase
// at local noon, so yesterday's to tomorrow's are fetched to cover any time
// today.
const MOON_PHASE_DAYS = { past_days: 1, forecast_days: 2 };
// Days in the moon's cycle of phases, on average
const SYNODIC_MONTH_DAYS = 29.530589;

/**
 * Returns the current weather as { fetchedAt, current, units, moonPhases },
 * where `current` holds Open-Meteo's values (including haze from its air
 * quality API), `units` holds the unit for each value, and `moonPhases` holds
 * the moon's phase at local noon by day, as [{ noon, phase }].
 * Data comes from the cache unless it is older than 15 minutes, or older than
 * 1 minute when forceRefresh is true.
 */
export async function GetCurrentWeatherData(forceRefresh = false) {
  const cached = await readCache(CACHE_NAME);
  const maxAge = forceRefresh ? MIN_REFRESH_INTERVAL_MS : CACHE_DURATION_MS;
  const complete =
    cached?.moonPhases && [...CURRENT_FIELDS, ...AIR_QUALITY_FIELDS].every((field) => field in cached.current);
  if (complete && Date.now() - Date.parse(cached.fetchedAt) < maxAge) {
    return cached;
  }

  const weather = await fetchCurrentWeather();
  await writeCache(CACHE_NAME, weather);
  return weather;
}

async function fetchCurrentWeather() {
  const [forecast, airQuality] = await Promise.all([
    fetchCurrentConditions('https://api.open-meteo.com/v1/forecast', CURRENT_FIELDS, {
      daily: 'moon_phase',
      ...MOON_PHASE_DAYS,
    }),
    fetchCurrentConditions('https://air-quality-api.open-meteo.com/v1/air-quality', AIR_QUALITY_FIELDS),
  ]);

  // Both responses have their own time and interval, so only the air quality
  // fields are copied over
  const current = { ...forecast.current };
  const units = { ...forecast.current_units };
  for (const field of AIR_QUALITY_FIELDS) {
    current[field] = airQuality.current[field];
    units[field] = airQuality.current_units[field];
  }
  // Each day's local noon, from the date and the location's UTC offset
  const moonPhases = forecast.daily.time.map((day, i) => ({
    noon: new Date(Date.parse(`${day}T12:00:00Z`) - forecast.utc_offset_seconds * 1000).toISOString(),
    phase: forecast.daily.moon_phase[i],
  }));
  return { fetchedAt: new Date().toISOString(), current, units, moonPhases };
}

/**
 * The moon's phase at `date` (0–1, see MOON_PHASE_DAYS), from `moonPhases`
 * (as GetCurrentWeatherData gives): the phase at the nearest noon, moved on at
 * the moon's average rate. That's within about 0.002 of the true phase.
 */
export function GetMoonPhase(moonPhases, date = new Date()) {
  const nearest = moonPhases.reduce((best, entry) =>
    Math.abs(Date.parse(entry.noon) - date) < Math.abs(Date.parse(best.noon) - date) ? entry : best,
  );
  const days = (date - Date.parse(nearest.noon)) / 86400000;
  return (((nearest.phase + days / SYNODIC_MONTH_DAYS) % 1) + 1) % 1;
}

async function fetchCurrentConditions(url, fields, extraParams = {}) {
  const params = new URLSearchParams({
    latitude: LATITUDE,
    longitude: LONGITUDE,
    current: fields.join(','),
    timezone: 'auto',
    ...extraParams,
  });
  const response = await fetch(`${url}?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}
