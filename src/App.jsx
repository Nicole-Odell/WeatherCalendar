import { useEffect, useRef, useState } from 'react';
import SkyCanvas from './SkyCanvas.jsx';
import { DEFAULT_CLOUD_BRIGHTNESS, DEFAULT_HAZE_CONTRAST } from './skyImage.js';
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

// Cloud cover sliders, in percent
const CLOUD_SLIDERS = [
  { name: 'total', label: 'total' },
  { name: 'low', label: 'low (0–3 km)' },
  { name: 'mid', label: 'mid (3–8 km)' },
  { name: 'high', label: 'high (8+ km)' },
];
const NO_CLOUDS = { total: 0, low: 0, mid: 0, high: 0 };

function cloudsFromWeather(current) {
  return {
    total: current.cloud_cover ?? 0,
    low: current.cloud_cover_low ?? 0,
    mid: current.cloud_cover_mid ?? 0,
    high: current.cloud_cover_high ?? 0,
  };
}

function sameClouds(a, b) {
  return CLOUD_SLIDERS.every(({ name }) => a[name] === b[name]);
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
  // Cloud cover set with the sliders, or null to use the current weather, and
  // what the sliders show until applied
  const [cloudOverride, setCloudOverride] = useState(null);
  const [cloudInputs, setCloudInputs] = useState(NO_CLOUDS);
  const [textColor, setTextColor] = useState(undefined);
  // How bright clouds are compared to the sky, and what's in its inputs until applied
  const [cloudBrightness, setCloudBrightness] = useState(DEFAULT_CLOUD_BRIGHTNESS);
  const [cloudBrightnessInputs, setCloudBrightnessInputs] = useState({
    pivot: String(DEFAULT_CLOUD_BRIGHTNESS.pivot),
    exponent: String(DEFAULT_CLOUD_BRIGHTNESS.exponent),
  });
  const [cloudBrightnessError, setCloudBrightnessError] = useState(null);
  // Range of the haze contrast factor, and what's in its inputs until applied
  const [hazeContrast, setHazeContrast] = useState(DEFAULT_HAZE_CONTRAST);
  const [hazeContrastInputs, setHazeContrastInputs] = useState({
    min: String(DEFAULT_HAZE_CONTRAST.min),
    max: String(DEFAULT_HAZE_CONTRAST.max),
  });
  const [hazeContrastError, setHazeContrastError] = useState(null);

  const weatherClouds = weather ? cloudsFromWeather(weather.current) : NO_CLOUDS;
  const clouds = cloudOverride ?? weatherClouds;

  // The sliders follow the weather until they're applied
  useEffect(() => {
    if (!cloudOverride && weather) setCloudInputs(cloudsFromWeather(weather.current));
  }, [weather]);

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

  function applyHazeContrast() {
    const min = Number(hazeContrastInputs.min);
    const max = Number(hazeContrastInputs.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
      setHazeContrastError('Both values must be numbers of 0 or more.');
      return;
    }
    setHazeContrastError(null);
    setHazeContrast({ min, max });
  }

  function applyCloudBrightness() {
    const pivot = Number(cloudBrightnessInputs.pivot);
    const exponent = Number(cloudBrightnessInputs.exponent);
    if (!Number.isFinite(pivot) || !Number.isFinite(exponent) || pivot <= 0) {
      setCloudBrightnessError('The pivot must be more than 0, and the exponent a number.');
      return;
    }
    setCloudBrightnessError(null);
    setCloudBrightness({ pivot, exponent });
  }

  function resetClouds() {
    setCloudOverride(null);
    setCloudInputs(weatherClouds);
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

  return (
    <>
      {sky && (
        <SkyCanvas
          colors={sky.colors}
          sunElevation={sky.sun.elevation}
          exposure={exposure}
          clouds={clouds}
          cloudBrightness={cloudBrightness}
          hazeContrast={hazeContrast}
          onTextColor={setTextColor}
        />
      )}
      <main className="app" style={{ color: sky ? textColor : undefined }}>
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
        <p>
          Cloud cover:{' '}
          {CLOUD_SLIDERS.map(({ name, label }) => (
            <label key={name}>
              {label}{' '}
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={cloudInputs[name]}
                onChange={(event) =>
                  setCloudInputs({ ...cloudInputs, [name]: Number(event.target.value) })
                }
              />{' '}
              {cloudInputs[name]}%{' '}
            </label>
          ))}
          <button
            type="button"
            onClick={() => setCloudOverride({ ...cloudInputs })}
            disabled={sameClouds(cloudInputs, clouds)}
          >
            Apply
          </button>{' '}
          <button
            type="button"
            onClick={resetClouds}
            disabled={!cloudOverride && sameClouds(cloudInputs, weatherClouds)}
          >
            Now
          </button>
        </p>
        <p>
          <label>
            Cloud brightness pivot:{' '}
            <input
              type="number"
              min="0"
              step="any"
              value={cloudBrightnessInputs.pivot}
              onChange={(event) =>
                setCloudBrightnessInputs({ ...cloudBrightnessInputs, pivot: event.target.value })
              }
            />{' '}
            cd/m²
          </label>{' '}
          <label>
            exponent:{' '}
            <input
              type="number"
              step="any"
              value={cloudBrightnessInputs.exponent}
              onChange={(event) =>
                setCloudBrightnessInputs({ ...cloudBrightnessInputs, exponent: event.target.value })
              }
            />
          </label>{' '}
          <button
            type="button"
            onClick={applyCloudBrightness}
            disabled={
              Number(cloudBrightnessInputs.pivot) === cloudBrightness.pivot &&
              Number(cloudBrightnessInputs.exponent) === cloudBrightness.exponent
            }
          >
            Apply
          </button>
        </p>
        {cloudBrightnessError && <p>Cloud brightness error: {cloudBrightnessError}</p>}
        <p>
          <label>
            Haze contrast min:{' '}
            <input
              type="number"
              min="0"
              step="any"
              value={hazeContrastInputs.min}
              onChange={(event) => setHazeContrastInputs({ ...hazeContrastInputs, min: event.target.value })}
            />
          </label>{' '}
          <label>
            max:{' '}
            <input
              type="number"
              min="0"
              step="any"
              value={hazeContrastInputs.max}
              onChange={(event) => setHazeContrastInputs({ ...hazeContrastInputs, max: event.target.value })}
            />
          </label>{' '}
          <button
            type="button"
            onClick={applyHazeContrast}
            disabled={
              Number(hazeContrastInputs.min) === hazeContrast.min &&
              Number(hazeContrastInputs.max) === hazeContrast.max
            }
          >
            Apply
          </button>
        </p>
        {hazeContrastError && <p>Haze contrast error: {hazeContrastError}</p>}
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
