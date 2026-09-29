import { useEffect, useRef, useState } from 'react';
import { hsvToLinearRgb, linearRgbToCss, readableTextColor, withScreenBrightness } from './color.js';
import { toImperial } from './units.js';

const luminanceFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });

// Default exposure for the sky gradient, as luminance in cd/m². The floor is
// shown as black, and full brightness is at least the ceiling.
const DEFAULT_EXPOSURE = { floor: 0.0001, ceiling: 15000 };

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Screen brightness (0–1) for each luminance (cd/m²). The floor is black, and
 * full brightness is the highest luminance or the ceiling, whichever is higher,
 * so the sky dims once all of it is darker than the ceiling. In between, the
 * scale is logarithmic, which gives dim light more contrast, as human vision
 * does. Anything dimmer than the floor is black.
 */
function screenBrightnesses(luminances, { floor, ceiling }) {
  const top = Math.max(ceiling, ...luminances);
  const range = Math.log(top / floor);
  return luminances.map((luminance) =>
    luminance < floor ? 0 : Math.log(luminance / floor) / range,
  );
}

/**
 * How the page shows the sky colors: a background gradient from the lowest
 * elevation at the bottom to the highest at the top, and the text color that's
 * easiest to read over it
 */
function skyAppearance(colors, exposure) {
  const bottom = colors[0].elevation;
  const top = colors.at(-1).elevation;
  const brightnesses = screenBrightnesses(
    colors.map((color) => color.brightness),
    exposure,
  );
  const shown = colors.map(({ hue, saturation }, i) =>
    withScreenBrightness(hsvToLinearRgb(hue, saturation, 1), brightnesses[i]),
  );
  const stops = shown.map((rgb, i) => {
    const position = ((colors[i].elevation - bottom) / (top - bottom)) * 100;
    return `${linearRgbToCss(rgb)} ${position}%`;
  });
  const average = [0, 1, 2].map(
    (channel) => shown.reduce((total, rgb) => total + rgb[channel], 0) / shown.length,
  );
  return {
    background: `linear-gradient(to top, ${stops.join(', ')})`,
    textColor: readableTextColor(average),
  };
}

