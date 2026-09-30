import { Worker } from 'node:worker_threads';
import { SELECTED_SKY_MODEL, SKY_MODELS } from './sky/skyModels.js';

const DEFAULT_RESOLUTION = 1; // degrees between calculated elevations
// Range of elevations calculated, in degrees above the horizon
const MIN_ELEVATION = 5;
const MAX_ELEVATION = 80;
// Heights (km) that direct sunlight is calculated at, covering the cloud layers
const SUNLIGHT_HEIGHTS = Array.from({ length: 13 }, (_, i) => i);

// Used for any condition that isn't given. The weather values here are only
// used for the atmosphere tables (see UpdateAtmosphere).
const DEFAULT_CONDITIONS = {
  sunDistance: 1, // astronomical units
  surfacePressure: 1013.25, // hPa
  temperature: 15, // °C
  aerosolOpticalDepth: 0.1, // amount of haze, at 550 nm; typical for a fairly clear day
  angstromExponent: 1.3, // how much more haze scatters blue than red; typical over land
  ozoneColumn: 300, // Dobson units; typical
  groundAlbedo: 0.15, // fraction of sunlight the ground reflects
};

// Weather values the atmosphere tables are built from
const ATMOSPHERE_FIELDS = [
  'surfacePressure',
  'temperature',
  'aerosolOpticalDepth',
  'angstromExponent',
  'ozoneColumn',
  'groundAlbedo',
];

/*
 * How much each weather value can change before the tables are rebuilt: about
 * 1–2 steps (of 255) of on-screen change each, measured across the day. The
 * changes are added up, each as a share of its amount here, and the tables
 * are rebuilt once the total reaches 1, so small changes in several values
 * together count too. Changes are measured from the values the current tables
 * were built from, so slow drift adds up rather than going unnoticed.
 */
const SIGNIFICANT_CHANGE = {
  surfacePressure: 10, // hPa
  temperature: 3, // °C
  aerosolOpticalDepth: 0.005,
  angstromExponent: 0.1,
  ozoneColumn: 20, // Dobson units
  groundAlbedo: 0.05,
};

/*
 * The atmosphere tables in use, and the weather values they were built from.
 * New tables are built on a worker thread and only replace these once they're
 * finished, so the sky keeps using the previous weather until then.
 */
let current = null; // { atmosphere, conditions, builtAt }
let building = null; // { conditions, promise }
let queued = null; // conditions to build once the current build finishes
let worker = null;
let nextBuildId = 0;
const pendingBuilds = new Map();

/**
 * Starts rebuilding the atmosphere tables if `weather` ({ surfacePressure,
 * temperature, aerosolOpticalDepth }, missing values use the defaults) differs
 * significantly from what the tables in use (or being built) were built from.
 * Returns a promise that settles once the tables in use match `weather`.
 */
export function UpdateAtmosphere(weather) {
  const target = atmosphereConditions(weather);
  if (building) {
    if (isSignificantChange(building.conditions, target)) queued = target;
    return building.promise;
  }
  if (current && !isSignificantChange(current.conditions, target)) return Promise.resolve();
  return startBuild(target);
}

/**
 * The weather values the atmosphere tables in use were built from, when they
 * were built, and whether new ones are being built
 */
export function GetAtmosphereStatus() {
  return {
    conditions: current?.conditions ?? null,
    builtAt: current?.builtAt ?? null,
    rebuilding: Boolean(building),
  };
}

// Resolves once there are atmosphere tables to use
export async function WhenAtmosphereReady() {
  if (!current) await (building?.promise ?? UpdateAtmosphere({}));
}

function atmosphereConditions(weather) {
  const conditions = {};
  for (const field of ATMOSPHERE_FIELDS) {
    conditions[field] = weather[field] ?? DEFAULT_CONDITIONS[field];
  }
  return conditions;
}

function isSignificantChange(from, to) {
  let total = 0;
  for (const field of ATMOSPHERE_FIELDS) {
    total += Math.abs(to[field] - from[field]) / SIGNIFICANT_CHANGE[field];
  }
  return total >= 1;
}

function startBuild(conditions) {
  const started = performance.now();
  const promise = buildOnWorker(conditions)
    .then((atmosphere) => {
      current = { atmosphere, conditions, builtAt: new Date().toISOString() };
      console.log(
        `Atmosphere tables built in ${Math.round(performance.now() - started)} ms for`,
        conditions,
      );
    })
    .finally(() => {
      building = null;
      const next = queued;
      queued = null;
      if (next && (!current || isSignificantChange(current.conditions, next))) startBuild(next);
    });
  building = { conditions, promise };
  return promise;
}

function buildOnWorker(conditions) {
  if (!worker) {
    worker = new Worker(new URL('./sky/atmosphereWorker.js', import.meta.url));
    worker.on('message', ({ id, atmosphere, error }) => {
      const pending = pendingBuilds.get(id);
      pendingBuilds.delete(id);
      if (error) pending?.reject(new Error(error));
      else pending?.resolve(atmosphere);
    });
    worker.on('error', (error) => {
      for (const pending of pendingBuilds.values()) pending.reject(error);
      pendingBuilds.clear();
      worker = null;
    });
  }
  const id = ++nextBuildId;
  return new Promise((resolve, reject) => {
    pendingBuilds.set(id, { resolve, reject });
    worker.postMessage({ id, model: SELECTED_SKY_MODEL, conditions });
  });
}

