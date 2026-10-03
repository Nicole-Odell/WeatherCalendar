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
import weatherCodes from './weatherCodes.json';

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
// Moon settings, with labels and units
const MOON_FIELDS = {
  luminance: { label: 'Full moon luminance', unit: 'cd/m²' },
  contrast: { label: 'Contrast' },
  glow: { label: 'Glow (share of the lit surface’s luminance where it starts)' },
  glowWidth: { label: 'Glow reach', unit: 'moon radii' },
  terminatorSoftness: { label: 'Terminator softness', unit: 'moon radii' },
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

// The sky behind the page, drawn from the latest sky colors, with the moon
// where the server says it is
const LiveSkyCanvas = memo(function LiveSkyCanvas({ moon, ...props }) {
  const sky = useStore(skyStore);
  if (!sky) return null;
  return (
    <SkyCanvas
      colors={sky.colors}
      sunlight={sky.sunlight}
      sunElevation={sky.sun.elevation}
      fadeDuration={SKY_FADE}
      onStatus={statusStore.set}
      moon={{ ...moon, ...sky.moon }}
      {...props}
    />
  );
});

// Names of the moon's phases, by where its phase (0–1) is nearest
const MOON_PHASE_NAMES = [
  'new moon',
  'waxing crescent',
  'first quarter',
  'waxing gibbous',
  'full moon',
  'waning gibbous',
  'last quarter',
  'waning crescent',
];
const moonPhaseName = (phase) => MOON_PHASE_NAMES[Math.round(phase * 8) % 8];

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
      {sky.moon && (
        <p>
          Moon at {sky.moon.altitude.toFixed(1)}° altitude
          {sky.moon.phase !== null &&
            `, ${moonPhaseName(sky.moon.phase)} (${sky.moon.phase.toFixed(3)} through its cycle)`}
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
        {fullUpdate.cloudsRedrawn ? ', redrawn' : ', unchanged'})
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
// Weather code icons not yet copied into the project preview from Meteocons'
// static icons (the same source scripts/importMeteocons.mjs copies from)
const METEOCONS_PREVIEW = 'https://cdn.meteocons.com/3.0.0-next.10/svg-static/fill';
const IMPORTED_ICONS = new Set(weatherCodes.flatMap(({ icon, nightIcon }) => [icon, nightIcon]).filter(Boolean));

// weatherCodes.json's entries as the file lays them out: one per line
function weatherCodesJson(entries) {
  const lines = entries.map((entry) => {
    const fields = ['code', 'name', 'icon', 'nightIcon'].filter((key) => entry[key] !== undefined && entry[key] !== '');
    return `  { ${fields.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(entry[key])}`).join(', ')} }`;
  });
  return `[\n${lines.join(',\n')}\n]\n`;
}

// An icon named in the weather codes editor, or a note if there's none or
// it can't be found
function WeatherCodeIcon({ name }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [name]);
  if (!name) return <span className="code-icon-note">none</span>;
  if (missing) return <span className="code-icon-note">not found</span>;
  const src = IMPORTED_ICONS.has(name) ? weatherIconUrl(name) : `${METEOCONS_PREVIEW}/${name}.svg`;
  return <img className="code-icon" src={src} alt={name} onError={() => setMissing(true)} />;
}

// Every weather code with its display name and icons, built only while open
function WeatherCodesSection() {
  const [open, setOpen] = useState(false);
  return (
    <details className="advanced" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Weather Codes</summary>
      {open && <WeatherCodesEditor />}
    </details>
  );
}

/**
 * Shows each weather code's name and icons from weatherCodes.json, and lets
 * them be changed here, previewing the icons straight away. The changed file
 * is shown below the table, to copy into src/weatherCodes.json.
 */
function WeatherCodesEditor() {
  const [entries, setEntries] = useState(() => weatherCodes.map((entry) => ({ ...entry })));
  const json = weatherCodesJson(entries);
  const changed = json !== weatherCodesJson(weatherCodes);
  const update = (index, key, value) =>
    setEntries(entries.map((entry, i) => (i === index ? { ...entry, [key]: value.trim() === '' && key !== 'name' ? '' : value } : entry)));
  return (
    <>
      <p>
        Icons are{' '}
        <a href="https://meteocons.com/icons?style=fill" target="_blank" rel="noreferrer">
          Meteocons
        </a>
        , named as on that site. Codes not listed here show the not-available icon. The night icon is
        used after dark if there is one.
      </p>
      <table className="weather-codes">
        <thead>
          <tr>
            <th>code</th>
            <th>name</th>
            <th>day icon</th>
            <th>night icon</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={entry.code}>
              <td>{entry.code}</td>
              <td>
                <input
                  type="text"
                  value={entry.name}
                  onChange={(event) => update(index, 'name', event.target.value)}
                />
              </td>
              {['icon', 'nightIcon'].map((key) => (
                <td key={key}>
                  <div className="code-icon-cell">
                    <WeatherCodeIcon name={entry[key]} />
                    <input
                      type="text"
                      value={entry[key] || ''}
                      placeholder={key === 'nightIcon' ? 'same as day' : ''}
                      onChange={(event) => update(index, key, event.target.value)}
                    />
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {changed
          ? 'To use these changes, copy this into src/weatherCodes.json, then run node scripts/importMeteocons.mjs and npm run build (or ask Claude to).'
          : 'No changes yet. This is the current src/weatherCodes.json.'}
      </p>
      <textarea
        className="weather-codes-json"
        readOnly
        value={json}
        rows={Math.min(entries.length + 2, 34)}
        onFocus={(event) => event.target.select()}
      />
      <p>
        <button type="button" onClick={() => setEntries(weatherCodes.map((entry) => ({ ...entry })))} disabled={!changed}>
          Undo changes
        </button>
      </p>
    </>
  );
}

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

// Each weather code's name and icons (Meteocons, full color), from
// weatherCodes.json. Codes not listed there show UNKNOWN_ICON.
const WEATHER_CODES = new Map(weatherCodes.map((entry) => [entry.code, entry]));
const UNKNOWN_ICON = 'not-available';
// Meteocons icons, without animation (see scripts/importMeteocons.mjs): the
// weather codes' in full color, and every other icon in white
const weatherIconUrl = (name) => `/icons/meteocons/fill/${name}.svg`;
const whiteIconUrl = (name) => `/icons/meteocons/white/${name}.svg`;
// Shown in place of a value that isn't available
const MISSING = '-';

// A temperature from the weather as whole °F, or MISSING
function wholeFahrenheit(weather, field) {
  const value = weather?.current[field];
  if (typeof value !== 'number') return MISSING;
  return String(Math.round(toImperial(value, weather.units[field]).value));
}

// The date and time, updated as each minute starts
function DateAndTime({ children }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    };
    timer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    return () => clearTimeout(timer);
  }, []);
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return children({ date, time });
}

// A value with a white icon after it, as in the bottom row of the display
function ValueWithIcon({ value, icon, label }) {
  return (
    <span className="weather-detail" title={label}>
      {value}
      <img className="detail-icon" src={whiteIconUrl(icon)} alt={label} />
    </span>
  );
}

// The main display: the date, time and current weather
const WeatherDisplay = memo(function WeatherDisplay({ weather }) {
  const current = weather?.current;
  const code = current ? WEATHER_CODES.get(current.weather_code) : undefined;
  const night = current?.is_day === 0;
  const icon = (night && code?.nightIcon) || code?.icon || UNKNOWN_ICON;
  const condition = code?.name ?? (current ? `Weather code ${current.weather_code}` : MISSING);
  const aqi = typeof current?.us_aqi === 'number' ? String(Math.round(current.us_aqi)) : MISSING;
  return (
    <section className="weather-display">
      <DateAndTime>
        {({ date, time }) => (
          <>
            <div className="weather-date">{date}</div>
            <div className="weather-now">
              <img className="weather-icon" src={weatherIconUrl(icon)} alt="" />
              <div>
                <div className="weather-time">{time}</div>
                <div className="weather-condition">{condition}</div>
              </div>
            </div>
          </>
        )}
      </DateAndTime>
      <div className="weather-details">
        <span className="weather-detail" title="Feels like (actual temperature)">
          {wholeFahrenheit(weather, 'apparent_temperature')}° ({wholeFahrenheit(weather, 'temperature_2m')})
        </span>
        <ValueWithIcon value={aqi} icon="smoke" label="US Air Quality Index" />
        {/* Pollen: not available from the APIs in use for this location yet */}
        <ValueWithIcon value={MISSING} icon="pollen-flower" label="Pollen" />
      </div>
    </section>
  );
});

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
  // Whether the settings are showing, in place of the weather display
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  // The moon's settings, and what's in their inputs until applied
  const [moon, setMoon] = useState(DEFAULT_MOON);
  const [moonInputs, setMoonInputs] = useState(() =>
    Object.fromEntries(Object.entries(DEFAULT_MOON).map(([name, value]) => [name, String(value)])),
  );
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
    const values = Object.fromEntries(
      Object.entries(moonInputs).map(([name, value]) => [name, Number(value)]),
    );
    if (Object.values(values).some((value) => !Number.isFinite(value) || value < 0)) {
      setMoonError('All values must be numbers of 0 or more.');
      return;
    }
    setMoonError(null);
    setMoon(values);
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
      />
      <button
        type="button"
        className="content-toggle"
        onClick={() => setSettingsOpen(!settingsOpen)}
      >
        {settingsOpen ? 'Back' : 'Settings'}
      </button>
      {!settingsOpen && <WeatherDisplay weather={weather} />}
      <main className="app" style={{ display: settingsOpen ? undefined : 'none' }}>
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
          {Object.entries(MOON_FIELDS).map(([name, { label, unit }]) => (
            <NumberRow
              key={name}
              label={label}
              unit={unit}
              value={moonInputs[name]}
              onChange={(value) => setMoonInputs({ ...moonInputs, [name]: value })}
            />
          ))}
          <div className="setting-row">
            <button
              type="button"
              onClick={applyMoon}
              disabled={Object.entries(moonInputs).every(([name, value]) => Number(value) === moon[name])}
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

        <WeatherCodesSection />

        <p>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </p>
      </main>
    </>
  );
}
