// Precipitation counted as "any" in a time span, as for Open-Meteo's own
// precipitation probability (mm)
const ANY_PRECIPITATION = 0.1;

/*
 * The forecast for a span of time, from /api/forecast's data (all times in
 * milliseconds since 1970). Precipitation values are totals for the step
 * ending at their time; a step counts toward the span if at least half of it
 * falls within it.
 */

// Whether at least half of the step ending at `time` falls within from–to
function stepCounts(time, step, from, to) {
  const overlap = Math.min(time, to) - Math.max(time - step, from);
  return overlap >= step / 2;
}

// Whether each step (ending at each of `times`) counts toward from–to. If the
// span is too short for any to, the step it ends in counts, so a span just
// before a sun event keeps that last step's forecast.
function countedSteps(times, step, from, to) {
  const counted = times.map((time) => stepCounts(time, step, from, to));
  if (!counted.includes(true)) {
    const last = times.findIndex((time) => time >= to);
    if (last >= 0) counted[last] = true;
  }
  return counted;
}

// The temperatures at the times within from–to, or if there are none (with
// the span between two times), those at the times either side of it
function temperaturesFor(minutely, from, to) {
  const { times, temperature } = minutely;
  let indexes = times.map((_, i) => i).filter((i) => times[i] >= from && times[i] <= to);
  if (!indexes.length) {
    const after = times.findIndex((time) => time >= to);
    indexes = [after - 1, after].filter((i) => i >= 0);
  }
  return indexes.map((i) => temperature[i]).filter((value) => typeof value === 'number');
}

// WMO weather codes for each precipitation icon (thunderstorms count as their
// rain or hail), the first matching group winning: snowflake for snow, sleet
// and hail, two raindrops for moderate or heavy rain, one for light rain, and
// drizzle
const ICON_CODES = [
  ['snowflake', [56, 57, 66, 67, 71, 73, 75, 77, 85, 86, 96, 99]],
  ['raindrops', [63, 65, 81, 82, 95, 97]],
  ['raindrop', [61, 80]],
  ['drizzle', [51, 53, 55]],
];

/**
 * The precipitation icon for a span, from the weather codes of the 15-minute
 * steps that count toward it: 'snowflake', 'raindrops', 'raindrop' or
 * 'drizzle', for the most extreme code; 'raindrop' if none is forecast
 */
function precipitationIcon(codes) {
  const match = ICON_CODES.find(([, group]) => codes.some((code) => group.includes(code)));
  return match ? match[0] : 'raindrop';
}

/**
 * The forecast from `from` to `to`, or null if the forecast doesn't cover it:
 * { high, low } (°C, the highest and lowest 15-minute temperatures within it),
 * precipitation (mm, the total forecast to fall), and precipitationChance
 * (0–1, the share of the ensemble's members forecasting any precipitation in
 * the span), and precipitationIcon (see precipitationIcon)
 */
export function forecastFor(forecast, from, to) {
  if (!forecast || !(to > from)) return null;
  const { minutely, ensemble } = forecast;
  if (minutely.times[minutely.times.length - 1] < to) return null;

  const temperatures = temperaturesFor(minutely, from, to);
  let precipitation = 0;
  const codes = [];
  const minutelyCounted = countedSteps(minutely.times, minutely.step, from, to);
  minutely.times.forEach((time, i) => {
    if (!minutelyCounted[i]) return;
    precipitation += minutely.precipitation[i] ?? 0;
    if (typeof minutely.weatherCode?.[i] === 'number') codes.push(minutely.weatherCode[i]);
  });

  const counted = countedSteps(ensemble.times, ensemble.step, from, to);
  const wet = ensemble.members.filter((member) => {
    const total = member.reduce((sum, value, i) => sum + (counted[i] ? (value ?? 0) : 0), 0);
    return total >= ANY_PRECIPITATION;
  }).length;

  return {
    high: temperatures.length ? Math.max(...temperatures) : null,
    low: temperatures.length ? Math.min(...temperatures) : null,
    precipitation,
    precipitationChance: ensemble.members.length ? wet / ensemble.members.length : null,
    precipitationIcon: precipitationIcon(codes),
  };
}
