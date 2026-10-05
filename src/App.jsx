import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import SkyCanvas from './SkyCanvas.jsx';
import { createStore, useStore } from './store.js';
import {
  DEFAULT_CLOUD_BRIGHTNESS,
  DEFAULT_CLOUD_GLOW,
  DEFAULT_CLOUD_LIGHTING,
  DEFAULT_HAZE_CONTRAST,
  DEFAULT_MOON,
  DEFAULT_STARS,
  topSkyBrightness,
} from './skyImage.js';
import { toImperial } from './units.js';
import { forecastFor } from './forecastWindow.js';
import { ICONS, MOON_PHASE_ICONS, UNKNOWN_ICON, iconClass, iconUrl } from './iconList.js';
import iconsCss from './icons.css?raw';
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

/*
 * Date and time formats, each made once and reused. toLocaleTimeString() and
 * the like make a new formatter on every call, which on the Pi 3's Chromium
 * leaves memory behind, adding up to all of the Pi's memory within hours.
 */
const shortTimeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat([], {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const displayDateFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const displayTimeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function formatTime(isoString) {
  return shortTimeFormat.format(new Date(isoString));
}

// Cloud cover sliders, in percent, in the order they're shown
// Precipitation's sliders: intensity from 0 to 100
const PRECIPITATION_SLIDERS = [
  { name: 'rain', label: 'Rain' },
  { name: 'snow', label: 'Snow' },
];
const NO_PRECIPITATION = { rain: 0, snow: 0 };

// The precipitation shown for the current weather. Not hooked up to the
// weather yet, so there's none until it's set in Settings.
function precipitationFromWeather() {
  return NO_PRECIPITATION;
}

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
// Star settings (sliders from 0 to 1), with labels
const STAR_FIELDS = {
  fullWhiteLevel: 'Full white once dark at (brightness, 1 is the brightest star; brighter ones are white too)',
  largeLevel: 'Twice as large at (brightness, 1 is only the brightest star)',
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

// The sky is recalculated and redrawn this often (ms), fading in over SKY_FADE
// ms. Live, the server streams it (see /api/sky/stream) at the same rate.
const SKY_UPDATE_INTERVAL = 1000;
const SKY_FADE = 300;
// Test play steps the sky color time forward this many minutes each sky update
const PLAY_STEP_MINUTES = 1;
// How often the weather is reloaded from the server (ms). The server only
// fetches new weather every 15 minutes; this picks it up soon after.
const WEATHER_RELOAD_INTERVAL = 60 * 1000;
// How often the forecast is reloaded (ms); the server fetches a new one every
// 15 minutes
const FORECAST_RELOAD_INTERVAL = 15 * 60 * 1000;
// How often the sun times are reloaded (ms)
const SUN_TIMES_RELOAD_INTERVAL = 60 * 60 * 1000;
// The kiosk's screen helper (kiosk/display-power.py), which answers only on
// the Pi showing the display. Anywhere else, bedtime just blacks out the page.
const SCREEN_POWER = 'http://127.0.0.1:8770/display';
// How often bedtime checks whether the sun has risen, to wake (ms)
const SUNRISE_CHECK_INTERVAL = 60 * 1000;

// Turns the kiosk's screen on or off, if this is the kiosk
async function setScreenPower(on) {
  try {
    await fetch(`${SCREEN_POWER}/${on ? 'on' : 'off'}`, { method: 'POST' });
  } catch {
    // Not on the kiosk
  }
}

// Whether the kiosk's screen is off (false if this isn't the kiosk)
async function screenIsOff() {
  try {
    const response = await fetch(SCREEN_POWER);
    return (await response.json()).on === false;
  } catch {
    return false;
  }
}
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
// where the server says it is. Cloud motion stops while `paused`.
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

// Below this on-screen brightness of the sky's top row (0–1), the corner
// buttons' shadow outlines turn white, to show against the dark
const DARK_SKY_BRIGHTNESS = 0.3;

// Marks the page with .dark-sky while the top of the sky is dark (see
// DARK_SKY_BRIGHTNESS), changing the page only when that flips
const DarkSkyMarker = memo(function DarkSkyMarker({ exposure }) {
  const sky = useStore(skyStore);
  const dark = sky
    ? topSkyBrightness({ colors: sky.colors, exposure, sunElevation: sky.sun.elevation }) < DARK_SKY_BRIGHTNESS
    : false;
  useEffect(() => {
    document.documentElement.classList.toggle('dark-sky', dark);
  }, [dark]);
  return null;
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

// The weather code for a clear sky, which at night shows the moon or stars
const CLEAR_CODE = 0;

function WeatherIcon({ icon }) {
  return <img className={`weather-icon ${iconClass(icon)}`} src={weatherIconUrl(icon)} alt="" />;
}

// A clear night's icon: the moon's phase (the nearest of Meteocons' eight)
// while it's above the horizon, else stars
function clearNightIcon(moon) {
  if (!moon || moon.phase === null || !(moon.altitude > 0)) return 'starry-night';
  return MOON_PHASE_ICONS[Math.round(moon.phase * 8) % 8];
}

// The weather icon on a clear night, following the moon in the live sky
function ClearNightIcon() {
  const sky = useStore(skyStore);
  return <WeatherIcon icon={clearNightIcon(sky && sky.moon)} />;
}

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
          {timeFormat.format(new Date(sky.atmosphere.builtAt))}
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
          ? 'To use these changes, copy this into src/weatherCodes.json, then run node scripts/importMeteocons.mjs and npm run build.'
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

// Each icon's spacing adjustments in icons.css, as { name: { margin, top,
// bottom } } (numbers, in em)
const SPACING_SIDES = ['margin', 'top', 'bottom'];
const SPACING_LABELS = { margin: 'sides', top: 'top', bottom: 'bottom' };
const spacingVariable = (side) => (side === 'margin' ? '--icon-margin' : `--icon-margin-${side}`);
const ICON_SPACING = Object.fromEntries(
  [...iconsCss.matchAll(/\.icon-([\w-]+) \{([^}]*)\}/g)].map(([, name, body]) => [
    name,
    Object.fromEntries(
      SPACING_SIDES.map((side) => {
        const match = body.match(new RegExp(`${spacingVariable(side)}: (-?[\\d.]+)(em)?;`));
        return [side, match ? Number(match[1]) : 0];
      }),
    ),
  ]),
);

// icons.css for the given spacing: its explanation, kept from the file, and a
// line for each icon in use
function iconsCssFor(spacing) {
  const header = iconsCss.slice(0, iconsCss.indexOf('*/') + 2);
  const em = (value) => `${Math.round(value * 100) / 100}em`;
  const lines = ICONS.map(({ name }) => {
    const values = SPACING_SIDES.map((side) => `${spacingVariable(side)}: ${em(spacing[name]?.[side] ?? 0)};`);
    return `.icon-${name} { ${values.join(' ')} }`;
  });
  return `${header}\n${lines.join('\n')}\n`;
}

// Every icon in use, each between text, to adjust its spacing, built only
// while open
function IconSpacingSection() {
  const [open, setOpen] = useState(false);
  return (
    <details className="advanced" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Icon Spacing</summary>
      {open && <IconSpacingEditor />}
    </details>
  );
}

/**
 * Shows each icon the display uses between white boxes (standing in for
 * text), with no
 * margins but its own adjustments, at its size on the display relative to the
 * text beside it. White bars run between the icons (and above the first and
 * below the last), so their top and bottom edges show. The adjustments can be
 * changed here, showing straight away, and the changed icons.css is shown
 * below, to copy into src/icons.css.
 */
function IconSpacingEditor() {
  const [spacing, setSpacing] = useState(ICON_SPACING);
  const initialInputs = () =>
    Object.fromEntries(
      ICONS.map(({ name }) => [
        name,
        Object.fromEntries(SPACING_SIDES.map((side) => [side, String(ICON_SPACING[name]?.[side] ?? 0)])),
      ]),
    );
  const [inputs, setInputs] = useState(initialInputs);
  const [fontSize, setFontSize] = useState('48');
  const css = iconsCssFor(spacing);
  const changed = css !== iconsCssFor(ICON_SPACING);
  const update = (name, side, value) => {
    setInputs({ ...inputs, [name]: { ...inputs[name], [side]: value } });
    const number = Number(value);
    if (value.trim() !== '' && Number.isFinite(number)) {
      setSpacing({ ...spacing, [name]: { margin: 0, top: 0, bottom: 0, ...spacing[name], [side]: number } });
    }
  };
  const groups = [...new Set(ICONS.map(({ use }) => use))];
  return (
    <>
      <p>
        Each icon sits between white boxes (standing in for text) and white bars with only its own adjustments,
        in em of the text beside it (negative pulls them in). Changes show straight away.
      </p>
      <p>
        <label>
          Sample size:{' '}
          <input type="number" min="8" step="1" value={fontSize} onChange={(event) => setFontSize(event.target.value)} />{' '}
          px
        </label>
      </p>
      {groups.map((use) => (
        <div key={use}>
          <h4>{use}</h4>
          <div className="icon-spacing">
            <div className="icon-spacing-bar" />
            {ICONS.filter((icon) => icon.use === use).map(({ name, style, size }) => (
              <Fragment key={name}>
                <div className="icon-spacing-row">
                  <span className="icon-spacing-name">{name}</span>
                  <span className="icon-spacing-sample" style={{ fontSize: `${Number(fontSize) || 48}px` }}>
                    <span className="icon-spacing-box" />
                    <img
                      className={iconClass(name)}
                      src={iconUrl(name, style)}
                      alt={name}
                      style={{
                        width: `${size}em`,
                        height: `${size}em`,
                        ...Object.fromEntries(
                          SPACING_SIDES.map((side) => [spacingVariable(side), `${spacing[name]?.[side] ?? 0}em`]),
                        ),
                      }}
                    />
                    <span className="icon-spacing-box" />
                  </span>
                  <span className="icon-spacing-fields">
                    {SPACING_SIDES.map((side) => (
                      <label key={side} className="icon-spacing-field">
                        {SPACING_LABELS[side]}{' '}
                        <input
                          type="number"
                          step="0.01"
                          value={inputs[name][side]}
                          onChange={(event) => update(name, side, event.target.value)}
                        />{' '}
                        em
                      </label>
                    ))}
                  </span>
                </div>
                <div className="icon-spacing-bar" />
              </Fragment>
            ))}
          </div>
        </div>
      ))}
      <p>
        {changed
          ? 'To keep these, copy this into src/icons.css, then run npm run deploy.'
          : 'No changes yet. This is the current src/icons.css.'}
      </p>
      <textarea
        className="weather-codes-json"
        readOnly
        value={css}
        rows={12}
        onFocus={(event) => event.target.select()}
      />
      <p>
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            setSpacing(ICON_SPACING);
            setInputs(initialInputs());
          }}
        >
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
// Meteocons icons (see iconList.js): full color, and one-color in white
const weatherIconUrl = (name) => iconUrl(name, 'fill');
const whiteIconUrl = (name) => iconUrl(name, 'white');
// Shown in place of a value that isn't available
const MISSING = '*';

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
  const date = displayDateFormat.format(now);
  const time = displayTimeFormat.format(now).toLowerCase();
  return children({ date, time, now });
}

// The US Air Quality Index's categories (the EPA's scale): the highest AQI
// in each, its standard color, and its icon (shown in that color)
const AQI_CATEGORIES = [
  { upTo: 50, name: 'Good', color: '#00E400', icon: 'barometer-low' },
  { upTo: 100, name: 'Moderate', color: '#FFFF00', icon: 'barometer-moderate' },
  { upTo: 150, name: 'Unhealthy for Sensitive Groups', color: '#FF7E00', icon: 'barometer-high' },
  { upTo: 200, name: 'Unhealthy', color: '#FF0000', icon: 'barometer-very-high' },
  { upTo: 300, name: 'Very Unhealthy', color: '#8F3F97', icon: 'barometer-extreme' },
  { upTo: Infinity, name: 'Hazardous', color: '#7E0023', icon: 'barometer-extreme' },
];
const aqiCategory = (aqi) => AQI_CATEGORIES.find((category) => aqi <= category.upTo);

/**
 * A value with an icon after it, as in the bottom row of the display: the
 * full-color icon, or with `color`, the one-color icon in that color (along
 * with the value)
 */
function ValueWithIcon({ value, icon, label, color }) {
  return (
    <span className="weather-detail" title={label} style={color ? { color } : undefined}>
      {value}
      {color ? (
        <ColoredIcon icon={icon} color={color} label={label} />
      ) : (
        <img className={`detail-icon ${iconClass(icon)}`} src={weatherIconUrl(icon)} alt={label} />
      )}
    </span>
  );
}

// A one-color icon in `color`: the icon as a mask over the color. The shadow
// is on a wrapper, as the mask would hide a shadow on the icon itself.
function ColoredIcon({ icon, color, label, className = 'detail-icon' }) {
  return (
    <span className="detail-icon-shadow" role="img" aria-label={label}>
      <span
        className={`${className} colored-icon ${iconClass(icon)}`}
        style={{
          backgroundColor: color,
          WebkitMaskImage: `url(${whiteIconUrl(icon)})`,
          maskImage: `url(${whiteIconUrl(icon)})`,
        }}
      />
    </span>
  );
}

// The humidity icon's color: the blue of the raindrop icon
const HUMIDITY_COLOR = '#2563eb';

// The Beaufort scale: the lowest wind speed (m/s) of each force, 0 to 12
const BEAUFORT_SPEEDS = [0, 0.5, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
const beaufortForce = (speed) => BEAUFORT_SPEEDS.filter((lowest) => speed >= lowest).length - 1;

// Humidity and wind, beside the temperature: each an icon with its value after
// it. The wind is shown in mph; its icon shows its force on the Beaufort scale
// (worked out in m/s).
function HumidityAndWind({ weather }) {
  const current = weather?.current;
  const humidity = current?.relative_humidity_2m;
  const windKmh = current?.wind_speed_10m;
  const wind = typeof windKmh === 'number' ? windKmh / 3.6 : null;
  if (typeof humidity !== 'number' && wind === null) return null;
  return (
    <div className="humidity">
      {typeof humidity === 'number' && (
        <div className="side-detail" title="Humidity">
          <ColoredIcon icon="smoke-particles" color={HUMIDITY_COLOR} label="Humidity" />
          <span>{Math.round(humidity)}%</span>
        </div>
      )}
      {wind !== null && (
        <div className="side-detail" title={`Wind: force ${beaufortForce(wind)} on the Beaufort scale`}>
          <img
            className={`detail-icon ${iconClass(`wind-beaufort-${beaufortForce(wind)}`)}`}
            src={weatherIconUrl(`wind-beaufort-${beaufortForce(wind)}`)}
            alt={`Wind force ${beaufortForce(wind)}`}
          />
          <span>
            {toImperial(windKmh, 'km/h').value.toFixed(1)}
            <span className="wind-unit">mph</span>
          </span>
        </div>
      )}
    </div>
  );
}

// The main display: the date, time and current weather
// Pollen categories in the order they're shown, and each level's icon name
// and label (level 0, none, shows no icon)
const POLLEN_CATEGORIES = [
  { key: 'grass', name: 'Grass' },
  { key: 'tree', name: 'Tree' },
  { key: 'weed', name: 'Weed' },
];
const POLLEN_LEVELS = [null, { icon: 'low', name: 'Low' }, { icon: 'moderate', name: 'Moderate' }, { icon: 'high', name: 'High' }, { icon: 'very-high', name: 'Very High' }];

// The current UV index's icon, showing its number (11-plus above 11), or
// nothing when it's 0 (Meteocons has no icon for 0)
function UvIcon({ uvIndex }) {
  const uv = typeof uvIndex === 'number' ? Math.round(uvIndex) : 0;
  if (uv <= 0) return null;
  const icon = uv > 11 ? 'uv-index-11-plus' : `uv-index-${uv}`;
  return (
    <span className="weather-detail">
      <img
        className={`detail-icon ${iconClass(icon)}`}
        src={weatherIconUrl(icon)}
        alt={`UV index ${uv}`}
        title={`UV index: ${uv}`}
      />
    </span>
  );
}

// The lowest pollen level shown: low pollen (level 1) is nearly always there
const POLLEN_MIN_LEVEL = 2;

// A pollen icon for each category with at least POLLEN_MIN_LEVEL of pollen
// (from /api/pollen), or nothing at all if none has
function PollenIcons({ pollen }) {
  const shown = POLLEN_CATEGORIES.filter(({ key }) => pollen?.levels[key] >= POLLEN_MIN_LEVEL);
  if (shown.length === 0) return null;
  return (
    <span className="weather-detail pollen-icons">
      {shown.map(({ key, name }) => {
        const level = POLLEN_LEVELS[pollen.levels[key]];
        const label = `${name} pollen: ${level.name}`;
        return (
          <img
            key={key}
            className={`detail-icon ${iconClass(`pollen-${key}-${level.icon}`)}`}
            src={weatherIconUrl(`pollen-${key}-${level.icon}`)}
            alt={label}
            title={label}
          />
        );
      })}
    </span>
  );
}

// A sunrise or sunset: its astronomical dawn or dusk time, then its icon with
// its time underneath, and anything else (`children`) below that
function SunEvent({ event, children }) {
  if (!event) return <div className="sun-event" />;
  const name = event.type === 'sunrise' ? 'Sunrise' : 'Sunset';
  return (
    <div className="sun-event" title={name}>
      {event.twilight && (
        <div className="sun-event-twilight" title={event.type === 'sunrise' ? 'Astronomical dawn' : 'Astronomical dusk'}>
          {displayTimeFormat.format(new Date(event.twilight)).toLowerCase()}
        </div>
      )}
      <img className={`sun-event-icon ${iconClass(event.type)}`} src={whiteIconUrl(event.type)} alt={name} />
      <div>{displayTimeFormat.format(new Date(event.time)).toLowerCase()}</div>
      {children}
    </div>
  );
}

// The next moonrise or moonset from `events` (see
// TimeOfDayManager.GetMoonEvents), checked again as each one passes
function useNextEvent(events) {
  const [now, setNow] = useState(() => Date.now());
  const next = (events || []).find(({ time }) => Date.parse(time) > now);
  useEffect(() => {
    if (!next) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(next.time) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [next && next.time]);
  // New events are checked against the time now
  useEffect(() => setNow(Date.now()), [events]);
  return next;
}

// The next moonrise or moonset, like the sun events: its icon (the size of
// the weather details' icons) with its time under it (the size of the
// astronomical dawn and dusk times)
function MoonEvent({ moonEvents }) {
  const event = useNextEvent(moonEvents && moonEvents.events);
  if (!event) return null;
  const name = event.type === 'moonrise' ? 'Moonrise' : 'Moonset';
  return (
    <div className="moon-event" title={name}>
      <img className={`moon-event-icon ${iconClass(event.type)}`} src={whiteIconUrl(event.type)} alt={name} />
      <div className="moon-event-time">{displayTimeFormat.format(new Date(event.time)).toLowerCase()}</div>
    </div>
  );
}

// The forecast from now until the next sun event: the high over the low like
// a fraction, a bar, then the kind of precipitation's icon beside its chance, with
// the amount under both, right-aligned
function ForecastUntil({ forecast, now, until }) {
  const span = until ? forecastFor(forecast, now.getTime(), Date.parse(until.time)) : null;
  if (!span) return null;
  const fahrenheit = (celsius) => (celsius === null ? MISSING : Math.round(toImperial(celsius, '°C').value));
  const inches = toImperial(span.precipitation, 'mm').value.toFixed(1);
  const chance = span.precipitationChance === null ? MISSING : `${Math.round(span.precipitationChance * 100)}%`;
  return (
    <div className="sun-event-forecast">
      <div className="high-low" title="High and low">
        <div>{fahrenheit(span.high)}°</div>
        <div className="high-low-bar" />
        <div>{fahrenheit(span.low)}°</div>
      </div>
      <span className="forecast-divider" />
      {/* The raindrop and chance, with the amount under them, right-aligned;
          with no amount, they're centered in the row */}
      <div className="forecast-rain">
        <div className="forecast-chance">
          {span.precipitationIcon === 'drizzle' ? (
            <ColoredIcon icon="smoke-particles" color={HUMIDITY_COLOR} label="Drizzle" className="forecast-icon" />
          ) : (
            <img
              className={`forecast-icon ${iconClass(span.precipitationIcon)}`}
              src={weatherIconUrl(span.precipitationIcon)}
              alt="Precipitation"
            />
          )}
          <span title="Chance of precipitation">{chance}</span>
        </div>
        {/* Hidden when none is forecast */}
        {inches !== '0.0' && <div title="Precipitation">{inches} in</div>}
      </div>
    </div>
  );
}

// The last sunrise or sunset before `now` and the next one after it, from
// the sun times' events (yesterday to tomorrow)
function sunEventsAround(sunTimes, now) {
  const events = sunTimes?.events ?? [];
  const next = events.findIndex(({ time }) => Date.parse(time) > now.getTime());
  if (next === -1) return { last: events[events.length - 1], next: undefined };
  return { last: events[next - 1], next: events[next] };
}

// Whether it's night: between sunset and sunrise, by the sun times, checked
// again at each sunrise and sunset. Before the sun times load, it's the
// weather's own day or night flag.
function useNight(sunTimes, weather) {
  const [now, setNow] = useState(() => new Date());
  const { last, next } = sunEventsAround(sunTimes, now);
  useEffect(() => {
    if (!next) return undefined;
    // (a moment after the event, so it counts as passed)
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, Date.parse(next.time) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [next && next.time]);
  // New sun times are checked against the time now
  useEffect(() => setNow(new Date()), [sunTimes]);
  if (last) return last.type === 'sunset';
  if (next) return next.type === 'sunrise';
  return weather?.current?.is_day === 0;
}

const WeatherDisplay = memo(function WeatherDisplay({ weather, pollen, sunTimes, moonEvents, forecast }) {
  const current = weather?.current;
  const code = current ? WEATHER_CODES.get(current.weather_code) : undefined;
  const night = useNight(sunTimes, weather);
  const icon = (night && code?.nightIcon) || code?.icon || UNKNOWN_ICON;
  const clearNight = night && current?.weather_code === CLEAR_CODE;
  const condition = code?.name ?? (current ? `Weather code ${current.weather_code}` : MISSING);
  const aqi = typeof current?.us_aqi === 'number' ? Math.round(current.us_aqi) : null;
  return (
    <section className="weather-display">
      <DateAndTime>
        {({ date, time, now }) => {
          const { last, next } = sunEventsAround(sunTimes, now);
          return (
            <>
              <div className="weather-date">{date}</div>
              {/* The time, between the last sunrise or sunset and the next one */}
              <div className="time-row">
                <SunEvent event={last} />
                <div className="weather-time">{time}</div>
                <SunEvent event={next} />
              </div>
              {/* The forecast until the next sun event, under it */}
              <div className="forecast-row">
                <div className="forecast-slot">
                  <ForecastUntil forecast={forecast} now={now} until={next} />
                </div>
              </div>
            </>
          );
        }}
      </DateAndTime>
      <div className="weather-condition">{condition}</div>
      {/* The temperature's number centered on the screen, with the moon
          event and weather icon to its left and the rest to its right */}
      <div className="weather-now">
        <div className="weather-now-left">
          <MoonEvent moonEvents={moonEvents} />
          {clearNight ? <ClearNightIcon /> : <WeatherIcon icon={icon} />}
        </div>
        <div className="weather-temperature">
          <span className="temperature-value" title="Feels like">
            {wholeFahrenheit(weather, 'apparent_temperature')}
          </span>
          {/* The unit, then humidity and wind beside it */}
          <div className="weather-temperature-side">
            <img className={`temperature-unit ${iconClass('fahrenheit')}`} src={whiteIconUrl('fahrenheit')} alt="°F" />
            <HumidityAndWind weather={weather} />
          </div>
        </div>
        <div className="weather-now-right" />
      </div>
      <div className="weather-details">
        <UvIcon uvIndex={current?.uv_index} />
        {/* Hidden when there's no AQI */}
        {aqi !== null && (
          <ValueWithIcon
            value={aqi}
            icon={aqiCategory(aqi).icon}
            label={`US Air Quality Index: ${aqiCategory(aqi).name}`}
            color={aqiCategory(aqi).color}
          />
        )}
        <PollenIcons pollen={pollen} />
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
      <p>Last updated: {dateTimeFormat.format(new Date(weather.fetchedAt))}</p>
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
// A slider, marking how far along it is (--fill) so its track can show the
// filled part (see index.css)
function RangeInput({ min = 0, max = 100, value, ...props }) {
  const fill = (100 * (Number(value) - Number(min))) / (Number(max) - Number(min) || 1);
  return <input type="range" min={min} max={max} value={value} style={{ '--fill': `${fill}%` }} {...props} />;
}

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
  // The next two days' moonrises and moonsets (see server/TimeOfDayManager.js)
  const [moonEvents, setMoonEvents] = useState(null);
  // Today's pollen levels, from pollen.com (see server/PollenManager.js)
  const [pollen, setPollen] = useState(null);
  // The forecast for the next two days (see server/ForecastManager.js)
  const [forecast, setForecast] = useState(null);
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
  // Rain and snow set in Settings, or null to follow the weather
  const [precipitationOverride, setPrecipitationOverride] = useState(null);
  const [cloudInputs, setCloudInputs] = useState(NO_CLOUDS);
  // Whether the settings are showing, in place of the weather display
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Whether everything but the sky and the eye and bedtime buttons is hidden
  const [uiHidden, setUiHidden] = useState(false);
  // Bedtime: the screen is off (on the kiosk) and the page is covered in
  // black, with the per-second sky updates and cloud motion paused, until a
  // tap or sunrise wakes it. Weather updates carry on.
  const [asleep, setAsleep] = useState(false);
  const asleepSince = useRef(0);
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
  // The stars' settings, which sliders change straight away
  const [stars, setStars] = useState(DEFAULT_STARS);
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
  const weatherPrecipitation = useMemo(() => precipitationFromWeather(weather && weather.current), [weather]);
  const precipitation = precipitationOverride || weatherPrecipitation;

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

  // The forecast is only shown when it loads, so a failure just leaves it out
  async function loadForecast() {
    try {
      setForecast(await fetchJson('/api/forecast'));
    } catch (err) {
      console.warn('Forecast unavailable:', err.message);
    }
  }

  // Pollen is only shown when it loads, so a failure just leaves it out
  async function loadPollen() {
    try {
      setPollen(await fetchJson('/api/pollen'));
    } catch (err) {
      console.warn('Pollen unavailable:', err.message);
    }
  }

  async function loadSunTimes() {
    setSunError(null);
    try {
      setSunTimes(await fetchJson('/api/time-of-day/sun-times'));
    } catch (err) {
      setSunError(err.message);
    }
    // Moonrise and moonset are worked out on the server, so they load with
    // the sun times; a failure just leaves them out
    try {
      setMoonEvents(await fetchJson('/api/time-of-day/moon-events'));
    } catch (err) {
      console.warn('Moon events unavailable:', err.message);
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
    loadPollen();
    loadForecast();
    loadSunTimes();
  }, []);

  function goToSleep() {
    asleepSince.current = Date.now();
    // Everything shows again on waking
    setUiHidden(false);
    setAsleep(true);
    setScreenPower(false);
  }

  // Shows the page again, caught up straight away
  function wake() {
    setAsleep(false);
    setScreenPower(true);
    loadSkyColors(skyTime);
    loadWeather();
  }
  const wakeRef = useRef(null);
  wakeRef.current = wake;

  // A page loaded while the kiosk's screen is off (say, reloaded overnight)
  // starts in bedtime, so a tap still wakes it
  useEffect(() => {
    screenIsOff().then((off) => {
      if (off) {
        asleepSince.current = Date.now();
        setAsleep(true);
      }
    });
  }, []);

  // In bedtime, wakes at the first sunrise after going to sleep
  useEffect(() => {
    if (!asleep) return undefined;
    const check = async () => {
      try {
        const { times } = await fetchJson('/api/time-of-day/sun-times');
        const sunrise = Date.parse(times.sunrise);
        if (sunrise > asleepSince.current && Date.now() >= sunrise) wakeRef.current();
      } catch {
        // Tried again at the next check
      }
    };
    const timer = setInterval(check, SUNRISE_CHECK_INTERVAL);
    return () => clearInterval(timer);
  }, [asleep]);

  // Live (the sky for now, while awake and not testing), the sky comes from
  // the server's stream: one long-lived connection, as on the Pi 3's Chromium
  // a request every second leaks memory. Test times in Settings fetch it.
  const streaming = !asleep && !playing && skyTime === '';
  useEffect(() => {
    if (!streaming) return undefined;
    const source = new EventSource('/api/sky/stream');
    source.onmessage = (event) => {
      // Overrides any fetch for a test time still under way
      latestSkyRequest.current++;
      skyRequestPending.current = false;
      skyStore.set(JSON.parse(event.data));
      setSkyError(null);
    };
    // The browser reconnects by itself
    source.onerror = () => setSkyError('The live sky updates were interrupted; reconnecting');
    return () => source.close();
  }, [streaming]);

  // Every SKY_UPDATE_INTERVAL while testing, the sky is fetched for the time in
  // use (stepped forward first while test play is on), unless the last fetch
  // is still waiting for its answer or it's bedtime
  const skyUpdate = useRef(null);
  skyUpdate.current = () => {
    if (asleep || streaming || skyRequestPending.current) return;
    if (playing) stepSkyTime(PLAY_STEP_MINUTES);
    else loadSkyColors(skyTime);
  };
  useEffect(() => {
    const timer = setInterval(() => skyUpdate.current(), SKY_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // The forecast is reloaded as often as the server fetches a new one
  useEffect(() => {
    const timer = setInterval(() => loadForecast(), FORECAST_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // The sun times are reloaded hourly, so the last and next sunrise and sunset
  // stay current from day to day
  useEffect(() => {
    const timer = setInterval(() => loadSunTimes(), SUN_TIMES_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // The weather and pollen are reloaded regularly, to pick up the server's new
  // data (the server only fetches new pollen hourly)
  useEffect(() => {
    const timer = setInterval(() => {
      loadWeather();
      loadPollen();
    }, WEATHER_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <DarkSkyMarker exposure={exposure} />
      <LiveSkyCanvas
        cloudLighting={cloudLighting}
        cloudGlow={cloudGlow}
        exposure={exposure}
        clouds={clouds}
        cloudBrightness={cloudBrightness}
        hazeContrast={hazeContrast}
        moon={moon}
        stars={stars}
        cloudSpeed={cloudSpeed}
        paused={asleep}
        precipitation={precipitation}
      />
      {!uiHidden && (
        <button
          type="button"
          className="corner-button symbol-button content-toggle"
          onClick={() => setSettingsOpen(!settingsOpen)}
          title={settingsOpen ? 'Back' : 'Settings'}
        >
          {settingsOpen ? '\u2190' : '\u2699'}
        </button>
      )}
      {/* Hides everything else but bedtime, leaving just the sky; crossed out while hidden */}
      <button
        type="button"
        className={`corner-button symbol-button visibility-toggle${uiHidden ? ' crossed-out' : ''}`}
        onClick={() => setUiHidden(!uiHidden)}
        title={uiHidden ? 'Show everything' : 'Show just the sky'}
      >
        {'\u{1F441}'}
      </button>
      <button type="button" className="corner-button bedtime-toggle" onClick={goToSleep} title="Bedtime">
        <img className={iconClass('bedtime-mode')} src={whiteIconUrl('bedtime-mode')} alt="Bedtime: turn the screen off" />
      </button>
      {/* In bedtime, covers everything, so the tap that wakes the page doesn't
          also press what's under it */}
      {asleep && <div className="bedtime-overlay" onClick={wake} />}
      {!settingsOpen && !uiHidden && (
        <WeatherDisplay
          weather={weather}
          pollen={pollen}
          sunTimes={sunTimes}
          moonEvents={moonEvents}
          forecast={forecast}
        />
      )}
      <main className="app" style={{ display: settingsOpen && !uiHidden ? undefined : 'none' }}>
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
                <RangeInput
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
              <RangeInput
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
        <div className="cloud-cover">
          <h3>Precipitation</h3>
          <div className="cloud-cover-sliders">
            {PRECIPITATION_SLIDERS.map(({ name, label }) => (
              <label key={name} className="cloud-cover-row">
                <span>{label}</span>
                <RangeInput
                  min="0"
                  max="100"
                  step="1"
                  value={precipitation[name]}
                  onChange={(event) =>
                    setPrecipitationOverride({ ...precipitation, [name]: Number(event.target.value) })
                  }
                />
                <span>{precipitation[name]}%</span>
              </label>
            ))}
          </div>
          <p>
            <button type="button" onClick={() => setPrecipitationOverride(null)} disabled={!precipitationOverride}>
              Now
            </button>
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

          <h3>Stars</h3>
          {Object.entries(STAR_FIELDS).map(([name, label]) => (
            <div className="setting-row" key={name}>
              <label>
                {label}:{' '}
                <RangeInput
                  min="0"
                  max="1"
                  step="0.01"
                  value={stars[name]}
                  onChange={(event) => setStars({ ...stars, [name]: Number(event.target.value) })}
                />{' '}
                {stars[name].toFixed(2)}
              </label>
            </div>
          ))}

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
        <IconSpacingSection />

        <p>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </p>
      </main>
    </>
  );
}
