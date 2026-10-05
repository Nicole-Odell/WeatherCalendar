import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'sunTimes';

// Fields to keep from the sunrise-sunset.org response. `dusk` is the end of
// civil twilight, when the sun is 6° below the horizon.
const SUN_FIELDS = [
  'sunrise',
  'sunset',
  'dusk',
  'astronomical_twilight_begin',
  'astronomical_twilight_end',
];

/**
 * Returns today's sun times as { date, times, events }, where `date` is the
 * date the cache was refreshed (YYYY-MM-DD) and `times` holds an ISO 8601
 * time, in the location's timezone, for each field. A time is null if that
 * event does not happen that day. `events` lists every sunrise and sunset from
 * yesterday to tomorrow in order, as [{ type: 'sunrise' or 'sunset', time,
 * twilight }], so the last and next ones are always there; `twilight` is that
 * day's astronomical dawn (for a sunrise) or dusk (for a sunset), or null if
 * there's none (the sky never gets fully dark around midsummer). Data comes from the cache unless it is from an earlier date
 * or is missing a field.
 */
export async function GetSunTimes() {
  const today = getTodaysDate();
  const cached = await readCache(CACHE_NAME);
  if (
    cached?.date === today &&
    cached.events?.every((event) => 'twilight' in event) &&
    SUN_FIELDS.every((field) => field in cached.times)
  ) {
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
    // (radians, for the moon's lit side; see GetMoonPosition)
    rightAscension: Math.atan2(Math.cos(obliquity) * Math.sin(apparentLongitude), Math.cos(apparentLongitude)),
    declination,
  };
}

// Yesterday's to tomorrow's sun times, in one request
async function fetchSunTimes(date) {
  const params = new URLSearchParams({
    lat: LATITUDE,
    lng: LONGITUDE,
    date_start: getDate(-1),
    date_end: getDate(1),
  });
  const response = await fetch(`https://api.sunrise-sunset.org/v2?${params}`);
  if (!response.ok) {
    throw new Error(`sunrise-sunset.org request failed (${response.status}): ${await response.text()}`);
  }

  const { days } = await response.json();
  const today = days.find((day) => day.date === date);
  if (!today) throw new Error(`sunrise-sunset.org gave no times for ${date}`);
  const events = days
    .flatMap((day) => [
      { type: 'sunrise', time: day.sunrise, twilight: day.astronomical_twilight_begin ?? null },
      { type: 'sunset', time: day.sunset, twilight: day.astronomical_twilight_end ?? null },
    ])
    .filter(({ time }) => time)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return {
    date,
    times: Object.fromEntries(SUN_FIELDS.map((field) => [field, today[field]])),
    events,
  };
}

/**
 * Returns the moon's position at the location as { altitude, distance,
 * longitude, parallacticAngle, brightLimb }: altitude in degrees above the
 * horizon as seen from here (without refraction), distance from Earth's center
 * in km, ecliptic longitude in degrees, how far its north is turned clockwise
 * from straight up (degrees), and which way its lit side faces, in degrees
 * counterclockwise from straight up (270 is lit on the right). Uses the main terms of Meeus's lunar series
 * (Astronomical Algorithms, chapter 47), good to about 0.1°.
 */
export function GetMoonPosition(date = new Date()) {
  const days = date.getTime() / 86400000 + 2440587.5 - 2451545; // since J2000
  const centuries = days / 36525;
  const meanLongitude = 218.3164477 + 481267.88123421 * centuries;
  const elongation = toRadians(297.8501921 + 445267.1114034 * centuries);
  const sunAnomaly = toRadians(357.5291092 + 35999.0502909 * centuries);
  const moonAnomaly = toRadians(134.9633964 + 477198.8675055 * centuries);
  const latitudeArgument = toRadians(93.272095 + 483202.0175233 * centuries);
  const D = elongation;
  const M = sunAnomaly;
  const Mm = moonAnomaly;
  const F = latitudeArgument;

  const longitude = toRadians(
    meanLongitude +
      6.288774 * Math.sin(Mm) +
      1.274027 * Math.sin(2 * D - Mm) +
      0.658314 * Math.sin(2 * D) +
      0.213618 * Math.sin(2 * Mm) -
      0.185116 * Math.sin(M) -
      0.114332 * Math.sin(2 * F) +
      0.058793 * Math.sin(2 * D - 2 * Mm) +
      0.057066 * Math.sin(2 * D - M - Mm) +
      0.053322 * Math.sin(2 * D + Mm) +
      0.045758 * Math.sin(2 * D - M),
  );
  const latitudeOnEcliptic = toRadians(
    5.128122 * Math.sin(F) +
      0.280602 * Math.sin(Mm + F) +
      0.277693 * Math.sin(Mm - F) +
      0.173237 * Math.sin(2 * D - F) +
      0.055413 * Math.sin(2 * D - Mm + F) +
      0.046271 * Math.sin(2 * D - Mm - F),
  );
  const distance =
    385000.56 -
    20905.355 * Math.cos(Mm) -
    3699.111 * Math.cos(2 * D - Mm) -
    2955.968 * Math.cos(2 * D) -
    569.925 * Math.cos(2 * Mm);

  // Ecliptic to equatorial coordinates
  const obliquity = toRadians(23.439291 - 0.0130042 * centuries);
  const rightAscension = Math.atan2(
    Math.sin(longitude) * Math.cos(obliquity) - Math.tan(latitudeOnEcliptic) * Math.sin(obliquity),
    Math.cos(longitude),
  );
  const declination = Math.asin(
    Math.sin(latitudeOnEcliptic) * Math.cos(obliquity) +
      Math.cos(latitudeOnEcliptic) * Math.sin(obliquity) * Math.sin(longitude),
  );

  // Altitude from Earth's center, then lowered by the moon's parallax, since
  // it's seen from Earth's surface (about 1° at the horizon)
  const siderealTime = toRadians(280.46061837 + 360.98564736629 * days + LONGITUDE);
  const hourAngle = siderealTime - rightAscension;
  const latitude = toRadians(LATITUDE);
  const geocentric = Math.asin(
    Math.sin(latitude) * Math.sin(declination) +
      Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const parallax = Math.asin(6378.14 / distance);
  // How the moon is turned as seen from here: the parallactic angle, between
  // the directions to the celestial north pole and the zenith (Meeus 14.1),
  // and the position angle of its lit limb's midpoint from north toward east
  // (Meeus 48.5)
  const parallactic = Math.atan2(
    Math.sin(hourAngle),
    Math.tan(latitude) * Math.cos(declination) - Math.sin(declination) * Math.cos(hourAngle),
  );
  const sun = GetSunPosition(date);
  const brightLimb = Math.atan2(
    Math.cos(sun.declination) * Math.sin(sun.rightAscension - rightAscension),
    Math.sin(sun.declination) * Math.cos(declination) -
      Math.cos(sun.declination) * Math.sin(declination) * Math.cos(sun.rightAscension - rightAscension),
  );
  return {
    altitude: toDegrees(geocentric - parallax * Math.cos(geocentric)),
    distance,
    longitude: mod(toDegrees(longitude), 360),
    parallacticAngle: toDegrees(parallactic),
    brightLimb: mod(toDegrees(brightLimb - parallactic), 360),
  };
}

// Today's date on this computer, as YYYY-MM-DD
function getTodaysDate() {
  return getDate(0);
}

// The date `days` days from today on this computer, as YYYY-MM-DD
function getDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
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