function currentAtmosphere() {
  if (!current) throw new Error('The atmosphere tables are not built yet');
  return current.atmosphere;
}

/**
 * Calculates the clear-sky color looking toward the sun, from MIN_ELEVATION up
 * to MAX_ELEVATION, every `resolution` degrees, with the atmosphere tables in
 * use (see UpdateAtmosphere).
 *
 * `conditions` needs sunElevation (degrees above the horizon, negative when
 * the sun has set), and can have sunDistance.
 *
 * Returns [{ elevation, hue, saturation, brightness }], from the lowest up.
 * Hue (0–360°) and saturation (0–1) are as in HSV, calculated from linear-light
 * sRGB. Brightness is luminance in cd/m²: 0 for no light, with no upper limit.
 */
export function CalculateSkyColors(conditions, resolution = DEFAULT_RESOLUTION) {
  if (!(resolution > 0)) {
    throw new Error('resolution must be greater than 0');
  }
  const filledConditions = fillConditions(conditions);
  const count = Math.floor((MAX_ELEVATION - MIN_ELEVATION) / resolution + 1e-9) + 1;
  const elevations = Array.from(
    { length: count },
    (_, i) => Math.round((MIN_ELEVATION + i * resolution) * 1e6) / 1e6,
  );
  const views = elevations.map((elevation) => ({ elevation, azimuthFromSun: 0 }));
  const colors = SKY_MODELS[SELECTED_SKY_MODEL].calculateSkyXYZ(
    currentAtmosphere(),
    filledConditions,
    views,
  );
  return colors.map((xyz, i) => ({ elevation: elevations[i], ...toHueSaturationBrightness(xyz) }));
}

/**
 * Calculates the color of direct sunlight at heights from the ground up to
 * 12 km, after passing through the atmosphere: nearly white when the sun is
 * high, deep orange as it sets. The colors are white-balanced to sunlight
 * above the atmosphere, as eyes adjust to daylight, so the only tint is the
 * one the atmosphere adds. `conditions` are the same as for CalculateSkyColors.
 *
 * Returns [{ height, hue, saturation, glowHue, glowSaturation, illuminance }],
 * with height in km, hue and saturation (white-balanced) as for
 * CalculateSkyColors, glowHue and glowSaturation the same color without white
 * balance (more saturated, for glowing cloud edges), and illuminance in lux on
 * a surface facing the sun (0 where Earth blocks the sun). Uses the
 * atmosphere tables in use (see UpdateAtmosphere).
 */
export function CalculateSunlight(conditions) {
  const filled = fillConditions(conditions);
  const model = SKY_MODELS[SELECTED_SKY_MODEL];
  const atmosphere = currentAtmosphere();
  const sunlight = model.calculateSunlightXYZ(atmosphere, filled, SUNLIGHT_HEIGHTS);
  // Sunlight above the atmosphere, straight overhead, is the white reference
  const [space] = model.calculateSunlightXYZ(
    atmosphere,
    { ...filled, sunElevation: 90 },
    [SPACE_HEIGHT],
  );
  const white = toLinearRgb(space);
  return sunlight.map((xyz, i) => {
    const rgb = toLinearRgb(xyz);
    const { hue, saturation } = rgbToHueSaturation(rgb.map((value, c) => value / white[c]));
    const glow = rgbToHueSaturation(rgb);
    return {
      height: SUNLIGHT_HEIGHTS[i],
      hue,
      saturation,
      glowHue: glow.hue,
      glowSaturation: glow.saturation,
      illuminance: Math.max(0, xyz.Y),
    };
  });
}

// A height (km) above the atmosphere, where sunlight hasn't been dimmed at all
const SPACE_HEIGHT = 1000;

// The conditions with defaults for anything not given
function fillConditions(conditions) {
  if (!Number.isFinite(conditions.sunElevation)) {
    throw new Error('sunElevation is required');
  }
  const filled = { ...DEFAULT_CONDITIONS };
  for (const [name, value] of Object.entries(conditions)) {
    if (value != null) filled[name] = value;
  }
  return filled;
}

function toHueSaturationBrightness(xyz) {
  const brightness = Math.max(0, xyz.Y);
  if (brightness === 0) return { hue: 0, saturation: 0, brightness };
  return { ...rgbToHueSaturation(toLinearRgb(xyz)), brightness };
}

// CIE XYZ to linear-light sRGB [red, green, blue]
function toLinearRgb({ X, Y, Z }) {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
}

// Hue (0–360°) and saturation (0–1), as in HSV, of a linear-light sRGB color
function rgbToHueSaturation([red, green, blue]) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max <= 0) return { hue: 0, saturation: 0 };

  const range = max - min;
  let hue = 0;
  if (range > 0) {
    if (max === red) hue = (green - blue) / range;
    else if (max === green) hue = (blue - red) / range + 2;
    else hue = (red - green) / range + 4;
    hue = (hue * 60 + 360) % 360;
  }
  // Colors too saturated for sRGB have a negative channel. They keep their hue
  // and get full saturation.
  return { hue, saturation: Math.min(1, range / max) };
}
