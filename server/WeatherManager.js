import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';
import { GetSunPosition } from './TimeOfDayManager.js';

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
  'uv_index',
  // (for the cloud darkness, see cloudDarkness)
  'shortwave_radiation',
  'direct_radiation',
];

/*
 * How dark the clouds are (`cloud_darkness` in the current weather, 0 for
 * thin bright cloud to 1 for thick dark cloud), as the cloud cover alone
 * doesn't say: 100% thin high cloud and 100% thick rain cloud look nothing
 * alike. It's found two ways, blended by how much sunlight a clear sky would
 * give (CLEAR_SKY_FULL_WEIGHT W/m² or more uses only the first):
 * - By day, how much sunlight gets through the cloud: the sunlight on the
 *   ground as a share of a clear sky's, taken as the cloud's (for its cover),
 *   from DARKNESS_TRANSMITTED.none (darkness 0) to .all (darkness 1)
 * - At any time, how deep the cloud is: the height of cloud stacked up at
 *   each pressure level (by the cover there), DEEP_CLOUD_KM or more being
 *   darkness 1
 * Also kept: `cloud_depth` (km).
 */
const CLOUD_LEVELS = [
  { hPa: 1000, km: 0.1 },
  { hPa: 975, km: 0.3 },
  { hPa: 950, km: 0.5 },
  { hPa: 925, km: 0.8 },
  { hPa: 900, km: 1.0 },
  { hPa: 850, km: 1.5 },
  { hPa: 800, km: 1.9 },
  { hPa: 700, km: 3.0 },
  { hPa: 600, km: 4.2 },
  { hPa: 500, km: 5.6 },
  { hPa: 400, km: 7.2 },
  { hPa: 300, km: 9.2 },
  { hPa: 250, km: 10.4 },
  { hPa: 200, km: 11.8 },
];
const DEEP_CLOUD_KM = 3;
const DARKNESS_TRANSMITTED = { none: 0.8, all: 0.1 };
const CLEAR_SKY_FULL_WEIGHT = 150;
const DERIVED_FIELDS = ['cloud_darkness', 'cloud_depth'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Sunlight on the ground under a clear sky (W/m²) with the sun `elevation`
// degrees up (Haurwitz's model)
function clearSkySunlight(elevation) {
  if (elevation <= 0) return 0;
  const sine = Math.sin((elevation * Math.PI) / 180);
  return 1098 * sine * Math.exp(-0.057 / sine);
}

// How deep the cloud is (km), from Open-Meteo's hourly cover at each level,
// at the current time (between the hours either side)
function cloudDepth(hourly, time) {
  const times = hourly.time;
  let i = times.findIndex((hour, index) => hour <= time && (times[index + 1] ?? '9') > time);
  if (i < 0) i = 0;
  const j = Math.min(i + 1, times.length - 1);
  const share = j > i ? (Date.parse(time) - Date.parse(times[i])) / (Date.parse(times[j]) - Date.parse(times[i])) : 0;
  let depth = 0;
  CLOUD_LEVELS.forEach((level, index) => {
    const values = hourly[`cloud_cover_${level.hPa}hPa`];
    if (!values) return;
    const cover = (values[i] + (values[j] - values[i]) * clamp(share, 0, 1)) / 100;
    // (each level stands for the air halfway to the levels either side)
    const below = index > 0 ? (level.km + CLOUD_LEVELS[index - 1].km) / 2 : 0;
    const above = index < CLOUD_LEVELS.length - 1 ? (level.km + CLOUD_LEVELS[index + 1].km) / 2 : level.km;
    depth += (cover || 0) * (above - below);
  });
  return depth;
}

// The cloud darkness (see above) for `current` conditions at `date`
function cloudDarkness(current, depth, date) {
  const byDepth = clamp(depth / DEEP_CLOUD_KM, 0, 1);
  const clear = clearSkySunlight(GetSunPosition(date).elevation);
  const cover = (current.cloud_cover ?? 0) / 100;
  if (!(clear > 0) || current.shortwave_radiation == null || cover <= 0) return byDepth;
  const clearness = clamp(current.shortwave_radiation / clear, 0, 1);
  const transmitted = clamp(1 - (1 - clearness) / Math.max(cover, 0.3), 0, 1);
  const bySunlight = clamp(
    (DARKNESS_TRANSMITTED.none - transmitted) / (DARKNESS_TRANSMITTED.none - DARKNESS_TRANSMITTED.all),
    0,
    1,
  );
  const weight = clamp(clear / CLEAR_SKY_FULL_WEIGHT, 0, 1);
  return bySunlight * weight + byDepth * (1 - weight);
}

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
    cached?.moonPhases &&
    [...CURRENT_FIELDS, ...AIR_QUALITY_FIELDS, ...DERIVED_FIELDS].every((field) => field in cached.current);
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
      hourly: CLOUD_LEVELS.map((level) => `cloud_cover_${level.hPa}hPa`).join(','),
      past_hours: 1,
      forecast_hours: 2,
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
  // (Open-Meteo's times are local, without a zone: its offset gives the moment)
  const moment = new Date(Date.parse(`${current.time}:00Z`) - forecast.utc_offset_seconds * 1000);
  current.cloud_depth = Math.round(cloudDepth(forecast.hourly, current.time) * 100) / 100;
  current.cloud_darkness = Math.round(cloudDarkness(current, current.cloud_depth, moment) * 100) / 100;
  units.cloud_depth = 'km';
  units.cloud_darkness = '';
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
