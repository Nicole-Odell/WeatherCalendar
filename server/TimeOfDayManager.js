import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'sunTimes';

// Fields to keep from the sunrise-sunset.org response
const SUN_FIELDS = [
  'sunrise',
  'sunset',
  'astronomical_twilight_begin',
  'astronomical_twilight_end',
];

/**
 * Returns today's sun times as { date, times }, where `date` is the date the
 * cache was refreshed (YYYY-MM-DD) and `times` holds an ISO 8601 time, in the
 * location's timezone, for each field. A time is null if that event does not
 * happen that day. Data comes from the cache unless it is from an earlier date.
 */
export async function GetSunTimes() {
  const today = getTodaysDate();
  const cached = await readCache(CACHE_NAME);
  if (cached?.date === today) {
    return cached;
  }

  const sunTimes = await fetchSunTimes(today);
  await writeCache(CACHE_NAME, sunTimes);
  return sunTimes;
}

/**
 * Returns the sun's position at the location as { elevation, azimuth, distance }:
 * elevation in degrees above the horizon (without the slight lift from
 * atmospheric refraction), azimuth in degrees clockwise from north, and
 * distance from Earth in astronomical units. Uses NOAA's solar position equations.
 */
export function GetSunPosition(date = new Date()) {
  const centuries = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525; // since J2000
  const meanLongitude = mod(280.46646 + centuries * (36000.76983 + centuries * 0.0003032), 360);
  const meanAnomaly = toRadians(357.52911 + centuries * (35999.05029 - 0.0001537 * centuries));
  const eccentricity = 0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const equationOfCenter =
    Math.sin(meanAnomaly) * (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * centuries) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const trueAnomaly = meanAnomaly + toRadians(equationOfCenter);
  const distance =
    (1.000001018 * (1 - eccentricity ** 2)) / (1 + eccentricity * Math.cos(trueAnomaly));
  const omega = toRadians(125.04 - 1934.136 * centuries);
  const apparentLongitude = toRadians(
    meanLongitude + equationOfCenter - 0.00569 - 0.00478 * Math.sin(omega),
  );
  const meanObliquity =
    23 + (26 + (21.448 - centuries * (46.815 + centuries * (0.00059 - centuries * 0.001813))) / 60) / 60;
  const obliquity = toRadians(meanObliquity + 0.00256 * Math.cos(omega));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  // Difference between solar time and clock time, in minutes
  const y = Math.tan(obliquity / 2) ** 2;
  const L0 = toRadians(meanLongitude);
  const equationOfTime =
    4 *
    toDegrees(
      y * Math.sin(2 * L0) -
        2 * eccentricity * Math.sin(meanAnomaly) +
        4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * L0) -
        0.5 * y * y * Math.sin(4 * L0) -
        1.25 * eccentricity ** 2 * Math.sin(2 * meanAnomaly),
    );
  const utcMinutes = mod(date.getTime() / 60000, 1440);
  const trueSolarTime = mod(utcMinutes + equationOfTime + 4 * LONGITUDE, 1440);
  const hourAngle = toRadians(trueSolarTime / 4 - 180);

  const latitude = toRadians(LATITUDE);
  const sinElevation =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  // Measured from south toward west, then converted to clockwise from north
  const azimuthFromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
  );
  return {
    elevation: toDegrees(Math.asin(Math.min(1, Math.max(-1, sinElevation)))),
    azimuth: mod(toDegrees(azimuthFromSouth) + 180, 360),
    distance,
  };
}

async function fetchSunTimes(date) {
  const params = new URLSearchParams({ lat: LATITUDE, lng: LONGITUDE, date });
  const response = await fetch(`https://api.sunrise-sunset.org/v2?${params}`);
  if (!response.ok) {
    throw new Error(`sunrise-sunset.org request failed (${response.status}): ${await response.text()}`);
  }

  const body = await response.json();
  return {
    date,
    times: Object.fromEntries(SUN_FIELDS.map((field) => [field, body[field]])),
  };
}

// Today's date on this computer, as YYYY-MM-DD
function getTodaysDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

// Remainder that is always positive, e.g. mod(-10, 360) is 350
function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
