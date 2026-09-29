import { HillaireSkyModel } from './sky/HillaireSkyModel.js';

/*
 * Methods for calculating the sky's color. Each has a
 * calculateSkyXYZ(conditions, views) method, where each view is
 * { elevation, azimuthFromSun } in degrees, that returns the CIE XYZ color of
 * the sky in each view direction, with Y being luminance in cd/m².
 * To add a method, implement that and add it here.
 */
const SKY_MODELS = {
  hillaire2020: HillaireSkyModel,
};

// The method used for calculations
const SELECTED_SKY_MODEL = 'hillaire2020';

const DEFAULT_RESOLUTION = 1; // degrees between calculated elevations
// Range of elevations calculated, in degrees above the horizon
const MIN_ELEVATION = 5;
const MAX_ELEVATION = 80;

// Used for any condition that isn't given
const DEFAULT_CONDITIONS = {
  sunDistance: 1, // astronomical units
  surfacePressure: 1013.25, // hPa
  temperature: 15, // °C
  aerosolOpticalDepth: 0.1, // amount of haze, at 550 nm; typical for a fairly clear day
  angstromExponent: 1.3, // how much more haze scatters blue than red; typical over land
  ozoneColumn: 300, // Dobson units; typical
  groundAlbedo: 0.15, // fraction of sunlight the ground reflects
};

/**
 * Calculates the clear-sky color looking toward the sun, from MIN_ELEVATION up
 * to MAX_ELEVATION, every `resolution` degrees.
 *
 * `conditions` needs sunElevation (degrees above the horizon, negative when
 * the sun has set). Anything in DEFAULT_CONDITIONS can also be given.
 *
 * Returns [{ elevation, hue, saturation, brightness }], from the lowest up.
 * Hue (0–360°) and saturation (0–1) are as in HSV, calculated from linear-light
 * sRGB. Brightness is luminance in cd/m²: 0 for no light, with no upper limit.
 */
export function CalculateSkyColors(conditions, resolution = DEFAULT_RESOLUTION) {
  if (!Number.isFinite(conditions.sunElevation)) {
    throw new Error('sunElevation is required');
  }
  if (!(resolution > 0)) {
    throw new Error('resolution must be greater than 0');
  }
  const filledConditions = { ...DEFAULT_CONDITIONS };
  for (const [name, value] of Object.entries(conditions)) {
    if (value != null) filledConditions[name] = value;
  }

  const count = Math.floor((MAX_ELEVATION - MIN_ELEVATION) / resolution + 1e-9) + 1;
  const elevations = Array.from(
    { length: count },
    (_, i) => Math.round((MIN_ELEVATION + i * resolution) * 1e6) / 1e6,
  );
  const views = elevations.map((elevation) => ({ elevation, azimuthFromSun: 0 }));
  const colors = SKY_MODELS[SELECTED_SKY_MODEL].calculateSkyXYZ(filledConditions, views);
  return colors.map((xyz, i) => ({ elevation: elevations[i], ...toHueSaturationBrightness(xyz) }));
}

function toHueSaturationBrightness({ X, Y, Z }) {
  // CIE XYZ to linear-light sRGB
  const red = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const green = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const blue = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const brightness = Math.max(0, Y);
  if (max <= 0 || brightness === 0) {
    return { hue: 0, saturation: 0, brightness };
  }

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
  return { hue, saturation: Math.min(1, range / max), brightness };
}