// A time input's "HH:MM" value, as that time today
function todayAt(time) {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

// A date's local time as a time input value, "HH:MM"
function toTimeValue(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// How far the step buttons move the sky color time
const STEP_MINUTES = 5;

export default function App() {
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sunTimes, setSunTimes] = useState(null);
  const [sunError, setSunError] = useState(null);
  const [sky, setSky] = useState(null);
  const [skyError, setSkyError] = useState(null);
  // Time the sky colors are calculated for, as "HH:MM", or '' for now
  const [skyTime, setSkyTime] = useState('');
  // What's in the time input, which only takes effect when applied
  const [skyTimeInput, setSkyTimeInput] = useState('');
  const latestSkyRequest = useRef(0);
  // Exposure for the sky gradient, and what's in its inputs until applied
  const [exposure, setExposure] = useState(DEFAULT_EXPOSURE);
  const [exposureInputs, setExposureInputs] = useState({
    floor: String(DEFAULT_EXPOSURE.floor),
    ceiling: String(DEFAULT_EXPOSURE.ceiling),
  });
  const [exposureError, setExposureError] = useState(null);

  async function loadWeather(forceRefresh = false) {
    setLoading(true);
    setWeatherError(null);
    try {
      const query = forceRefresh ? '?forceRefresh=true' : '';
      setWeather(await fetchJson(`/api/weather/current${query}`));
    } catch (err) {
      setWeatherError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSunTimes() {
    setSunError(null);
    try {
      setSunTimes(await fetchJson('/api/time-of-day/sun-times'));
    } catch (err) {
      setSunError(err.message);
    }
  }

  async function loadSkyColors(time) {
    const request = ++latestSkyRequest.current;
    setSkyError(null);
    try {
      const query = time ? `?time=${encodeURIComponent(todayAt(time).toISOString())}` : '';
      const result = await fetchJson(`/api/sky/colors${query}`);
      // Ignore answers to earlier requests that arrive after a later one
      if (request === latestSkyRequest.current) setSky(result);
    } catch (err) {
      if (request === latestSkyRequest.current) setSkyError(err.message);
    }
  }

  function applySkyTime(time) {
    setSkyTime(time);
    setSkyTimeInput(time);
    loadSkyColors(time);
  }

  function applyExposure() {
    const floor = Number(exposureInputs.floor);
    const ceiling = Number(exposureInputs.ceiling);
    if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || floor <= 0 || ceiling <= floor) {
      setExposureError('The floor must be more than 0, and the ceiling more than the floor.');
      return;
    }
    setExposureError(null);
    setExposure({ floor, ceiling });
  }

  // Moves the time in the input (or now, if it's empty) by some minutes and
  // applies it. Times wrap around midnight within today.
  function stepSkyTime(minutes) {
    const date = skyTimeInput ? todayAt(skyTimeInput) : new Date();
    date.setMinutes(date.getMinutes() + minutes);
    applySkyTime(toTimeValue(date));
  }

  // Sky colors are calculated from the weather, so they load after it
  function refresh() {
    loadWeather(true).then(() => loadSkyColors(skyTime));
    loadSunTimes();
  }

  useEffect(() => {
    loadWeather().then(() => loadSkyColors(''));
    loadSunTimes();
  }, []);

  const appearance = sky && skyAppearance(sky.colors, exposure);

  return (
    <>
      {appearance && <div className="sky-background" style={{ background: appearance.background }} />}
      <main className="app" style={{ color: appearance?.textColor }}>
        {weather && (
          <>
            <table>
              <tbody>
                {Object.entries(weather.current).map(([field, metricValue]) => {
                  const { value, unit } = toImperial(metricValue, weather.units[field]);
                  return (
                    <tr key={field}>
                      <th>{field}</th>
                      <td>
                        {value} {unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p>Last updated: {new Date(weather.fetchedAt).toLocaleString()}</p>
          </>
        )}
        {weatherError && <p>Weather error: {weatherError}</p>}
        {sunTimes && (
          <>
            <table>
              <tbody>
                {Object.entries(sunTimes.times).map(([field, time]) => (
                  <tr key={field}>
                    <th>{field}</th>
                    <td>{time ? formatTime(time) : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Sun times for {sunTimes.date} from{' '}
              <a href="https://sunrise-sunset.org" target="_blank" rel="noreferrer">
                sunrise-sunset.org
              </a>
            </p>
          </>
        )}
        {sunError && <p>Sun times error: {sunError}</p>}
        <p>
          <label>
            Sky color time:{' '}
            <input
              type="time"
              value={skyTimeInput}
              onChange={(event) => setSkyTimeInput(event.target.value)}
            />
          </label>{' '}
          <button type="button" onClick={() => stepSkyTime(-STEP_MINUTES)}>
            ◀ {STEP_MINUTES} min
          </button>{' '}
          <button type="button" onClick={() => stepSkyTime(STEP_MINUTES)}>
            {STEP_MINUTES} min ▶
          </button>{' '}
          <button
            type="button"
            onClick={() => applySkyTime(skyTimeInput)}
            disabled={skyTimeInput === skyTime}
          >
            Apply
          </button>{' '}
          <button type="button" onClick={() => applySkyTime('')} disabled={!skyTime && !skyTimeInput}>
            Now
          </button>
        </p>
        <p>
          <label>
            Exposure floor:{' '}
            <input
              type="number"
              min="0"
              step="any"
              value={exposureInputs.floor}
              onChange={(event) => setExposureInputs({ ...exposureInputs, floor: event.target.value })}
            />{' '}
            cd/m²
          </label>{' '}
          <label>
            ceiling:{' '}
            <input
              type="number"
              min="0"
              step="any"
              value={exposureInputs.ceiling}
              onChange={(event) => setExposureInputs({ ...exposureInputs, ceiling: event.target.value })}
            />{' '}
            cd/m²
          </label>{' '}
          <button
            type="button"
            onClick={applyExposure}
            disabled={
              Number(exposureInputs.floor) === exposure.floor &&
              Number(exposureInputs.ceiling) === exposure.ceiling
            }
          >
            Apply
          </button>
        </p>
        {exposureError && <p>Exposure error: {exposureError}</p>}
        {sky && (
          <>
            <p>
              Clear sky toward the sun at {formatTime(sky.time)} (sun elevation{' '}
              {sky.sun.elevation.toFixed(1)}°, azimuth {sky.sun.azimuth.toFixed(1)}°)
            </p>
            <table>
              <thead>
                <tr>
                  <th>elevation</th>
                  <th>hue</th>
                  <th>saturation</th>
                  <th>luminance (cd/m²)</th>
                </tr>
              </thead>
              <tbody>
                {/* Highest first, as it would appear looking at the sky */}
                {[...sky.colors].reverse().map((color) => (
                  <tr key={color.elevation}>
                    <td>{color.elevation}°</td>
                    <td>{Math.round(color.hue)}°</td>
                    <td>{color.saturation.toFixed(2)}</td>
                    <td>{luminanceFormat.format(color.brightness)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {skyError && <p>Sky color error: {skyError}</p>}
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </main>
    </>
  );
}
