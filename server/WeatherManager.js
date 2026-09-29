import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'currentWeather';
const CACHE_DURATION_MS = 15 * 60 * 1000;
// A forced refresh still uses the cache if it is newer than this
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// Every variable Open-Meteo offers for current conditions
const CURRENT_FIELDS = [
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

// Haze, from Open-Meteo's air quality API
const AIR_QUALITY_FIELDS = ['aerosol_optical_depth'];

/**
 * Returns the current weather as { fetchedAt, current, units }, where `current`
 * holds Open-Meteo's values (including haze from its air quality API) and
 * `units` holds the unit for each value.
 * Data comes from the cache unless it is older than 15 minutes, or older than
 * 1 minute when forceRefresh is true.
 */
export async function GetCurrentWeatherData(forceRefresh = false) {
  const cached = await readCache(CACHE_NAME);
  const maxAge = forceRefresh ? MIN_REFRESH_INTERVAL_MS : CACHE_DURATION_MS;
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxAge) {
    return cached;
  }

  const weather = await fetchCurrentWeather();
  await writeCache(CACHE_NAME, weather);
  return weather;
}

async function fetchCurrentWeather() {
  const [forecast, airQuality] = await Promise.all([
    fetchCurrentConditions('https://api.open-meteo.com/v1/forecast', CURRENT_FIELDS),
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
  return { fetchedAt: new Date().toISOString(), current, units };
}

async function fetchCurrentConditions(url, fields) {
  const params = new URLSearchParams({
    latitude: LATITUDE,
    longitude: LONGITUDE,
    current: fields.join(','),
    timezone: 'auto',
  });
  const response = await fetch(`${url}?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}
