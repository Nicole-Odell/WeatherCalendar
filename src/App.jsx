import { memo, useEffect, useMemo, useRef, useState } from 'react';
import SkyCanvas from './SkyCanvas.jsx';
import { createStore, useStore } from './store.js';
import {
  DEFAULT_CLOUD_BRIGHTNESS,
  DEFAULT_CLOUD_GLOW,
  DEFAULT_CLOUD_LIGHTING,
  DEFAULT_HAZE_CONTRAST,
  DEFAULT_MOON,
} from './skyImage.js';
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

// Cloud cover sliders, in percent, in the order they're shown
const CLOUD_SLIDERS = [
  { name: 'total', label: 'Total' },
  { name: 'high', label: 'High (8+ km)' },
  { name: 'mid', label: 'Mid (3–8 km)' },
  { name: 'low', label: 'Low (0–3 km)' },
];

// Names shown for sun times that differ from their field names
const SUN_TIME_LABELS = {
  astronomical_twilight_begin: 'astronomical dawn',
  astronomical_twilight_end: 'astronomical dusk',
};

// Cloud lighting modes, and the lighting and glow settings each one uses
const CLOUD_LIGHTING_MODES = [
  { mode: 'blended', label: 'blended (mirrored, tinted with physical color)' },
  { mode: 'physical', label: 'physical (sunlight and skylight)' },
  { mode: 'mirrored', label: 'mirrored (pivot and exponent)' },
  { mode: 'scattering', label: 'scattering (by cloud thickness)' },
];
const LIGHTING_FIELDS = {
  reflectance: { label: 'Reflectance' },
  skylight: { label: 'Skylight' },
  colorBlend: { label: 'Color blend', max: 1 },
  forwardScattering: { label: 'Forward scattering', max: 0.99 },
  thickness: { label: 'Thickness' },
};
const LIGHTING_FIELDS_BY_MODE = {
  blended: ['reflectance', 'skylight', 'colorBlend'],
  physical: ['reflectance', 'skylight'],
  mirrored: [],
  scattering: ['skylight', 'forwardScattering', 'thickness'],
};
const GLOW_FIELDS = {
  width: 'Width',
  strength: 'Strength',
  boost: 'Boost',
  boostContrast: 'Boost contrast',
  boostSaturation: 'Boost saturation',
};
const GLOW_FIELDS_BY_MODE = {
  blended: Object.keys(GLOW_FIELDS),
  physical: Object.keys(GLOW_FIELDS),
  mirrored: Object.keys(GLOW_FIELDS),
  scattering: ['width', 'strength'],
};
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
// The time the Noon button sets, as a time input value
const NOON = '12:00';

// The sky is recalculated and redrawn this often (ms), fading in over SKY_FADE ms
const SKY_UPDATE_INTERVAL = 1000;
const SKY_FADE = 300;
// Test play steps the sky color time forward this many minutes each sky update
const PLAY_STEP_MINUTES = 1;
// How often the weather is reloaded from the server (ms). The server only
// fetches new weather every 15 minutes; this picks it up soon after.
const WEATHER_RELOAD_INTERVAL = 60 * 1000;
// Cloud motion speed, as a multiple of the normal drift
const DEFAULT_CLOUD_SPEED = 3;
const MAX_CLOUD_SPEED = 20;

const milliseconds = (value) => `${value.toFixed(1)} ms`;

// The latest sky colors from the server, and how the sky is being drawn (from
// SkyCanvas). Both change every second, so they're kept out of App's state:
// only the components that read them re-render, keeping the page quick to
// respond to taps.
const skyStore = createStore(null);
const statusStore = createStore(null);

// The sky behind the page, drawn from the latest sky colors
const LiveSkyCanvas = memo(function LiveSkyCanvas(props) {
  const sky = useStore(skyStore);
  if (!sky) return null;
  return (
    <SkyCanvas
      colors={sky.colors}
      sunlight={sky.sunlight}
      sunElevation={sky.sun.elevation}
      fadeDuration={SKY_FADE}
      onStatus={statusStore.set}
      {...props}
    />
  );
});

