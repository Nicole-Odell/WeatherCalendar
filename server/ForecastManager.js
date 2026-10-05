import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'forecast';
const CACHE_DURATION_MS = 15 * 60 * 1000;
const FORECAST_DAYS = 2;
// The ensemble forecast used for the chance of precipitation: ECMWF's, with 51
// members (runs of the model from slightly different starting conditions)
const ENSEMBLE_MODEL = 'ecmwf_ifs025';

/**
 * Returns the forecast for the next two days as { fetchedAt, minutely,
 * ensemble }, with every time in milliseconds since 1970:
 * - minutely: { step (ms), times, temperature (°C), precipitation (mm),
 *   weatherCode (WMO) }, every 15 minutes. Temperatures are at each time;
 *   precipitation and weather codes are for the step ending at each time.
 * - ensemble: { model, step (ms), times, members }, hourly, where `members`
 *   holds each ensemble member's precipitation (mm, the total for the hour
 *   ending at each time)
 * Data comes from the cache unless it is over 15 minutes old.
 */
export async function GetForecast() {
  const cached = await readCache(CACHE_NAME);
  if (cached?.minutely.weatherCode && Date.now() - Date.parse(cached.fetchedAt) < CACHE_DURATION_MS) {
    return cached;
  }
  const forecast = await fetchForecast();
  await writeCache(CACHE_NAME, forecast);
  return forecast;
}

async function fetchJson(url, params) {
  const query = new URLSearchParams({
    latitude: LATITUDE,
    longitude: LONGITUDE,
    forecast_days: FORECAST_DAYS,
    timezone: 'GMT',
    timeformat: 'unixtime',
    ...params,
  });
  const response = await fetch(`${url}?${query}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function fetchForecast() {
  const [forecast, ensemble] = await Promise.all([
    fetchJson('https://api.open-meteo.com/v1/forecast', { minutely_15: 'temperature_2m,precipitation,weather_code' }),
    fetchJson('https://ensemble-api.open-meteo.com/v1/ensemble', { hourly: 'precipitation', models: ENSEMBLE_MODEL }),
  ]);
  const minutely = forecast.minutely_15;
  const memberKeys = Object.keys(ensemble.hourly).filter((key) => key.startsWith('precipitation'));
  return {
    fetchedAt: new Date().toISOString(),
    minutely: {
      step: 15 * 60 * 1000,
      times: minutely.time.map((seconds) => seconds * 1000),
      temperature: minutely.temperature_2m,
      precipitation: minutely.precipitation,
      weatherCode: minutely.weather_code,
    },
    ensemble: {
      model: ENSEMBLE_MODEL,
      step: 60 * 60 * 1000,
      times: ensemble.hourly.time.map((seconds) => seconds * 1000),
      members: memberKeys.map((key) => ensemble.hourly[key]),
    },
  };
}
