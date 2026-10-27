import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import SkyCanvas from './SkyCanvas.jsx';
import { createStore, useStore } from './store.js';
import {
  CLOUD_DARKNESS_TYPICAL,
  DEFAULT_CLOUD_BRIGHTNESS,
  DEFAULT_CLOUD_GLOW,
  DEFAULT_CLOUD_LIGHTING,
  DEFAULT_HAZE_CONTRAST,
  DEFAULT_MOON,
  DEFAULT_STARS,
  overcastOf,
  skyBrightnessAt,
  topSkyBrightness,
} from './skyImage.js';
import { toImperial } from './units.js';
import { forecastFor } from './forecastWindow.js';
import { FLAVORS, DEFAULT_FLAVOR, applyFlavor } from './flavor.js';
import {
  BACK_ICON,
  CUSTOM_TASK_ICONS,
  DAY_BACK_ICON,
  DAY_ON_ICON,
  ADD_ICON,
  BRIGHTNESS_HIGH_ICON,
  BRIGHTNESS_LOW_ICON,
  DELETE_ICON,
  POWER_ICON,
  REFRESH_ICON,
  ICONS,
  MOON_PHASE_ICONS,
  SETTINGS_ICON,
  SHOW_ALL_ICON,
  SHOW_SKY_ICON,
  UNKNOWN_ICON,
  iconClass,
  iconUrl,
} from './iconList.js';
import iconsCss from './icons.css?raw';
import weatherCodes from './weatherCodes.json';

const luminanceFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });

// Default exposure for the sky gradient, as luminance in cd/m². The floor is
// shown as black, and full brightness is at least the ceiling.
const DEFAULT_EXPOSURE = { floor: 0.0001, ceiling: 15000 };