// Where the sun is, and the atmosphere the sky colors were calculated with
function SkyInfo() {
  const sky = useStore(skyStore);
  if (!sky) return null;
  return (
    <>
      <p>
        Clear sky toward the sun at {formatTime(sky.time)} (sun elevation{' '}
        {sky.sun.elevation.toFixed(1)}°, azimuth {sky.sun.azimuth.toFixed(1)}°)
      </p>
      {sky.atmosphere?.conditions && (
        <p>
          Atmosphere tables from {sky.atmosphere.conditions.surfacePressure} hPa,{' '}
          {sky.atmosphere.conditions.temperature} °C, haze{' '}
          {sky.atmosphere.conditions.aerosolOpticalDepth}, built{' '}
          {new Date(sky.atmosphere.builtAt).toLocaleTimeString()}
          {sky.atmosphere.rebuilding && ' (rebuilding for new weather)'}
        </p>
      )}
    </>
  );
}

// How long the last full redraw of the sky took, and how the clouds are drawn
function RenderStatus() {
  const status = useStore(statusStore);
  if (!status) return null;
  const { fullUpdate, cloudRenderer, cloudFrameMs, cpuClouds, animating, thread } = status;
  const gpuFrame = cloudFrameMs === null ? null : `${milliseconds(cloudFrameMs)} per frame on the GPU`;
  return (
    <>
      <p>
        Last full update: {milliseconds(fullUpdate.totalMs)} on the {thread} (sky and haze{' '}
        {milliseconds(fullUpdate.skyMs)}, stars {milliseconds(fullUpdate.starsMs)}
        {fullUpdate.starsRedrawn ? ', redrawn' : ', unchanged'}, moon {milliseconds(fullUpdate.moonMs)}
        {fullUpdate.moonRedrawn ? ', redrawn' : ', unchanged'}, clouds{' '}
        {milliseconds(fullUpdate.cloudsMs)}
        {fullUpdate.cloudsRedrawn ? ', redrawn' : ', unchanged'}, text color{' '}
        {milliseconds(fullUpdate.averageMs)})
      </p>
      <p>
        Clouds: {cloudRenderer}
        {cpuClouds
          ? ` (${
              cpuClouds.forced
                ? 'set by the address'
                : gpuFrame
                  ? `WebGL too slow at ${gpuFrame}`
                  : 'WebGL not available'
            }), shapes ${
              cpuClouds.shapesMs === null ? 'being worked out' : milliseconds(cpuClouds.shapesMs)
            }, colors ${cpuClouds.colorsMs === null ? '–' : milliseconds(cpuClouds.colorsMs)}`
          : gpuFrame && `, ${gpuFrame}`}
        , motion {animating ? 'on' : 'off'}
      </p>
    </>
  );
}

// Shown by the cloud speed slider when the device is too slow for motion
function CloudMotionNote() {
  const animating = useStore(statusStore)?.animating;
  return animating === false ? ' (cloud motion is off on this device)' : null;
}

// The sky colors by elevation, built only while open
function SkyColorDetails() {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Sky Color Details</summary>
      {open && <SkyColorTable />}
    </details>
  );
}

function SkyColorTable() {
  const sky = useStore(skyStore);
  if (!sky) return null;
  return (
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
  );
}

const WeatherTable = memo(function WeatherTable({ weather }) {
  return (
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
  );
});

const SunTimesTable = memo(function SunTimesTable({ sunTimes }) {
  return (
    <>
      <table>
        <tbody>
          {Object.entries(sunTimes.times).map(([field, time]) => (
            <tr key={field}>
              <th>{SUN_TIME_LABELS[field] ?? field}</th>
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
  );
});

// A number input on its own row, with its label
function NumberRow({ label, value, onChange, min = 0, max, unit }) {
  return (
    <div className="setting-row">
      <label>
        {label}:{' '}
        <input
          type="number"
          min={min}
          max={max}
          step="any"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit && ` ${unit}`}
      </label>
    </div>
  );
}

export default function App() {
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sunTimes, setSunTimes] = useState(null);
  const [sunError, setSunError] = useState(null);
  const [skyError, setSkyError] = useState(null);
  // Time the sky colors are calculated for, as "HH:MM", or '' for now
  const [skyTime, setSkyTime] = useState('');
  // What's in the time input, which only takes effect when applied
  const [skyTimeInput, setSkyTimeInput] = useState('');
  const latestSkyRequest = useRef(0);
  // Whether a sky request is waiting for its answer, so updates don't pile up
  const skyRequestPending = useRef(false);
  // How fast the clouds move, which takes effect straight away
  const [cloudSpeed, setCloudSpeed] = useState(DEFAULT_CLOUD_SPEED);
  // Whether test play is stepping the sky color time forward
  const [playing, setPlaying] = useState(false);
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
  // Whether the page's content is hidden, leaving just the sky
  const [contentHidden, setContentHidden] = useState(false);
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
  // The moon's luminance and contrast, and what's in their inputs until applied
  const [moon, setMoon] = useState(DEFAULT_MOON);
  const [moonInputs, setMoonInputs] = useState({
    luminance: String(DEFAULT_MOON.luminance),
    contrast: String(DEFAULT_MOON.contrast),
  });
  const [moonError, setMoonError] = useState(null);
  // Glow on thin cloud edges, and what's in its inputs until applied
  const [cloudGlow, setCloudGlow] = useState(DEFAULT_CLOUD_GLOW);
  const [cloudGlowInputs, setCloudGlowInputs] = useState(() =>
    Object.fromEntries(Object.entries(DEFAULT_CLOUD_GLOW).map(([name, value]) => [name, String(value)])),
  );
  const [cloudGlowError, setCloudGlowError] = useState(null);
  // How cloud bodies are lit, and what's in its inputs until applied
  const [cloudLighting, setCloudLighting] = useState(DEFAULT_CLOUD_LIGHTING);
  const [cloudLightingInputs, setCloudLightingInputs] = useState({
    mode: DEFAULT_CLOUD_LIGHTING.mode,
    reflectance: String(DEFAULT_CLOUD_LIGHTING.reflectance),
    skylight: String(DEFAULT_CLOUD_LIGHTING.skylight),
    colorBlend: String(DEFAULT_CLOUD_LIGHTING.colorBlend),
    forwardScattering: String(DEFAULT_CLOUD_LIGHTING.forwardScattering),
    thickness: String(DEFAULT_CLOUD_LIGHTING.thickness),
  });
  const [cloudLightingError, setCloudLightingError] = useState(null);

  const weatherClouds = useMemo(() => (weather ? cloudsFromWeather(weather.current) : NO_CLOUDS), [weather]);
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
    skyRequestPending.current = true;
    try {
      const query = time ? `?time=${encodeURIComponent(todayAt(time).toISOString())}` : '';
      const result = await fetchJson(`/api/sky/colors${query}`);
      // Ignore answers to earlier requests that arrive after a later one
      if (request === latestSkyRequest.current) {
        skyStore.set(result);
        setSkyError(null);
      }
    } catch (err) {
      if (request === latestSkyRequest.current) setSkyError(err.message);
    } finally {
      if (request === latestSkyRequest.current) skyRequestPending.current = false;
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

  function applyCloudLighting() {
    const values = {
      reflectance: Number(cloudLightingInputs.reflectance),
      skylight: Number(cloudLightingInputs.skylight),
      colorBlend: Number(cloudLightingInputs.colorBlend),
      forwardScattering: Number(cloudLightingInputs.forwardScattering),
      thickness: Number(cloudLightingInputs.thickness),
    };
    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) {
      setCloudLightingError('All cloud lighting values must be numbers of 0 or more.');
      return;
    }
    if (values.colorBlend > 1) {
      setCloudLightingError('Color blend must be from 0 to 1.');
      return;
    }
    if (values.forwardScattering >= 1) {
      setCloudLightingError('Forward scattering must be from 0 to below 1.');
      return;
    }
    if (values.thickness <= 0) {
      setCloudLightingError('Thickness must be more than 0.');
      return;
    }
    setCloudLightingError(null);
    setCloudLighting({ mode: cloudLightingInputs.mode, ...values });
  }

  function applyCloudGlow() {
    const values = Object.fromEntries(
      Object.entries(cloudGlowInputs).map(([name, value]) => [name, Number(value)]),
    );
    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) {
      setCloudGlowError('All values must be numbers of 0 or more.');
      return;
    }
    setCloudGlowError(null);
    setCloudGlow(values);
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

  function applyMoon() {
    const luminance = Number(moonInputs.luminance);
    const contrast = Number(moonInputs.contrast);
    if (!Number.isFinite(luminance) || !Number.isFinite(contrast) || luminance < 0 || contrast < 0) {
      setMoonError('Both values must be numbers of 0 or more.');
      return;
    }
    setMoonError(null);
    setMoon({ luminance, contrast });
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

  // Every SKY_UPDATE_INTERVAL, the sky is recalculated for the time in use
  // (stepped forward first while test play is on), unless the last update is
  // still waiting for its answer
  const skyUpdate = useRef(null);
  skyUpdate.current = () => {
    if (skyRequestPending.current) return;
    if (playing) stepSkyTime(PLAY_STEP_MINUTES);
    else loadSkyColors(skyTime);
  };
  useEffect(() => {
    const timer = setInterval(() => skyUpdate.current(), SKY_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // The weather is reloaded regularly, to pick up the server's new weather
  useEffect(() => {
    const timer = setInterval(() => loadWeather(), WEATHER_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <LiveSkyCanvas
        cloudLighting={cloudLighting}
        cloudGlow={cloudGlow}
        exposure={exposure}
        clouds={clouds}
        cloudBrightness={cloudBrightness}
        hazeContrast={hazeContrast}
        moon={moon}
        cloudSpeed={cloudSpeed}
        onTextColor={setTextColor}
      />
      <button
        type="button"
        className="content-toggle"
        style={{ color: textColor }}
        onClick={() => setContentHidden(!contentHidden)}
      >
        {contentHidden ? 'Show' : 'Hide'}
      </button>
      <main
        className="app"
        style={{ color: textColor, display: contentHidden ? 'none' : undefined }}
      >
        {weather && <WeatherTable weather={weather} />}
        {weatherError && <p>Weather error: {weatherError}</p>}
        {sunTimes && <SunTimesTable sunTimes={sunTimes} />}
        {sunError && <p>Sun times error: {sunError}</p>}
        <p>
          <label>
            Time:{' '}
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
          </button>{' '}
          <button type="button" onClick={() => applySkyTime(NOON)}>
            Noon
          </button>{' '}
          <button
            type="button"
            onClick={() => applySkyTime(toTimeValue(new Date(sunTimes.times.sunset)))}
            disabled={!sunTimes?.times.sunset}
          >
            Sunset
          </button>{' '}
          <button
            type="button"
            onClick={() => applySkyTime(toTimeValue(new Date(sunTimes.times.dusk)))}
            disabled={!sunTimes?.times.dusk}
          >
            Dusk
          </button>{' '}
          <button type="button" onClick={() => setPlaying(!playing)}>
            {playing ? 'Stop' : 'Test play'}
          </button>
        </p>
        <div className="cloud-cover">
          <h3>Cloud cover</h3>
          <div className="cloud-cover-sliders">
            {CLOUD_SLIDERS.map(({ name, label }) => (
              <label key={name} className="cloud-cover-row">
                <span>{label}</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={cloudInputs[name]}
                  onChange={(event) =>
                    setCloudInputs({ ...cloudInputs, [name]: Number(event.target.value) })
                  }
                />
                <span>{cloudInputs[name]}%</span>
              </label>
            ))}
          </div>
          <p>
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
              Cloud speed:{' '}
              <input
                type="range"
                min="0"
                max={MAX_CLOUD_SPEED}
                step="0.1"
                value={cloudSpeed}
                onChange={(event) => setCloudSpeed(Number(event.target.value))}
              />{' '}
              {cloudSpeed.toFixed(1)}×
            </label>
            <CloudMotionNote />
          </p>
        </div>
        <SkyInfo />
        {skyError && <p>Sky color error: {skyError}</p>}
        <RenderStatus />

        <details className="advanced">
          <summary>Advanced</summary>

          <h3>Sky Lighting</h3>
          <div className="setting-row">
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
          </div>
          {exposureError && <p>Exposure error: {exposureError}</p>}

          <h3>Haze</h3>
          <div className="setting-row">
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
          </div>
          {hazeContrastError && <p>Haze contrast error: {hazeContrastError}</p>}

          <h3>Moon</h3>
          <div className="setting-row">
            <label>
              Moon luminance:{' '}
              <input
                type="number"
                min="0"
                step="any"
                value={moonInputs.luminance}
                onChange={(event) => setMoonInputs({ ...moonInputs, luminance: event.target.value })}
              />{' '}
              cd/m²
            </label>{' '}
            <label>
              contrast:{' '}
              <input
                type="number"
                min="0"
                step="any"
                value={moonInputs.contrast}
                onChange={(event) => setMoonInputs({ ...moonInputs, contrast: event.target.value })}
              />
            </label>{' '}
            <button
              type="button"
              onClick={applyMoon}
              disabled={
                Number(moonInputs.luminance) === moon.luminance &&
                Number(moonInputs.contrast) === moon.contrast
              }
            >
              Apply
            </button>
          </div>
          {moonError && <p>Moon error: {moonError}</p>}

          <h3>Cloud Lighting</h3>
          <div className="setting-row">
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
          </div>
          {cloudBrightnessError && <p>Cloud brightness error: {cloudBrightnessError}</p>}
          <div className="setting-row">
            <label>
              Cloud lighting:{' '}
              <select
                value={cloudLightingInputs.mode}
                onChange={(event) =>
                  setCloudLightingInputs({ ...cloudLightingInputs, mode: event.target.value })
                }
              >
                {CLOUD_LIGHTING_MODES.map(({ mode, label }) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="indent">
            {LIGHTING_FIELDS_BY_MODE[cloudLightingInputs.mode].map((name) => (
              <NumberRow
                key={name}
                label={LIGHTING_FIELDS[name].label}
                max={LIGHTING_FIELDS[name].max}
                value={cloudLightingInputs[name]}
                onChange={(value) => setCloudLightingInputs({ ...cloudLightingInputs, [name]: value })}
              />
            ))}
            <div className="setting-row">
              <button
                type="button"
                onClick={applyCloudLighting}
                disabled={
                  cloudLightingInputs.mode === cloudLighting.mode &&
                  Object.keys(LIGHTING_FIELDS).every(
                    (name) => Number(cloudLightingInputs[name]) === cloudLighting[name],
                  )
                }
              >
                Apply
              </button>
            </div>
            {cloudLightingError && <p>Cloud lighting error: {cloudLightingError}</p>}

            <h4>Glow</h4>
            {GLOW_FIELDS_BY_MODE[cloudLightingInputs.mode].map((name) => (
              <NumberRow
                key={name}
                label={GLOW_FIELDS[name]}
                value={cloudGlowInputs[name]}
                onChange={(value) => setCloudGlowInputs({ ...cloudGlowInputs, [name]: value })}
              />
            ))}
            <div className="setting-row">
              <button
                type="button"
                onClick={applyCloudGlow}
                disabled={Object.entries(cloudGlowInputs).every(
                  ([name, value]) => Number(value) === cloudGlow[name],
                )}
              >
                Apply
              </button>
            </div>
            {cloudGlowError && <p>Cloud glow error: {cloudGlowError}</p>}
          </div>

          <SkyColorDetails />
        </details>

        <p>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </p>
      </main>
    </>
  );
}