async function fetchJson(url, options) {
  const response = await fetch(url, options);
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

// Weather codes (WMO) that mean rain (drizzle, rain, freezing rain, showers,
// thunderstorms) or snow (snow, snow grains, snow showers)
const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
// Precipitation's intensity (0–100) runs from PRECIPITATION_LEAST, for any
// at all (or a code saying there's some), to 100 at these rates: heavy rain
// (mm an hour) and heavy snow (cm an hour). Rain's only reaches
// RAIN_STEADY_MOST from how much falls (rain and showers together); the rest
// comes from showers (bursts of heavier rain), by their rate up to heavy.
const PRECIPITATION_LEAST = 20;
const HEAVY_RAIN = 7.6;
const HEAVY_SNOW = 4;
const RAIN_STEADY_MOST = 85;

// The precipitation shown for the current weather (Open-Meteo's current
// conditions, whose amounts are over its `interval`), as { rain, snow }
// intensities, each only if `show` has it on
function precipitationFromWeather(current, show) {
  if (!current) return NO_PRECIPITATION;
  const perHour = 3600 / (current.interval || 900);
  // From PRECIPITATION_LEAST to `most` as `rate` goes up to `heavy`
  const intensity = (rate, heavy, coded, most = 100) =>
    rate > 0
      ? Math.min(most, PRECIPITATION_LEAST + ((most - PRECIPITATION_LEAST) * rate) / heavy)
      : coded
        ? PRECIPITATION_LEAST
        : 0;
  const code = current.weather_code;
  const showers = (current.showers || 0) * perHour;
  const rain =
    intensity((current.rain || 0) * perHour + showers, HEAVY_RAIN, RAIN_CODES.includes(code), RAIN_STEADY_MOST) +
    (100 - RAIN_STEADY_MOST) * Math.min(1, showers / HEAVY_RAIN);
  return {
    rain: show.rain ? Math.round(rain) : 0,
    snow: show.snow ? Math.round(intensity((current.snowfall || 0) * perHour, HEAVY_SNOW, SNOW_CODES.includes(code))) : 0,
  };
}

const CLOUD_SLIDERS = [
  { name: 'total', label: 'Total' },
  { name: 'high', label: 'High (8+ km)' },
  { name: 'mid', label: 'Mid (3–8 km)' },
  { name: 'low', label: 'Low (0–3 km)' },
  // (how dark the clouds are, see cloud_darkness in server/WeatherManager.js)
  { name: 'darkness', label: 'Darkness' },
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
const NO_CLOUDS = { total: 0, low: 0, mid: 0, high: 0, darkness: CLOUD_DARKNESS_TYPICAL };

function cloudsFromWeather(current) {
  return {
    total: current.cloud_cover ?? 0,
    low: current.cloud_cover_low ?? 0,
    mid: current.cloud_cover_mid ?? 0,
    high: current.cloud_cover_high ?? 0,
    darkness: current.cloud_darkness != null ? Math.round(current.cloud_darkness * 100) : CLOUD_DARKNESS_TYPICAL,
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

// The time the Night button sets: midnight, or if astronomical dusk (when
// the sky is fully dark) comes after it, NIGHT_AFTER_DUSK_MINUTES after that.
// `times` is the sun times' times for the day.
const NIGHT_AFTER_DUSK_MINUTES = 15;
function nightTime(times) {
  const sunset = new Date(times.sunset);
  const midnight = new Date(sunset);
  midnight.setHours(24, 0, 0, 0);
  if (!times.astronomical_twilight_end) return '00:00';
  const dusk = new Date(times.astronomical_twilight_end);
  // (a dusk given before sunset is past midnight, the next day)
  if (dusk < sunset) dusk.setDate(dusk.getDate() + 1);
  if (dusk <= midnight) return '00:00';
  return toTimeValue(new Date(dusk.getTime() + NIGHT_AFTER_DUSK_MINUTES * 60 * 1000));
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
const DEFAULT_CLOUD_SPEED = 0.5;
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
// The sky's light behind the panels (--sky-light on the page, 0 at night to
// 1 by day), which the Glass flavor's colors follow: the on-screen
// brightness of the sky at the middle of the screen, as a share of
// SKY_LIGHT_FULL (and full beyond it), in steps of SKY_LIGHT_STEP, so the
// panels are only repainted (each change repaints them) when it's moved
// enough to see: rarely by day and at night, every minute or so at dusk
const SKY_LIGHT_FULL = 0.75;
// How much the sky's color behind the pop-up panels must change before
// their fills are updated
const SKY_COLOR_STEP = 4;
const SKY_LIGHT_STEP = 0.02;
// How overcast it is by day (--sky-overcast on the page, 0 up), which tints
// the Glass panels dark, so they're a little dimmer than an overcast sky
// rather than brighter: the cloud cover from SKY_OVERCAST_START (0) to 100%
// (1), times the sky's light (see --sky-light), so not at night, and by how
// dark the clouds are: SKY_OVERCAST_SHADE.typical times at the typical
// darkness (see CLOUD_DARKNESS_TYPICAL), moving to .brightest at 0 and
// .darkest at 100
const SKY_OVERCAST_START = 50;
const SKY_OVERCAST_SHADE = { brightest: 0.75, typical: 1, darkest: 1.2 };

const DarkSkyMarker = memo(function DarkSkyMarker({ exposure, cloudCover = 0, cloudDarkness = CLOUD_DARKNESS_TYPICAL }) {
  const sky = useStore(skyStore);
  const scene = sky && { colors: sky.colors, exposure, sunElevation: sky.sun.elevation };
  const dark = scene ? topSkyBrightness(scene) < DARK_SKY_BRIGHTNESS : false;
  const exactLight = scene ? Math.min(1, skyBrightnessAt(scene, 0.5) / SKY_LIGHT_FULL) : 1;
  const light = Math.round(exactLight / SKY_LIGHT_STEP) * SKY_LIGHT_STEP;
  const cover = Math.min(1, Math.max(0, (cloudCover - SKY_OVERCAST_START) / (100 - SKY_OVERCAST_START)));
  const shade =
    cloudDarkness < CLOUD_DARKNESS_TYPICAL
      ? SKY_OVERCAST_SHADE.brightest +
        ((SKY_OVERCAST_SHADE.typical - SKY_OVERCAST_SHADE.brightest) * cloudDarkness) / CLOUD_DARKNESS_TYPICAL
      : SKY_OVERCAST_SHADE.typical +
        ((SKY_OVERCAST_SHADE.darkest - SKY_OVERCAST_SHADE.typical) * (cloudDarkness - CLOUD_DARKNESS_TYPICAL)) /
          (100 - CLOUD_DARKNESS_TYPICAL);
  const overcast = Math.round((cover * exactLight * shade) / SKY_LIGHT_STEP) * SKY_LIGHT_STEP;
  useEffect(() => {
    document.documentElement.classList.toggle('dark-sky', dark);
  }, [dark]);
  useEffect(() => {
    document.documentElement.style.setProperty('--sky-light', light.toFixed(2));
  }, [light]);
  useEffect(() => {
    document.documentElement.style.setProperty('--sky-overcast', overcast.toFixed(2));
  }, [overcast]);
  // The sky's color as seen (with the haze over it) where the pop-up panels
  // sit, which they're filled with so they look as if over open sky (see
  // .lighting-panel): the lighting panel's near the top of the screen
  // (--sky-top-color) and the daily focus's options' (--sky-focus-color),
  // from the sky's renderer (see PANEL_SKY_HEIGHTS in skyRenderer.js); only
  // changed when they do by more than SKY_COLOR_STEP, to keep repaints rare
  const panelSky = useStore(statusStore)?.panelSky;
  const colorText = (color) =>
    color ? `rgb(${color.map((value) => Math.round(value / SKY_COLOR_STEP) * SKY_COLOR_STEP).join(', ')})` : null;
  const topColorText = colorText(panelSky && panelSky.lighting);
  const focusColorText = colorText(panelSky && panelSky.focus);
  useEffect(() => {
    if (topColorText) document.documentElement.style.setProperty('--sky-top-color', topColorText);
  }, [topColorText]);
  useEffect(() => {
    if (focusColorText) document.documentElement.style.setProperty('--sky-focus-color', focusColorText);
  }, [focusColorText]);
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

// A clear sky's icon in twilight: the sunset from sunset until civil dusk,
// and the sunrise from civil dawn until sunrise, by the sun times' events at
// `now` (ms); null outside those times
function clearTwilightIcon(sunTimes, now) {
  const { last, next } = sunEventsAround(sunTimes, new Date(now));
  if (last && last.type === 'sunset' && last.civil && now < Date.parse(last.civil)) return 'sunset';
  if (next && next.type === 'sunrise' && next.civil && now >= Date.parse(next.civil)) return 'sunrise';
  return null;
}

// The current weather's icon (for `code`, its entry in weatherCodes.json),
// at the sky's time: the real time, or the time set in Settings to test the
// sky, checked as the sky updates. It's the night icon between sunset and
// sunrise by the sun times (before they load, by the weather's own day or
// night flag), and on a clear night, the full-color sunset or sunrise in the
// twilight just after sunset or before sunrise, else the moon (following the
// moon in the sky) or stars.
function CurrentWeatherIcon({ code, weather, sunTimes }) {
  const sky = useStore(skyStore);
  const now = sky ? Date.parse(sky.time) : Date.now();
  const { last, next } = sunEventsAround(sunTimes, new Date(now));
  let night;
  if (last) night = last.type === 'sunset';
  else if (next) night = next.type === 'sunrise';
  else night = weather?.current?.is_day === 0;
  if (night && weather?.current?.weather_code === CLEAR_CODE) {
    return <WeatherIcon icon={clearTwilightIcon(sunTimes, now) || clearNightIcon(sky && sky.moon)} />;
  }
  return <WeatherIcon icon={(night && code?.nightIcon) || code?.icon || UNKNOWN_ICON} />;
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
            {ICONS.filter((icon) => icon.use === use).map(({ name, set, style, size }) => (
              <Fragment key={name}>
                <div className="icon-spacing-row">
                  <span className="icon-spacing-name">{name}</span>
                  <span className="icon-spacing-sample" style={{ fontSize: `${Number(fontSize) || 48}px` }}>
                    <span className="icon-spacing-box" />
                    <img
                      className={iconClass(name)}
                      src={iconUrl(name, style, set)}
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
const fluentWhiteIconUrl = (name) => iconUrl(name, 'white', 'fluent');

// A power button: Fluent's power icon, white while `powered`, and while
// off, clear with a glow around it in the panel's glass (see index.css)
function PowerToggle({ powered, onToggle, disabled, className = '' }) {
  const iconMask = {
    WebkitMaskImage: `url(${fluentWhiteIconUrl(POWER_ICON)})`,
    maskImage: `url(${fluentWhiteIconUrl(POWER_ICON)})`,
  };
  return (
    <button
      type="button"
      className={`lighting-power${powered ? ' on' : ''} ${className}`}
      onClick={onToggle}
      disabled={disabled}
      title={powered ? 'Turn off' : 'Turn on'}
    >
      <span className={`lighting-power-icon ${iconClass(POWER_ICON)}`} role="img" aria-label="Power" style={iconMask} />
    </button>
  );
}

// A brightness slider, as LightLine's: a bar filled to the brightness
// (`value`, 0–100) with a dim sun at its left, a bright one at its right and
// the value in its middle; dragging anywhere along it sets it (an unseen
// slider over the whole bar). `small` for the automation rows.
function BrightnessSlider({ value, onChange, small = false, disabled = false }) {
  return (
    <div className={`brightness-slider${small ? ' small' : ''}${disabled ? ' disabled' : ''}`}>
      <span className="brightness-fill" style={{ width: `${value}%` }} />
      <img className="brightness-icon" src={fluentWhiteIconUrl(BRIGHTNESS_LOW_ICON)} alt="" />
      <span className="brightness-value">{value}</span>
      <img className="brightness-icon" src={fluentWhiteIconUrl(BRIGHTNESS_HIGH_ICON)} alt="" />
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={value}
        disabled={disabled}
        aria-label="Brightness"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/*
 * Steppers, for setting numbers and times by touch (the Pi 3's browser has
 * no on-screen keyboard or time picker): the value between − and + arrows.
 * A tap steps once; holding repeats, after HOLD_DELAY, every HOLD_INTERVAL,
 * stepping further the longer it's held (HOLD_SPEEDUPS: after this many
 * repeats, this many steps at a time).
 */
const HOLD_DELAY = 400;
const HOLD_INTERVAL = 90;
const HOLD_SPEEDUPS = [
  [0, 1],
  [12, 2],
  [24, 5],
];

// A stepper's arrow button, calling onStep(steps) on tap and while held
function StepButton({ direction, onStep, label }) {
  const hold = useRef({ timer: 0, repeats: 0 });
  const stop = () => {
    clearTimeout(hold.current.timer);
    hold.current.timer = 0;
  };
  useEffect(() => stop, []);
  const start = (event) => {
    event.preventDefault();
    stop();
    hold.current.repeats = 0;
    onStep.current(direction);
    const repeat = () => {
      hold.current.repeats++;
      const speed = HOLD_SPEEDUPS.filter(([after]) => hold.current.repeats >= after).pop()[1];
      onStep.current(direction * speed);
      hold.current.timer = setTimeout(repeat, HOLD_INTERVAL);
    };
    hold.current.timer = setTimeout(repeat, HOLD_DELAY);
  };
  return (
    <button
      type="button"
      className="stepper-arrow"
      aria-label={label}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
    >
      {direction < 0 ? '‹' : '›'}
    </button>
  );
}

// A stepper showing `display`, calling onStep(steps) (negative for −)
function Stepper({ display, onStep, className = '' }) {
  // (the latest onStep, for a hold that started under an older one)
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  return (
    <span className={`stepper ${className}`}>
      <StepButton direction={-1} onStep={onStepRef} label="Less" />
      <span className="stepper-value">{display}</span>
      <StepButton direction={1} onStep={onStepRef} label="More" />
    </span>
  );
}

// A time (HH:MM) stepper, in steps of `step` minutes, round the clock
function TimeStepper({ value, onChange, step = 15 }) {
  const [hours, minutes] = value.split(':').map(Number);
  const total = hours * 60 + minutes;
  const onStep = (steps) => {
    // (a time off the steps moves to the nearest one that way first)
    const base = steps > 0 ? Math.floor(total / step) * step : Math.ceil(total / step) * step;
    const next = (((base + steps * step) % 1440) + 1440) % 1440;
    onChange(`${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`);
  };
  const date = new Date(2000, 0, 1, hours, minutes);
  return <Stepper className="time-stepper" display={displayTimeFormat.format(date).toLowerCase()} onStep={onStep} />;
}

// A whole-number stepper, with its unit after it
function NumberStepper({ value, onChange, unit, min = -Infinity, max = Infinity }) {
  const onStep = (steps) => onChange(Math.min(max, Math.max(min, value + steps)));
  return (
    <Stepper
      className="number-stepper"
      display={
        <>
          <span className="number-stepper-number">{value}</span>
          {unit && <span className="number-stepper-unit">{unit}</span>}
        </>
      }
      onStep={onStep}
    />
  );
}

// How soon after the automations change they're saved (ms)
const AUTOMATION_SAVE_DELAY = 500;

// The most often brightness changes are sent to LightLine (ms): 5 a second
const BRIGHTNESS_SEND_INTERVAL = 200;

// The times an automation can be set for: a clock time, or minutes from a
// sun event or the wake-up time (set in Settings, an hour earlier on office
// days, see OFFICE_DAYS)
const AUTOMATION_TIMES = [
  { value: 'time', label: 'Time' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'sunrise', label: 'Sunrise' },
  { value: 'astroDusk', label: 'Astro Dusk' },
  { value: 'astroDawn', label: 'Astro Dawn' },
  { value: 'wakeUp', label: 'Wake-up' },
];
const AUTOMATION_CONDITIONS = [
  { value: 'always', label: 'Always' },
  { value: 'whenOff', label: 'When off' },
  { value: 'whenOn', label: 'When on' },
];

// A new automation's settings
const newAutomation = () => ({
  id: `${Date.now()}-${Math.random()}`,
  condition: 'always',
  timeKind: 'time',
  time: '20:00',
  offset: 0,
  brightness: 100,
  powered: true,
  fade: false,
});

/**
 * One automation, a row: when it applies (its condition), when it happens
 * (a time, or minutes from a sun event), the brightness and power it sets,
 * whether it fades to the next (only with another to fade to), and a
 * button to delete it. Run by the server (see server/LightAutomation.js).
 */
function AutomationRow({ automation, canFade, onChange, onDelete }) {
  // Fading needs another automation to fade to: with just one, it's off
  const fade = canFade && automation.fade;
  const set = (changes) => onChange({ ...automation, ...changes });
  return (
    <div className="automation-row">
      <div className="automation-start">
        <select value={automation.condition} onChange={(event) => set({ condition: event.target.value })}>
          {AUTOMATION_CONDITIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={automation.timeKind} onChange={(event) => set({ timeKind: event.target.value })}>
          {AUTOMATION_TIMES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {automation.timeKind === 'time' ? (
          <TimeStepper value={automation.time} onChange={(time) => set({ time })} />
        ) : (
          <NumberStepper
            value={automation.offset}
            onChange={(offset) => set({ offset })}
            unit="min"
            min={-720}
            max={720}
          />
        )}
      </div>
      <BrightnessSlider small value={automation.brightness} onChange={(brightness) => set({ brightness })} />
      <div className="automation-end">
        <PowerToggle powered={automation.powered} onToggle={() => set({ powered: !automation.powered })} />
        {/* Fade to next: a down arrow, filled while on and crossed out while off */}
        <button
          type="button"
          className={`automation-fade${fade ? ' active' : ''}`}
          aria-pressed={fade}
          aria-label="Fade to next"
          disabled={!canFade}
          title={!canFade ? 'Add another automation to fade to' : fade ? 'Fades to the next' : "Doesn't fade to the next"}
          onClick={() => set({ fade: !fade })}
        >
          <span className="automation-fade-arrow">↓</span>
        </button>
        <button type="button" className="automation-delete" onClick={onDelete} title="Delete">
          <img src={fluentWhiteIconUrl(DELETE_ICON)} alt="Delete" />
        </button>
      </div>
    </div>
  );
}

/**
 * The lighting panel, opened from its corner button: the house's lights
 * through LightLine (see server/LightsManager.js). For now, their master
 * power: a button at its top right, white while on and just the icon's
 * shadow outline while off. Their state is loaded each time it opens.
 */
function LightingPanel({ onClose }) {
  // A tap anywhere outside the panel (or its button, which closes it
  // itself) closes it
  const panelRef = useRef(null);
  useEffect(() => {
    const outside = (event) => {
      const panel = panelRef.current;
      if (!panel || panel.contains(event.target)) return;
      if (event.target.closest && event.target.closest('.lighting-toggle')) return;
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);
  // Whether the lights are on, or null until known
  const [powered, setPowered] = useState(null);
  // The lights' brightness (0–100, LightLine's 0–1), or null until known
  const [brightness, setBrightness] = useState(null);
  // The automations, run by the server (see server/LightAutomation.js):
  // loaded each time the panel opens, and saved as they change (shortly
  // after, so holding a stepper saves once)
  const [automations, setAutomations] = useState(null);
  const saveTimer = useRef(0);
  function changeAutomations(next) {
    setAutomations(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetchJson('/api/lights/automations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automations: next }),
      }).catch((err) => setError(err.message));
    }, AUTOMATION_SAVE_DELAY);
  }
  // (a change still waiting is saved if the panel closes first)
  const pendingSave = useRef(null);
  pendingSave.current = automations;
  useEffect(
    () => () => {
      if (!saveTimer.current) return;
      clearTimeout(saveTimer.current);
      fetch('/api/lights/automations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automations: pendingSave.current }),
      });
    },
    [],
  );
  // Brightness changes are sent to LightLine at most every
  // BRIGHTNESS_SEND_INTERVAL: the first straight away, then the latest each
  // interval while the slider moves, so the last always goes out
  const brightnessSend = useRef({ lastSent: 0, pending: null, timer: 0 });
  useEffect(() => () => clearTimeout(brightnessSend.current.timer), []);
  function sendBrightness(value) {
    const send = brightnessSend.current;
    send.pending = value;
    if (send.timer) return;
    const flush = () => {
      send.timer = 0;
      if (send.pending === null) return;
      const sending = send.pending;
      send.pending = null;
      send.lastSent = Date.now();
      fetchJson(`/api/lights/brightness?brightness=${sending / 100}`, { method: 'POST' }).catch((err) =>
        setError(err.message),
      );
    };
    const wait = BRIGHTNESS_SEND_INTERVAL - (Date.now() - send.lastSent);
    if (wait <= 0) flush();
    else send.timer = setTimeout(flush, wait);
  }
  function changeBrightness(value) {
    setBrightness(value);
    setError(null);
    sendBrightness(value);
  }
  const [error, setError] = useState(null);
  useEffect(() => {
    fetchJson('/api/lights/power')
      .then((state) => setPowered(state.powered))
      .catch((err) => setError(err.message));
    fetchJson('/api/lights/brightness')
      .then((state) => setBrightness(Math.round(state.brightness * 100)))
      .catch((err) => setError(err.message));
    fetchJson('/api/lights/automations')
      .then((state) => setAutomations(state.automations))
      .catch((err) => setError(err.message));
  }, []);
  async function toggle() {
    if (powered === null) return;
    const next = !powered;
    setPowered(next);
    setError(null);
    try {
      setPowered((await fetchJson(`/api/lights/power?powered=${next}`, { method: 'POST' })).powered);
    } catch (err) {
      setPowered(!next);
      setError(err.message);
    }
  }
  return (
    <div ref={panelRef} className="lighting-panel">
      <div className="lighting-header">
        <div className="lighting-title">Lighting Control</div>
        <PowerToggle powered={powered} onToggle={toggle} disabled={powered === null} />
      </div>
      {error && <div className="lighting-error">LightLine unavailable</div>}
      <BrightnessSlider value={brightness === null ? 0 : brightness} onChange={changeBrightness} disabled={brightness === null} />
      <div className="automation">
        <div className="automation-title">Automation</div>
        {(automations || []).map((automation) => (
          <AutomationRow
            key={automation.id}
            automation={automation}
            canFade={automations.length > 1}
            onChange={(changed) => changeAutomations(automations.map((a) => (a.id === changed.id ? changed : a)))}
            onDelete={() => changeAutomations(automations.filter((a) => a.id !== automation.id))}
          />
        ))}
        <div className="automation-add-row">
          <button
            type="button"
            className="automation-add"
            disabled={automations === null}
            onClick={() => changeAutomations([...automations, newAutomation()])}
            title="Add an automation"
          >
            <img src={fluentWhiteIconUrl(ADD_ICON)} alt="Add" />
          </button>
        </div>
      </div>
    </div>
  );
}

// A corner button's Fluent icon, white
function CornerIcon({ name, label }) {
  return <img className={`corner-icon ${iconClass(name)}`} src={fluentWhiteIconUrl(name)} alt={label} />;
}
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
function ColoredIcon({ icon, color, label, className = 'detail-icon', url = whiteIconUrl(icon) }) {
  return (
    <span className="detail-icon-shadow" role="img" aria-label={label}>
      <span
        className={`${className} colored-icon ${iconClass(icon)}`}
        style={{
          backgroundColor: color,
          WebkitMaskImage: `url(${url})`,
          maskImage: `url(${url})`,
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
          {/* The icon, with a light box behind its force number, which is
              drawn dark and would vanish against a dark sky. The wrapper
              carries the icon's spacing values so the box can follow them. */}
          <span className={`wind-icon icon-wind-beaufort-${beaufortForce(wind)}`}>
            <span className={`wind-number-box${beaufortForce(wind) >= 10 ? ' two-digits' : ''}`} />
            <img
              className={`detail-icon ${iconClass(`wind-beaufort-${beaufortForce(wind)}`)}`}
              src={weatherIconUrl(`wind-beaufort-${beaufortForce(wind)}`)}
              alt={`Wind force ${beaufortForce(wind)}`}
            />
          </span>
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
  // The amount to a tenth of an inch, or "<0.1" whenever there's any chance
  // of precipitation but the amount rounds to none (the amount and the chance
  // come from different forecasts, see forecastWindow.js); none with no chance
  const rounded = toImperial(span.precipitation, 'mm').value.toFixed(1);
  const inches = rounded !== '0.0' ? rounded : span.precipitationChance > 0 ? '<0.1' : null;
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
        {inches !== null && <div title="Precipitation">{inches} in</div>}
      </div>
    </div>
  );
}

// How often the daily tasks are reloaded (ms), to show ones done on another
// screen
const TASKS_RELOAD_INTERVAL = 60 * 1000;

// A task's custom icon: `icon` while not done and `doneIcon` once done,
// both in full color, with the icons' usual shadow
function CustomTaskIcon({ icon, doneIcon, done, placeClassName = '', burstTarget }) {
  const name = done ? doneIcon : icon;
  return (
    <span className={`task-icon-shadow ${placeClassName}`} data-burst-target={burstTarget}>
      <img className={`task-icon task-icon-custom ${iconClass(name)}`} src={iconUrl(name, 'color', 'custom')} alt="" />
    </span>
  );
}

// The days (0 is Sunday) the office task shows: Tuesday, Wednesday, Thursday
// (also in server/LightAutomation.js, for the wake-up time, as is
// OFFICE_EARLIER_MINUTES)
const OFFICE_DAYS = [2, 3, 4];

// The sleep estimate under the sleep task late at night: hours from going to
// bed (SLEEP_BED_DELAY_MINUTES from now) to waking (the wake-up time set in
// Settings, OFFICE_EARLIER_MINUTES earlier on office days). At least
// SLEEP_GOAL_HOURS is green, under it orange, and more than SLEEP_LOW_HOURS
// under it red and bold (by the number shown, to a tenth of an hour).
const SLEEP_BED_DELAY_MINUTES = 90;
const OFFICE_EARLIER_MINUTES = 60;
const SLEEP_GOAL_HOURS = 7;
const SLEEP_LOW_HOURS = 1;

// "Now: <hours>", the sleep you'd get going to bed soon, waking at
// `wakeTime` (HH:MM, the next time it comes round) or an hour earlier if
// `office`; re-checked every minute
function SleepEstimate({ wakeTime, office }) {
  const now = useNow(CALENDAR_NOW_INTERVAL);
  const [hour, minute] = wakeTime.split(':').map(Number);
  const wake = new Date(now);
  wake.setHours(hour, minute, 0, 0);
  if (wake.getTime() <= now) wake.setDate(wake.getDate() + 1);
  const wakeAt = wake.getTime() - (office ? OFFICE_EARLIER_MINUTES * 60 * 1000 : 0);
  const hours = Math.round(((wakeAt - (now + SLEEP_BED_DELAY_MINUTES * 60 * 1000)) / HOUR_MS) * 10) / 10;
  const level = hours >= SLEEP_GOAL_HOURS ? 'ok' : hours >= SLEEP_GOAL_HOURS - SLEEP_LOW_HOURS ? 'short' : 'low';
  return (
    <span className={`sleep-estimate ${level}`} title="Sleep if you go to bed in an hour and a half">
      Now: {hours.toFixed(1)}
    </span>
  );
}

// How long a task's celebration lasts (ms), matching index.css
const TASK_BURST_MS = 800;

// A task's button: tapping it while not done marks it done (`onPress`) with
// a celebration, its contents popping and a burst of sparks around them.
// The burst is centered on the button, or on the child marked with
// data-burst-target equal to `burstTarget` (the icon the tap fills in).
function TaskButton({ done, onPress, title, burstTarget, below, children }) {
  // Each tap's number, which restarts the animations; 0 before any
  const [burst, setBurst] = useState(0);
  const [bursting, setBursting] = useState(false);
  // Where the burst is centered, in px from the button's top left, or null
  // for the button's center
  const [burstCenter, setBurstCenter] = useState(null);
  const buttonRef = useRef(null);
  useEffect(() => {
    if (!bursting) return undefined;
    const timer = setTimeout(() => setBursting(false), TASK_BURST_MS);
    return () => clearTimeout(timer);
  }, [burst, bursting]);
  const press = () => {
    if (done) return;
    const button = buttonRef.current;
    const target =
      burstTarget === undefined ? null : button.querySelector(`[data-burst-target="${burstTarget}"]`);
    if (target) {
      const outer = button.getBoundingClientRect();
      const inner = target.getBoundingClientRect();
      setBurstCenter({
        left: inner.left + inner.width / 2 - outer.left,
        top: inner.top + inner.height / 2 - outer.top,
      });
    } else {
      setBurstCenter(null);
    }
    onPress();
    setBurst(burst + 1);
    setBursting(true);
  };
  return (
    <button ref={buttonRef} type="button" className={`task${done ? ' done' : ''}`} onClick={press} title={title}>
      <span key={burst} className={`task-content${bursting ? ' task-pop' : ''}`}>
        {children}
      </span>
      {bursting && (
        <span
          key={`burst-${burst}`}
          className="task-burst"
          style={burstCenter ? { left: `${burstCenter.left}px`, top: `${burstCenter.top}px` } : undefined}
        />
      )}
      {/* Anything shown under the button, out of the layout */}
      {below && <span className="task-below">{below}</span>}
    </button>
  );
}

// The daily focus's color (Google Calendar's Peacock, see server/CalendarManager.js)
const FOCUS_COLOR = '#039be5';
// How far above the bottom of the screen the focus's options end, at most
// (a share of the screen's width, as vw)
const FOCUS_LIST_BOTTOM_GAP = 0.02;

/**
 * The day's focus, between the Today title and the tasks: a panel drawn as a
 * button opening a list of the `options` (as wide as it and over it, top to
 * top) to choose from. Until one's chosen (each day starts without one),
 * today's greets the morning over two lines, drawn as a calendar event is,
 * in Peacock; once chosen it's a control, one line: the focus centered, with
 * a small "Focus" at its left. Not
 * tappable unless `changeable` (as the tasks).
 */
function DailyFocus({ focus, options, today, changeable, onChoose }) {
  const [open, setOpen] = useState(false);
  // A tap anywhere outside the list closes it
  const listRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (listRef.current && !listRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  // The list ends above the bottom of the screen at most (see
  // FOCUS_LIST_BOTTOM_GAP), scrolling within itself if it's longer, so the
  // page doesn't grow to scroll
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const bottom = window.innerHeight - FOCUS_LIST_BOTTOM_GAP * window.innerWidth;
    list.style.maxHeight = `${Math.max(0, bottom - list.getBoundingClientRect().top)}px`;
  }, [open]);
  const greeting = !focus && today;
  return (
    <div className="daily-focus-place">
      <button
        type="button"
        className={`daily-focus${greeting ? ' greeting' : ''}${changeable ? '' : ' locked'}`}
        style={greeting ? { '--event-color': FOCUS_COLOR } : undefined}
        onClick={() => setOpen(true)}
      >
        {greeting ? (
          <>
            <span className="calendar-event-fill" style={{ backgroundColor: FOCUS_COLOR }} />
            <span className="calendar-event-edge" />
            <span className="daily-focus-text">
              Good morning, Nicole! <EmojiText text="😊" />
              <br />
              What is your focus for today?
            </span>
          </>
        ) : (
          <>
            <span className="daily-focus-label">Focus</span>
            <span className="daily-focus-text">{focus ? <EmojiText text={focus} /> : 'none'}</span>
          </>
        )}
      </button>
      {open && (
        <div ref={listRef} className="daily-focus-list">
          {options.map((option) => (
            <button
              type="button"
              key={option}
              className={`daily-focus-option${option === focus ? ' chosen' : ''}`}
              onClick={() => {
                setOpen(false);
                if (option !== focus) onChoose(option);
              }}
            >
              <EmojiText text={option} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Today's tasks, each a button that marks it done (it can't be undone until
 * they all reset at sunrise, or from Settings): 7 hours' sleep, leaving home,
 * going to the office (Tuesdays, Wednesdays and Thursdays),
 * 2 L of water (a cup filled for each liter), work (on weekdays) and
 * stretching. `tasks` is
 * when each was done (see server/TasksManager.js); `onDo(task)` marks one done.
 */
function TodayTasks({ tasks, onDo, focusOptions, onFocus, dayOffset, onShiftDay, anyDay, wakeTime }) {
  if (!tasks || !tasks.days) return null;
  // The day shown (the calendar's, see dayFromToday), its tasks' progress,
  // and whether they can still be changed (today's and yesterday's, or any
  // day's with `anyDay`, the setting in Settings)
  const date = dayFromToday(dayOffset);
  const completed = (tasks.days[date] && tasks.days[date].completedTasks) || {};
  const doneCount = (task) => completed[task] || 0;
  const changeable = anyDay || dayOffset === 0 || dayOffset === -1;
  // The arrows only go as far as the days kept (see server/TasksManager.js)
  const canGoBack = dayFromToday(dayOffset - 1) >= tasks.range.start;
  const canGoOn = dayFromToday(dayOffset + 1) <= tasks.range.end;
  const sleep = doneCount('sleep') > 0;
  const leave = doneCount('leave') > 0;
  const water = doneCount('water');
  const work = doneCount('work') > 0;
  const office = doneCount('office') > 0;
  // Work only shows on weekdays (of the day shown, which runs from sunrise to
  // sunrise)
  const [year, month, day] = date.split('-').map(Number);
  const sunriseDay = new Date(year, month - 1, day, 12).getDay();
  const workday = sunriseDay >= 1 && sunriseDay <= 5;
  // ...and going to the office only on Tuesdays, Wednesdays and Thursdays
  const officeDay = OFFICE_DAYS.includes(sunriseDay);
  // Whether the next day is an office day (for the sleep estimate)
  const tomorrowIsOfficeDay = OFFICE_DAYS.includes((sunriseDay + 1) % 7);
  const stretch = doneCount('stretch') > 0;
  const press = (task) => () => {
    if (changeable) onDo(task, date);
  };
  return (
    <section className="today">
      {/* The title over the tasks, starting at the first task's left edge */}
      <div className="today-stack">
      {/* The title names the calendar's day (below the tasks), with arrows
          to move it a day back or on; the tasks are always today's */}
      <div className="today-title">
        {canGoBack && (
          <button type="button" className="day-arrow back" onClick={() => onShiftDay(-1)} title="Previous day">
            <img className={iconClass(DAY_BACK_ICON)} src={fluentWhiteIconUrl(DAY_BACK_ICON)} alt="Previous day" />
          </button>
        )}
        <span className="today-title-text">{dayName(dayOffset)}</span>
        {canGoOn && (
          <button type="button" className="day-arrow on" onClick={() => onShiftDay(1)} title="Next day">
            <img className={iconClass(DAY_ON_ICON)} src={fluentWhiteIconUrl(DAY_ON_ICON)} alt="Next day" />
          </button>
        )}
      </div>
      <DailyFocus
        focus={tasks.days[date] && tasks.days[date].focus}
        options={focusOptions}
        today={dayOffset === 0}
        changeable={changeable}
        onChoose={(focus) => onFocus(focus, date)}
      />
      {/* Greyed out, and not tappable, on days other than today and yesterday */}
      <div className={`today-tasks${changeable ? '' : ' locked'}`}>
        <TaskButton
          done={sleep}
          onPress={press('sleep')}
          title="7 hours of sleep"
          below={wakeTime && <SleepEstimate wakeTime={wakeTime} office={tomorrowIsOfficeDay} />}
        >
          <CustomTaskIcon icon={CUSTOM_TASK_ICONS.sleep} doneIcon={CUSTOM_TASK_ICONS.sleepDone} done={sleep} />
          <span className={`task-badge${sleep ? ' done' : ''}`}>7</span>
        </TaskButton>
        <TaskButton done={leave} onPress={press('leave')} title="Leave the apartment">
          <CustomTaskIcon icon={CUSTOM_TASK_ICONS.leave} doneIcon={CUSTOM_TASK_ICONS.leaveDone} done={leave} />
        </TaskButton>
        {officeDay && (
          <TaskButton done={office} onPress={press('office')} title="Go to the office">
            <CustomTaskIcon icon={CUSTOM_TASK_ICONS.office} doneIcon={CUSTOM_TASK_ICONS.officeDone} done={office} />
          </TaskButton>
        )}
        <TaskButton done={water >= 2} onPress={press('water')} title="2 liters of water" burstTarget={water}>
          <CustomTaskIcon
            icon={CUSTOM_TASK_ICONS.water}
            doneIcon={CUSTOM_TASK_ICONS.waterDone}
            done={water >= 1}
            burstTarget={0}
          />
          <CustomTaskIcon
            icon={CUSTOM_TASK_ICONS.water}
            doneIcon={CUSTOM_TASK_ICONS.waterDone}
            done={water >= 2}
            placeClassName="task-second-cup"
            burstTarget={1}
          />
        </TaskButton>
        {workday && (
          <TaskButton done={work} onPress={press('work')} title="Work">
            <CustomTaskIcon icon={CUSTOM_TASK_ICONS.work} doneIcon={CUSTOM_TASK_ICONS.workDone} done={work} />
          </TaskButton>
        )}
        <TaskButton done={stretch} onPress={press('stretch')} title="Stretch">
          <CustomTaskIcon icon={CUSTOM_TASK_ICONS.stretch} doneIcon={CUSTOM_TASK_ICONS.stretchDone} done={stretch} />
        </TaskButton>
      </div>
      </div>
    </section>
  );
}

// How often today's calendar events are reloaded (ms); the server fetches
// the calendars' feeds at most every 5 minutes
const CALENDAR_RELOAD_INTERVAL = 5 * 60 * 1000;
// From this hour of the night (22 is 10 pm) until sunrise (when the
// calendar's "today" moves on), Today's calendar shows tomorrow's events
// instead, once today's have all ended (see nothingLeftTonight)
const PEEK_TOMORROW_HOUR = 22;

// Whether, at `now` (ms), it's past PEEK_TOMORROW_HOUR on the calendar's
// "today" (so through the night until sunrise) and today's calendar
// (`calendar`, once loaded) has no timed events still to come or still going on
function nothingLeftTonight(calendar, now) {
  const from = calendarTodayNoon();
  from.setHours(PEEK_TOMORROW_HOUR, 0, 0, 0);
  if (now < from.getTime()) return false;
  if (!calendar || !calendar.configured || calendar.date !== dayFromToday(0)) return false;
  return !calendar.events.some((event) => !event.allDay && Date.parse(event.end) > now);
}

// How often the calendar's current-time line moves on (ms)
const CALENDAR_NOW_INTERVAL = 60 * 1000;
const calendarHourFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });
const HOUR_MS = 60 * 60 * 1000;
// Other days start at this hour, or earlier if an event does
const CALENDAR_DAY_START_HOUR = 8;
// The calendar's events' rows of text: each at most this tall (vw), inside
// padding this tall (vw) above and below, and shorter if need be so that a
// one-hour event fits one row when a whole day is shown in the space the
// calendar has (see CalendarDay)
const CALENDAR_ROW_VW = 2.4;
const CALENDAR_EVENT_PADDING_VW = 0.3;
// The events' borders (px, above and below), matching index.css
const CALENDAR_EVENT_BORDER_PX = 1;
// The longest the view spans (hours), for the day's events running into the
// small hours; its text is sized so an hour-long event fits a row at this span
const CALENDAR_LONGEST_SPAN_HOURS = 16;
// The calendar's height (px) assumed until it's been measured
const CALENDAR_FIRST_HEIGHT_VW = 70;
const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long' });

// The date `offset` days from today, as YYYY-MM-DD on this computer's clock
// The calendar's "today", as YYYY-MM-DD: the day of the last sunrise (set by
// the page from the sun times, see calendarToday), so its days run from
// sunrise to sunrise, like the daily tasks. The page sets it as it renders.
let calendarTodayDate = null;

// A date as YYYY-MM-DD on this computer's clock
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// The calendar's "today" at `now` (ms), from the sun times' events: the date
// of the last sunrise, or, before the sun times load, the date now
function calendarToday(sunTimes, now) {
  const sunrises = ((sunTimes && sunTimes.events) || []).filter((event) => event.type === 'sunrise');
  const last = sunrises.filter((event) => Date.parse(event.time) <= now).pop();
  return localDate(new Date(last ? Date.parse(last.time) : now));
}

// The calendar's "today" (or now's date, before it's set), as a Date at noon
function calendarTodayNoon() {
  if (!calendarTodayDate) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    return date;
  }
  const [year, month, day] = calendarTodayDate.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

// The date `offset` days from the calendar's "today", as YYYY-MM-DD
function dayFromToday(offset) {
  const date = calendarTodayNoon();
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

// A day's name, `offset` days from the calendar's "today": Today, Tomorrow,
// Yesterday, or its weekday
function dayName(offset) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  const date = calendarTodayNoon();
  date.setDate(date.getDate() + offset);
  return weekdayFormat.format(date);
}

// The time now (ms), moved on every `interval` ms
function useNow(interval) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

// Lays out timed events side by side where they overlap (ending at their
// `endKey`): each event gets a column, and each group of overlapping events
// the number of columns it needs
function eventColumns(events, endKey = 'endMs') {
  const placed = [];
  let group = [];
  let groupEnd = -Infinity;
  const finishGroup = () => {
    const columns = Math.max(1, ...group.map((event) => event.column + 1));
    group.forEach((event) => placed.push({ ...event, columns }));
    group = [];
  };
  for (const event of [...events].sort((a, b) => a.startMs - b.startMs || b[endKey] - a[endKey])) {
    if (event.startMs >= groupEnd && group.length) finishGroup();
    // The first column free when it starts
    const busy = group.filter((other) => other[endKey] > event.startMs).map((other) => other.column);
    let column = 0;
    while (busy.includes(column)) column++;
    group.push({ ...event, column });
    groupEnd = Math.max(groupEnd, event[endKey]);
  }
  if (group.length) finishGroup();
  return placed;
}

// The start of the hour `time` (ms) is in
function hourStart(time) {
  const date = new Date(time);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/**
 * A day's calendar events (see server/CalendarManager.js), `offset` days
 * from today, as an hourly view: all-day events across the top, then each
 * timed event as a block in its calendar's color down the hours, which fit
 * the view's fixed height. Today runs from the start of the current hour to
 * midnight, with a line for now, leaving out events already over; other days
 * run from 8 am (or the hour the first event starting that day starts in, if
 * earlier) to midnight. Events shorter than an hour are drawn an hour long.
 * Every hour has a line, but only the first hour, the midnight at the end,
 * and the hours an event starts or ends in are labeled. An event's title wraps onto as many rows as fit above its time;
 * with room for only one row, the time goes beside the title if there's
 * space. With no events left, it's just a line saying so.
 */
/*
 * Emoji in text from calendars and tasks, shown as Fluent Emoji pictures
 * (Microsoft's, in their Color style, served from the Pi 5: see
 * scripts/importFluentEmoji.mjs) so they look the same on every screen.
 * Which ones there are is loaded once; until then, or for any not there,
 * the emoji's left as text (in the screen's own emoji font).
 */
const EMOJI = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu;
const emojiStore = createStore(null);
let emojiLoading = false;
function loadEmojiIndex() {
  if (emojiLoading) return;
  emojiLoading = true;
  fetchJson('/emoji/index.json')
    .then((names) => emojiStore.set(new Set(names)))
    .catch((err) => console.warn('Emoji pictures unavailable:', err.message));
}

// An emoji's picture's name: its code points in hex, joined by "-", without
// variation selector 16 (as the pictures are named)
const emojiName = (emoji) =>
  [...emoji]
    .map((char) => char.codePointAt(0))
    .filter((point) => point !== 0xfe0f)
    .map((point) => point.toString(16))
    .join('-');

// `text` with its emoji as pictures
function EmojiText({ text }) {
  const available = useStore(emojiStore);
  useEffect(loadEmojiIndex, []);
  if (!text) return null;
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(EMOJI)) {
    const name = emojiName(match[0]);
    if (!available || !available.has(name)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<img key={match.index} className="emoji" src={`/emoji/${name}.svg`} alt={match[0]} draggable="false" />);
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// The green of done things: the done 7, and done Google Tasks
const TASK_DONE_COLOR = '#22c55e';

// One Google Task: a row with a circle and its title ("overdue" after it
// for one due earlier). Tapping an open one completes it (saved to Google
// Tasks): its circle fills with a green check, with the daily tasks'
// celebration burst on it, and the row takes a soft green tint.
function GoogleTaskRow({ task, onComplete }) {
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!burst) return undefined;
    const timer = setTimeout(() => setBurst(0), TASK_BURST_MS);
    return () => clearTimeout(timer);
  }, [burst]);
  const press = () => {
    if (task.done) return;
    onComplete(task);
    setBurst(Date.now());
  };
  return (
    <button
      type="button"
      className={`calendar-task${task.done ? ' done' : ''}${task.overdue ? ' overdue' : ''}`}
      title={task.notes || undefined}
      onClick={press}
      style={task.done ? { '--event-color': TASK_DONE_COLOR } : undefined}
    >
      {/* Done: drawn as a calendar event is, in green (see index.css) */}
      {task.done && <span className="calendar-event-fill" style={{ backgroundColor: TASK_DONE_COLOR }} />}
      {task.done && <span className="calendar-event-edge" />}
      <span className="calendar-task-check-place">
        <span key={burst} className={`calendar-task-check${burst ? ' task-pop' : ''}`}>
          {task.done && <span className="calendar-task-checkmark">✓</span>}
        </span>
        {burst ? <span key={`burst-${burst}`} className="task-burst calendar-task-burst" /> : null}
      </span>
      <span className="calendar-task-title">
        <EmojiText text={task.title} />
      </span>
      {task.overdue && <span className="calendar-task-note">overdue</span>}
    </button>
  );
}

// Google Tasks for the day shown (see server/GoogleTasksManager.js), under
// the daily task buttons and above the calendar; nothing when there are none.
// With `foldDone` (today's, late at night under "Coming up tomorrow"), the
// completed ones show as one completed row counting them.
function GoogleTasksList({ tasks, onComplete, foldDone = false }) {
  if (tasks.length === 0) return null;
  // (sorted here too, so one just tapped moves up straight away: completed
  // first, in the order they were completed, then the open ones, as
  // compareTasks in server/GoogleTasksManager.js)
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    if (a.done) return (Date.parse(a.completed) || 0) - (Date.parse(b.completed) || 0);
    return Number(b.overdue) - Number(a.overdue) || a.title.localeCompare(b.title);
  });
  const done = sorted.filter((task) => task.done).length;
  const shown =
    foldDone && done > 0
      ? [
          { id: 'completed-tasks', title: `${done} Completed task${done === 1 ? '' : 's'}`, done: true },
          ...sorted.filter((task) => !task.done),
        ]
      : sorted;
  return (
    <div className="google-tasks">
      {shown.map((task) => (
        <GoogleTaskRow key={task.id} task={task} onComplete={onComplete} />
      ))}
    </div>
  );
}

// Whether the calendar shows events (not just a line saying there are none)
// for the day `offset` days from today: all-day events, or timed ones (today,
// ones not yet over)
function calendarHasEvents(calendar, offset) {
  if (!calendar || !calendar.configured || calendar.date !== dayFromToday(offset)) return false;
  const now = Date.now();
  return calendar.events.some((event) => event.allDay || offset !== 0 || Date.parse(event.end) > now);
}

// An hour's label on the calendar, such as "9 am"
const hourLabel = (hour) => calendarHourFormat.format(new Date(hour)).replace(' ', '\u00a0').toLowerCase();

// The calendar's refresh button, spinning while `refreshing`, centered over
// the hour labels (see index.css). `className` places it up and down, with
// `style` for any measured position.
function CalendarRefresh({ refreshing, onRefresh, className, style }) {
  return (
    <div className={`calendar-refresh-place ${className}`} style={style}>
      <button
        type="button"
        className={`calendar-refresh${refreshing ? ' refreshing' : ''}`}
        onClick={onRefresh}
        title="Refresh the calendar"
      >
        <img className={iconClass(REFRESH_ICON)} src={fluentWhiteIconUrl(REFRESH_ICON)} alt="Refresh" />
      </button>
    </div>
  );
}

// The rows the calendar's refresh button lines up with: the first of these
// shown, in the order they're laid out (the first Google Task, "Coming up
// tomorrow", the first all-day event), or else the daily task buttons
const REFRESH_BESIDE = ['.google-tasks .calendar-task', '.calendar-subtitle', '.calendar-all-day-event', '.today-tasks'];

// Where the middle of the row the refresh button lines up with is (see
// REFRESH_BESIDE), in px down from the top of `element` (or null), measured
// after each render and as the window changes
function useTasksMiddle(element) {
  const [middle, setMiddle] = useState(null);
  const measure = () => {
    const tasks = REFRESH_BESIDE.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!element || !tasks) return;
    const box = tasks.getBoundingClientRect();
    const value = Math.round(box.top + box.height / 2 - element.getBoundingClientRect().top);
    setMiddle((current) => (current === value ? current : value));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  return middle;
}

function CalendarDay({ calendar, offset, refreshing, onRefresh }) {
  const now = useNow(CALENDAR_NOW_INTERVAL);
  // The calendar's outer element, and the task buttons' middle below its top
  const [outerElement, setOuterElement] = useState(null);
  const tasksMiddle = useTasksMiddle(outerElement);
  const besideTasks = { top: tasksMiddle === null ? 0 : `${tasksMiddle}px` };
  // The hours' height (px), which fills the rest of the screen, measured as
  // it changes
  const [hoursElement, setHoursElement] = useState(null);
  const [hoursHeight, setHoursHeight] = useState(0);
  useEffect(() => {
    if (!hoursElement) return undefined;
    const measure = () => setHoursHeight(hoursElement.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(hoursElement);
    return () => observer.disconnect();
  }, [hoursElement]);
  if (!calendar || !calendar.configured) return null;
  const today = offset === 0;
  const [year, month, date] = calendar.date.split('-').map(Number);
  const day = new Date(year, month - 1, date);
  const dayStart = day.getTime();
  const nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  const dayEnd = nextDay.getTime();
  const allDay = calendar.events.filter((event) => event.allDay);
  const timed = calendar.events
    .filter((event) => !event.allDay)
    .map((event) => ({ ...event, startMs: Date.parse(event.start), endMs: Date.parse(event.end) }))
    .filter((event) => !today || event.endMs > now);

  // The first hour labeled: the current one (today) or 8 am, or the hour
  // the first event starting that day (after its sunrise, as the day runs
  // from sunrise to sunrise) starts in, if earlier
  const dayFrom = new Date(day);
  dayFrom.setHours(CALENDAR_DAY_START_HOUR);
  const windowStart = calendar.window ? Date.parse(calendar.window.start) : dayStart;
  const firstStart = Math.min(...timed.filter((event) => event.startMs >= windowStart).map((event) => event.startMs));
  const start = today
    ? Math.max(dayStart, hourStart(now))
    : Math.min(dayFrom.getTime(), Number.isFinite(firstStart) ? hourStart(firstStart) : Infinity);

  if (timed.length === 0 && allDay.length === 0) {
    const name = dayName(offset);
    // (today: "No more" once there were timed events, now all over)
    const hadEvents = calendar.events.some((event) => !event.allDay);
    const text = today
      ? hadEvents
        ? 'No more events today'
        : 'No events today'
      : offset === 1 || offset === -1
        ? `No events ${name.toLowerCase()}`
        : `No events on ${name}`;
    return (
      <div className="calendar-none">
        <div className="calendar-none-text">{text}</div>
        {/* The refresh button, centered under the text */}
        <button
          type="button"
          className={`calendar-refresh${refreshing ? ' refreshing' : ''}`}
          onClick={onRefresh}
          title="Refresh the calendar"
        >
          <img className={iconClass(REFRESH_ICON)} src={fluentWhiteIconUrl(REFRESH_ICON)} alt="Refresh" />
        </button>
      </div>
    );
  }

  // The view's span: from `start` (above: the start of this hour, today, or
  // 8 am, or the first event's hour if earlier, not counting events from the
  // day before), to the next midnight, or on to the end of the last event if
  // later (the day runs to the next sunrise, so its events can run into the
  // small hours), but never more than CALENDAR_LONGEST_SPAN_HOURS. Events
  // running past the end are drawn as if they carry on (see below).
  const end = Math.min(
    Math.max(dayEnd, ...timed.map((event) => event.endMs)),
    start + CALENDAR_LONGEST_SPAN_HOURS * HOUR_MS,
  );
  const span = Math.max(1, end - start);
  // Where a time falls, as a share of the view's height
  const at = (time) => Math.min(1, Math.max(0, (time - start) / span));
  // Every hour in the span (by the clock, so a daylight saving change is right)
  const hours = [];
  for (const hour = new Date(start); hour.getTime() <= end; hour.setHours(hour.getHours() + 1)) {
    hours.push(hour.getTime());
  }
  // Rows of event text (px): as tall as CALENDAR_ROW_VW allows, but short
  // enough that an hour fits one with padding, across the longest span
  const vw = window.innerWidth / 100;
  const height = hoursHeight || CALENDAR_FIRST_HEIGHT_VW * vw;
  const padding = CALENDAR_EVENT_PADDING_VW * vw;
  const inset = 2 * (padding + CALENDAR_EVENT_BORDER_PX);
  const row = Math.max(8, Math.min(CALENDAR_ROW_VW * vw, height / CALENDAR_LONGEST_SPAN_HOURS - inset));

  // The hours labeled: the first (the current hour, today) and the midnight
  // at the end, and for each event's start and end, the hour it falls in
  const labeled = new Set([start, end, ...timed.flatMap((event) => [event.startMs, event.endMs]).map(hourStart)]);

  return (
    <section ref={setOuterElement} className="calendar-day">
      <CalendarRefresh refreshing={refreshing} onRefresh={onRefresh} className="beside-tasks" style={besideTasks} />
      {allDay.length > 0 && (
        <div className="calendar-all-day">
          {allDay.map((event) => (
            <div key={event.id} className="calendar-all-day-row">
              <div className="calendar-all-day-event" title={event.calendar} style={{ '--event-color': event.color }}>
                <span className="calendar-event-fill" style={{ backgroundColor: event.color }} />
                  <span className="calendar-event-edge" />
                <span className="calendar-event-text">
                  <EmojiText text={event.title} />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {timed.length > 0 && (
        <div
          ref={setHoursElement}
          className="calendar-hours"
          style={{ '--calendar-row': `${row}px`, '--calendar-padding': `${padding}px` }}
        >
          {hours.map((hour) => (
            <div key={hour} className="calendar-hour" style={{ top: `${at(hour) * 100}%` }}>
              {labeled.has(hour) && (
                <span className="calendar-hour-label">{hourLabel(hour)}</span>
              )}
            </div>
          ))}
          <div className="calendar-events">
            {/* The time now, first so the events are drawn over it */}
            {today && <div className="calendar-now" style={{ top: `${at(now) * 100}%` }} />}
            {eventColumns(
              // (drawn at least an hour long, which also spaces out short
              // events that follow one another)
              timed.map((event) => ({ ...event, drawnEndMs: Math.max(event.endMs, event.startMs + HOUR_MS) })),
              'drawnEndMs',
            ).map((event) => {
              const top = at(event.startMs);
              const share = Math.max(at(event.drawnEndMs) - top, 0.02);
              // Rows of text that fit; with one, the time goes beside the title
              const rows = Math.max(1, Math.floor((share * height - inset + 0.01) / row));
              // Running past the end of the view: drawn on a little further,
              // fading out, with square bottom corners, as if it carries on
              const continues = event.drawnEndMs > end;
              return (
                <div
                  key={event.id}
                  className={`calendar-event${rows === 1 ? ' one-row' : ''}${continues ? ' continues' : ''}`}
                  title={`${event.calendar}${event.location ? ` · ${event.location}` : ''}`}
                  style={{
                    top: `${top * 100}%`,
                    height: continues ? `calc(${share * 100}% + var(--calendar-continue))` : `${share * 100}%`,
                    left: `${(event.column / event.columns) * 100}%`,
                    width: `${100 / event.columns}%`,
                    '--event-color': event.color,
                  }}
                >
                  <span className="calendar-event-fill" style={{ backgroundColor: event.color }} />
                  <span className="calendar-event-edge" />
                  <div
                    className="calendar-event-title"
                    style={rows > 1 ? { WebkitLineClamp: rows - 1, maxHeight: `${(rows - 1) * row}px` } : undefined}
                  >
                    <EmojiText text={event.title} />
                  </div>
                  <div className="calendar-event-time">
                    {displayTimeFormat.format(new Date(event.startMs)).toLowerCase()}–
                    {displayTimeFormat.format(new Date(event.endMs)).toLowerCase()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
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

const WeatherDisplay = memo(function WeatherDisplay({ weather, pollen, sunTimes, moonEvents, forecast }) {
  const current = weather?.current;
  const code = current ? WEATHER_CODES.get(current.weather_code) : undefined;
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
                <div className="time-row-side">
                  <SunEvent event={last} />
                </div>
                <div className="weather-time">{time}</div>
                <div className="time-row-side end">
                  <SunEvent event={next} />
                </div>
              </div>
              {/* The forecast until the next sun event, under it */}
              <div className="forecast-row">
                <ForecastUntil forecast={forecast} now={now} until={next} />
              </div>
            </>
          );
        }}
      </DateAndTime>
      {/* The temperature's number and °F centered on the screen, with the
          moon event and weather icon to their left, the condition above them
          and humidity and wind to their right, all centered up and down on
          the icon */}
      <div className="weather-now">
        <div className="weather-now-left">
          <MoonEvent moonEvents={moonEvents} />
          <CurrentWeatherIcon code={code} weather={weather} sunTimes={sunTimes} />
        </div>
        <div className="weather-now-middle">
          <div className="weather-condition">{condition}</div>
          <div className="weather-temperature">
            <span className="temperature-value" title="Feels like">
              {wholeFahrenheit(weather, 'apparent_temperature')}
            </span>
            <img className={`temperature-unit ${iconClass('fahrenheit')}`} src={whiteIconUrl('fahrenheit')} alt="°F" />
            {/* Humidity and wind beside the °F */}
            <div className="weather-temperature-side">
              <HumidityAndWind weather={weather} />
            </div>
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
  // When each daily task was done (see server/TasksManager.js)
  const [tasks, setTasks] = useState(null);
  // The daily focus's options (see server/TasksManager.js), loaded with the tasks
  const [focusOptions, setFocusOptions] = useState([]);
  // Whether tasks can be changed on any day, not just today and yesterday
  // (a setting in Settings, off whenever the page loads)
  const [tasksAnyDay, setTasksAnyDay] = useState(false);
  // The wake-up time (HH:MM) for the sleep estimate, kept on the server
  // (see server/UiManager.js)
  const [wakeTime, setWakeTime] = useState('07:00');
  // Whether rain and snow are shown from the weather (saved on the server)
  const [showRain, setShowRain] = useState(true);
  const [showSnow, setShowSnow] = useState(true);
  // The UI flavor, kept on the server (see server/UiManager.js)
  const [flavor, setFlavor] = useState(DEFAULT_FLAVOR);
  // The calendar's events (see server/CalendarManager.js) for the day shown:
  // `calendarOffset` days from today, as chosen with the arrows by the title,
  // or on Today late at night with nothing left to come (`peekTomorrow`, see
  // PEEK_TOMORROW_HOUR), tomorrow's
  const [calendar, setCalendar] = useState(null);
  const [calendarOffset, setCalendarOffset] = useState(0);
  const [peekTomorrow, setPeekTomorrow] = useState(false);
  // The calendar's "today" (see calendarTodayDate), moving on at sunrise
  const [calendarBase, setCalendarBase] = useState(null);
  calendarTodayDate = calendarBase;
  const shownOffset = calendarOffset === 0 && peekTomorrow ? 1 : calendarOffset;
  // Today's events, kept to tell whether any are left tonight
  const [todayCalendar, setTodayCalendar] = useState(null);
  // Whether the refresh button's reload is under way
  const [calendarRefreshing, setCalendarRefreshing] = useState(false);
  const calendarOffsetRef = useRef(0);
  calendarOffsetRef.current = shownOffset;
  // The page's day, days from today (for Google Tasks, which follow it
  // rather than the calendar's late-night look at tomorrow)
  const calendarPageOffset = useRef(0);
  calendarPageOffset.current = calendarOffset;
  // Google Tasks for the day shown (see server/GoogleTasksManager.js), and
  // tomorrow's while the Today page shows tomorrow's calendar late at night
  const [googleTasks, setGoogleTasks] = useState(null);
  const [googleTasksAhead, setGoogleTasksAhead] = useState(null);
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
  // Whether the lighting panel is open
  const [lightingOpen, setLightingOpen] = useState(false);
  const closeLighting = useMemo(() => () => setLightingOpen(false), []);
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
  const weatherPrecipitation = useMemo(
    () => precipitationFromWeather(weather && weather.current, { rain: showRain, snow: showSnow }),
    [weather, showRain, showSnow],
  );
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

  // Tasks are only shown once they load, so a failure just leaves them out
  async function loadTasks() {
    try {
      setTasks(await fetchJson('/api/tasks'));
      setFocusOptions((await fetchJson('/api/tasks/focus-options')).options);
    } catch (err) {
      console.warn('Tasks unavailable:', err.message);
    }
  }

  // The calendar is only shown once it loads, so a failure just leaves it out
  // With `fresh` (the refresh button), the server fetches the calendars'
  // feeds again rather than using its last fetch
  async function loadCalendar(fresh = false) {
    const offset = calendarOffsetRef.current;
    if (fresh) setCalendarRefreshing(true);
    // Google Tasks for the page's day, as the daily tasks are (today runs
    // from sunrise to sunrise, and stays today when the calendar shows
    // tomorrow's late at night), with overdue ones on the Today page
    const date = dayFromToday(offset);
    const tasksDate = dayFromToday(calendarPageOffset.current);
    fetchJson(`/api/google-tasks?date=${tasksDate}&today=${dayFromToday(0)}${fresh ? '&fresh=true' : ''}`)
      .then((result) => {
        if (offset === calendarOffsetRef.current) setGoogleTasks(result);
      })
      .catch((err) => console.warn('Google Tasks unavailable:', err.message));
    // ...and when the Today page shows tomorrow's calendar late at night,
    // tomorrow's tasks too, under "Coming up tomorrow"
    if (date !== tasksDate) {
      fetchJson(`/api/google-tasks?date=${date}&today=${dayFromToday(0)}${fresh ? '&fresh=true' : ''}`)
        .then((result) => {
          if (offset === calendarOffsetRef.current) setGoogleTasksAhead(result);
        })
        .catch((err) => console.warn('Google Tasks unavailable:', err.message));
    } else {
      setGoogleTasksAhead(null);
    }
    try {
      const day = await fetchJson(`/api/calendar/today?date=${date}${fresh ? '&fresh=true' : ''}`);
      // (unless the day was changed while it loaded)
      if (offset === calendarOffsetRef.current) setCalendar(day);
      // Today's, too, when another day is shown
      setTodayCalendar(offset === 0 ? day : await fetchJson(`/api/calendar/today?date=${dayFromToday(0)}`));
    } catch (err) {
      console.warn('Calendar unavailable:', err.message);
    } finally {
      if (fresh) setCalendarRefreshing(false);
    }
  }

  // Completes a Google Task, showing it done straight away (and back to open
  // if saving it to Google fails)
  async function completeGoogleTask(task) {
    const completed = new Date().toISOString();
    const update = (current, done) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((t) => (t.id === task.id ? { ...t, done, completed: done ? completed : null } : t)),
          }
        : current;
    const mark = (done) => {
      setGoogleTasks((current) => update(current, done));
      setGoogleTasksAhead((current) => update(current, done));
    };
    mark(true);
    try {
      await fetchJson(
        `/api/google-tasks/complete?listId=${encodeURIComponent(task.listId)}&taskId=${encodeURIComponent(task.id)}`,
        { method: 'POST' },
      );
    } catch (err) {
      console.warn('Could not complete the Google Task:', err.message);
      mark(false);
    }
  }

  // Marks a step of a task done on the day `date` (YYYY-MM-DD), showing it
  // straight away
  async function doTask(task, date) {
    setTasks((current) => {
      const days = { ...current.days };
      const completed = { ...((days[date] && days[date].completedTasks) || {}) };
      completed[task] = (completed[task] || 0) + 1;
      days[date] = { ...days[date], completedTasks: completed };
      return { ...current, days };
    });
    try {
      setTasks(await fetchJson(`/api/tasks/${task}/done?date=${date}`, { method: 'POST' }));
    } catch (err) {
      console.warn('Could not mark the task done:', err.message);
      loadTasks();
    }
  }

  // Sets the focus of the day `date` (YYYY-MM-DD), showing it straight away
  async function chooseFocus(focus, date) {
    setTasks((current) => {
      const days = { ...current.days };
      days[date] = { completedTasks: {}, ...days[date], focus };
      return { ...current, days };
    });
    try {
      setTasks(
        await fetchJson(`/api/tasks/focus?date=${date}&focus=${encodeURIComponent(focus)}`, { method: 'POST' }),
      );
    } catch (err) {
      console.warn('Could not set the focus:', err.message);
      loadTasks();
    }
  }

  async function resetTasks() {
    try {
      setTasks(await fetchJson(`/api/tasks/reset?date=${dayFromToday(0)}`, { method: 'POST' }));
    } catch (err) {
      console.warn('Could not reset the tasks:', err.message);
    }
  }

  async function resetFocus() {
    try {
      setTasks(await fetchJson(`/api/tasks/focus/reset?date=${dayFromToday(0)}`, { method: 'POST' }));
    } catch (err) {
      console.warn('Could not reset the focus:', err.message);
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
    loadTasks();
    loadFlavor();
    loadSunTimes();
  }, []);

  useEffect(() => applyFlavor(flavor), [flavor]);

  // The server's UI flavor; until it loads (or if it can't), the default
  async function loadFlavor() {
    try {
      const settings = await fetchJson('/api/ui');
      setFlavor(settings.flavor);
      setWakeTime(settings.wakeTime);
      setShowRain(settings.showRain);
      setShowSnow(settings.showSnow);
    } catch (err) {
      console.warn('UI settings unavailable:', err.message);
    }
  }

  // Changes the wake-up time, here straight away and on the server
  async function changeWakeTime(time) {
    if (!/^\d{2}:\d{2}$/.test(time)) return;
    setWakeTime(time);
    try {
      setWakeTime((await fetchJson(`/api/ui?wakeTime=${time}`, { method: 'POST' })).wakeTime);
    } catch (err) {
      console.warn('Could not save the wake-up time:', err.message);
    }
  }

  // Turns showing rain or snow from the weather (`name`: showRain or
  // showSnow) on or off, here straight away and on the server
  async function changeShown(name, shown) {
    const set = name === 'showRain' ? setShowRain : setShowSnow;
    set(shown);
    try {
      set((await fetchJson(`/api/ui?${name}=${shown}`, { method: 'POST' }))[name]);
    } catch (err) {
      console.warn(`Could not save ${name}:`, err.message);
    }
  }

  // Changes the UI flavor, here straight away and on the server for every
  // screen and reload
  async function changeFlavor(name) {
    setFlavor(name);
    try {
      setFlavor((await fetchJson(`/api/ui?flavor=${encodeURIComponent(name)}`, { method: 'POST' })).flavor);
    } catch (err) {
      console.warn('Could not save the UI flavor:', err.message);
    }
  }

  // The calendar is reloaded every few minutes, picking up changes and, after
  // midnight, the new day
  useEffect(() => {
    const timer = setInterval(() => loadCalendar(), CALENDAR_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // A new day chosen (or shown) is loaded straight away
  useEffect(() => {
    loadCalendar();
  }, [shownOffset]);

  // Late at night, with nothing left to come today, Today shows tomorrow's
  // events early: checked every minute and as today's events load
  useEffect(() => {
    const check = () => setPeekTomorrow(nothingLeftTonight(todayCalendar, Date.now()));
    check();
    const timer = setInterval(check, CALENDAR_NOW_INTERVAL);
    return () => clearInterval(timer);
  }, [todayCalendar, calendarBase]);

  // The calendar's "today" moves on at sunrise: checked every minute and as
  // the sun times load, reloading the calendar when it changes
  useEffect(() => {
    const check = () => setCalendarBase(calendarToday(sunTimes, Date.now()));
    check();
    const timer = setInterval(check, CALENDAR_NOW_INTERVAL);
    return () => clearInterval(timer);
  }, [sunTimes]);

  useEffect(() => {
    if (calendarBase) loadCalendar();
  }, [calendarBase]);

  // Lets controls show :active (their tap highlight) on touch screens, which
  // iOS only does once the page listens for touches
  useEffect(() => {
    const listener = () => {};
    document.addEventListener('touchstart', listener, { passive: true });
    return () => document.removeEventListener('touchstart', listener);
  }, []);

  // The tasks are reloaded every minute, to show ones done on another screen
  useEffect(() => {
    const timer = setInterval(() => loadTasks(), TASKS_RELOAD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  function goToSleep() {
    asleepSince.current = Date.now();
    // Everything shows again on waking, with the lighting panel closed
    setUiHidden(false);
    setLightingOpen(false);
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
      <DarkSkyMarker
        exposure={exposure}
        cloudCover={overcastOf(clouds)}
        cloudDarkness={clouds?.darkness ?? CLOUD_DARKNESS_TYPICAL}
      />
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
          <CornerIcon name={settingsOpen ? BACK_ICON : SETTINGS_ICON} label={settingsOpen ? 'Back' : 'Settings'} />
        </button>
      )}
      {/* Hides everything else but bedtime, leaving just the sky; the eye is
          crossed out while hidden */}
      <button
        type="button"
        className={`corner-button symbol-button visibility-toggle${uiHidden ? ' everything-hidden' : ''}`}
        onClick={() => setUiHidden(!uiHidden)}
        title={uiHidden ? 'Show everything' : 'Show just the sky'}
      >
        <CornerIcon
          name={uiHidden ? SHOW_ALL_ICON : SHOW_SKY_ICON}
          label={uiHidden ? 'Show everything' : 'Show just the sky'}
        />
      </button>
      {/* The lighting panel's button, left of bedtime, and the panel under it */}
      {!uiHidden && (
        <button
          type="button"
          className="corner-button lighting-toggle"
          onClick={() => setLightingOpen(!lightingOpen)}
          title="Lighting"
        >
          <span className="lighting-logo">L|L</span>
        </button>
      )}
      {!uiHidden && lightingOpen && <LightingPanel onClose={closeLighting} />}
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
      {/* The Today section and the calendar, together, so the tint behind
          them by day covers both; filling the rest of the screen when the
          calendar has events to show */}
      {!settingsOpen && !uiHidden && (
        <div className={`today-and-calendar${calendarHasEvents(calendar, shownOffset) ? ' filled' : ''}`}>
          <TodayTasks
            tasks={tasks}
            onDo={doTask}
            focusOptions={focusOptions}
            onFocus={chooseFocus}
            anyDay={tasksAnyDay}
            wakeTime={shownOffset !== calendarOffset ? wakeTime : null}
            dayOffset={calendarOffset}
            onShiftDay={(change) => setCalendarOffset(calendarOffset + change)}
          />
          <GoogleTasksList
            tasks={googleTasks && googleTasks.configured ? googleTasks.tasks : []}
            onComplete={completeGoogleTask}
            foldDone={shownOffset !== calendarOffset}
          />
          {shownOffset !== calendarOffset && <div className="calendar-subtitle">Coming up tomorrow</div>}
          {shownOffset !== calendarOffset && (
            <GoogleTasksList
              tasks={googleTasksAhead && googleTasksAhead.configured ? googleTasksAhead.tasks : []}
              onComplete={completeGoogleTask}
            />
          )}
          {calendar && calendar.date === dayFromToday(shownOffset) && (
            <CalendarDay
              calendar={calendar}
              offset={shownOffset}
              refreshing={calendarRefreshing}
              onRefresh={() => loadCalendar(true)}
            />
          )}
        </div>
      )}
      <main className="app" style={{ display: settingsOpen && !uiHidden ? undefined : 'none' }}>
        <p>
          <button type="button" onClick={resetTasks}>
            Reset Daily Tasks
          </button>{' '}
          <label className="checkbox-label">
            <input type="checkbox" checked={tasksAnyDay} onChange={(event) => setTasksAnyDay(event.target.checked)} />
            Allow changing tasks on any day
          </label>
        </p>
        <p>
          <button type="button" onClick={resetFocus}>
            Reset today's focus
          </button>
        </p>
        <p>
          <label>
            Wake-up time:{' '}
            <TimeStepper value={wakeTime} onChange={changeWakeTime} />
          </label>
        </p>
        <p>
          <label>
            UI style:{' '}
            <select value={flavor} onChange={(event) => changeFlavor(event.target.value)}>
              {FLAVORS.map(({ name, label }) => (
                <option key={name} value={name}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </p>
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
          <button
            type="button"
            onClick={() => applySkyTime(nightTime(sunTimes.times))}
            disabled={!sunTimes?.times.sunset}
            title="Midnight, or 15 minutes after astronomical dusk if that's later"
          >
            Night
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
          <p className="precipitation-toggles">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showRain}
                onChange={(event) => changeShown('showRain', event.target.checked)}
              />
              Show rain based on weather
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showSnow}
                onChange={(event) => changeShown('showSnow', event.target.checked)}
              />
              Show snow based on weather
            </label>
          </p>
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
