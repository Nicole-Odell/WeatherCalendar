import { OZONE_CROSS_SECTION, SOLAR_IRRADIANCE, WAVELENGTHS, spectrumToXYZ } from './spectralData.js';

/*
 * Clear-sky model from Sébastien Hillaire, "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique" (EGSR 2020), the method Unreal Engine uses.
 * Light scattered once toward the viewer is calculated directly. Light scattered
 * more than once comes from a precomputed table, which assumes that after the
 * first bounce light scatters equally in all directions. Everything is
 * calculated at each wavelength in spectralData.js, then converted to a color.
 *
 * Positions are described by their distance r from Earth's center, and
 * directions by the cosine of their angle from straight up (mu for a ray, muSun
 * for the sun). nu is the cosine of the angle between a ray and the sun.
 */

const WAVELENGTH_COUNT = WAVELENGTHS.length;

// Planet and atmosphere size, in meters
const GROUND_RADIUS = 6360e3;
const TOP_RADIUS = 6460e3;
const ATMOSPHERE_HEIGHT = TOP_RADIUS - GROUND_RADIUS;
// Distance from the top of the atmosphere to the horizon
const HORIZON_DISTANCE_FROM_TOP = Math.sqrt(TOP_RADIUS ** 2 - GROUND_RADIUS ** 2);

// Air molecules (Rayleigh scattering). Scattering scales with wavelength^-4,
// which is why the sky is blue. The coefficient is per meter, for sea-level
// air at 1013.25 hPa and 15 °C, at a wavelength of 1 µm.
const RAYLEIGH_COEFFICIENT = 1.24062e-6;
const RAYLEIGH_SCALE_HEIGHT = 8000; // meters, at 15 °C
const STANDARD_PRESSURE = 1013.25; // hPa
const STANDARD_TEMPERATURE = 288.15; // K

// Haze particles (Mie scattering)
const MIE_SCALE_HEIGHT = 1200; // meters
// Fraction of the light hitting a particle that is scattered rather than absorbed
const MIE_SINGLE_SCATTERING_ALBEDO = 0.9;
// How strongly haze scatters light forward (Henyey-Greenstein g), typical for haze
const MIE_ASYMMETRY = 0.7;

// Ozone, in a layer from 10 to 40 km that peaks at 25 km
const OZONE_PEAK_ALTITUDE = 25e3; // meters
const OZONE_HALF_WIDTH = 15e3; // meters
const DOBSON_UNIT = 2.687e20; // ozone molecules per m²

// Table sizes and integration steps
const TRANSMITTANCE_TABLE_WIDTH = 256; // ray directions
const TRANSMITTANCE_TABLE_HEIGHT = 64; // heights
const TRANSMITTANCE_STEPS = 100;
const MULTIPLE_SCATTERING_TABLE_SIZE = 32; // sun angles and heights
// Directions light is gathered from for the table, in bands from straight up
// to straight down, each split into azimuths
const MULTIPLE_SCATTERING_ELEVATIONS = 8;
const MULTIPLE_SCATTERING_AZIMUTHS = 8;
const MULTIPLE_SCATTERING_STEPS = 40;
const VIEW_STEPS = 256;

const ISOTROPIC_PHASE = 1 / (4 * Math.PI);
// Stands in for no light in the multiple scattering table, which stores
// logarithms. Anything read back below the threshold is treated as no light.
const MIN_LIGHT = 1e-30;
const NO_LIGHT_THRESHOLD = Math.log(MIN_LIGHT * 10);

export const HillaireSkyModel = {
  name: 'Hillaire 2020',

  /**
   * Returns the CIE XYZ color of the sky in each view direction, with Y being
   * luminance in cd/m². See SkyColorManager for `conditions` and `views`.
   */
  calculateSkyXYZ(conditions, views) {
    const atmosphere = getAtmosphere(conditions);
    const sunElevation = toRadians(conditions.sunElevation);
    const muSun = Math.sin(sunElevation);
    // The sun is brighter when Earth is closer to it
    const irradianceScale = 1 / conditions.sunDistance ** 2;

    return views.map(({ elevation, azimuthFromSun }) => {
      const viewElevation = toRadians(elevation);
      const mu = Math.sin(viewElevation);
      const nu = clamp(
        mu * muSun +
          Math.cos(viewElevation) * Math.cos(sunElevation) * Math.cos(toRadians(azimuthFromSun)),
        -1,
        1,
      );
      const { radiance } = integrateRay(atmosphere, GROUND_RADIUS, mu, muSun, nu, {
        steps: VIEW_STEPS,
        rayleighPhase: rayleighPhase(nu),
        miePhase: henyeyGreensteinPhase(nu, MIE_ASYMMETRY),
        includeMultipleScattering: true,
      });
      for (let k = 0; k < WAVELENGTH_COUNT; k++) {
        radiance[k] *= SOLAR_IRRADIANCE[k] * irradianceScale;
      }
      return spectrumToXYZ(radiance);
    });
  },
};

// The tables depend only on the atmosphere, not on the sun or view direction,
// so they're reused until the conditions change
let cachedAtmosphere = { key: null, atmosphere: null };

function getAtmosphere(conditions) {
  const { surfacePressure, temperature, aerosolOpticalDepth, angstromExponent, ozoneColumn, groundAlbedo } =
    conditions;
  const key = JSON.stringify([
    surfacePressure,
    temperature,
    aerosolOpticalDepth,
    angstromExponent,
    ozoneColumn,
    groundAlbedo,
  ]);
  if (cachedAtmosphere.key !== key) {
    cachedAtmosphere = { key, atmosphere: createAtmosphere(conditions) };
  }
  return cachedAtmosphere.atmosphere;
}

function createAtmosphere({
  surfacePressure,
  temperature,
  aerosolOpticalDepth,
  angstromExponent,
  ozoneColumn,
  groundAlbedo,
}) {
  // The amount of air overhead depends only on the surface pressure. Warmer air
  // thins out more slowly with height, so it's spread over a greater height.
  const temperatureKelvin = temperature + 273.15;
  const rayleighScaleHeight = RAYLEIGH_SCALE_HEIGHT * (temperatureKelvin / STANDARD_TEMPERATURE);
  const rayleighDensity =
    (surfacePressure / STANDARD_PRESSURE) * (STANDARD_TEMPERATURE / temperatureKelvin);
  const ozonePeakDensity = (ozoneColumn * DOBSON_UNIT) / OZONE_HALF_WIDTH; // molecules/m³

  const atmosphere = {
    rayleighScaleHeight,
    groundAlbedo,
    rayleighScattering: new Float64Array(WAVELENGTH_COUNT),
    mieScattering: new Float64Array(WAVELENGTH_COUNT),
    mieExtinction: new Float64Array(WAVELENGTH_COUNT),
    ozoneAbsorption: new Float64Array(WAVELENGTH_COUNT),
  };
  for (let k = 0; k < WAVELENGTH_COUNT; k++) {
    const wavelength = WAVELENGTHS[k];
    atmosphere.rayleighScattering[k] =
      RAYLEIGH_COEFFICIENT * rayleighDensity * (wavelength / 1000) ** -4;
    // Aerosol optical depth is measured at 550 nm; the Ångström exponent sets
    // how it changes with wavelength
    atmosphere.mieExtinction[k] =
      (aerosolOpticalDepth / MIE_SCALE_HEIGHT) * (wavelength / 550) ** -angstromExponent;
    atmosphere.mieScattering[k] = atmosphere.mieExtinction[k] * MIE_SINGLE_SCATTERING_ALBEDO;
    atmosphere.ozoneAbsorption[k] = OZONE_CROSS_SECTION[k] * ozonePeakDensity;
  }
  atmosphere.transmittance = buildTransmittanceTable(atmosphere);
  atmosphere.multipleScattering = buildMultipleScatteringTable(atmosphere);
  return atmosphere;
}

/**
 * Adds up the light scattered toward the start of a ray, for sunlight of
 * irradiance 1 at every wavelength. Returns that radiance, and `transfer`: the
 * fraction of light arriving evenly from all directions along the ray that
 * gets scattered back toward the start (used for the multiple scattering table).
 */
function integrateRay(
  atmosphere,
  r,
  mu,
  muSun,
  nu,
  { steps, rayleighPhase, miePhase, includeMultipleScattering, groundAlbedo = 0 },
) {
  const hitsGround = rayIntersectsGround(r, mu);
  const length = hitsGround ? distanceToGround(r, mu) : distanceToTop(r, mu);
  const dt = length / steps;
  const radiance = new Float64Array(WAVELENGTH_COUNT);
  const transfer = new Float64Array(WAVELENGTH_COUNT);
  const throughput = new Float64Array(WAVELENGTH_COUNT).fill(1);
  const sunTransmittance = new Float64Array(WAVELENGTH_COUNT);
  const multipleScattering = new Float64Array(WAVELENGTH_COUNT);

  for (let step = 0; step < steps; step++) {
    const t = (step + 0.5) * dt;
    const rHere = Math.sqrt(r * r + t * t + 2 * r * t * mu);
    const height = Math.max(0, rHere - GROUND_RADIUS);
    const muSunHere = clamp((r * muSun + t * nu) / rHere, -1, 1);
    const rayleighDensity = Math.exp(-height / atmosphere.rayleighScaleHeight);
    const mieDensity = Math.exp(-height / MIE_SCALE_HEIGHT);
    const ozoneDensityHere = ozoneDensity(height);
    // Points in Earth's shadow get no direct sunlight
    const sunVisible = !rayIntersectsGround(rHere, muSunHere);
    if (sunVisible) {
      lookUpTransmittance(atmosphere, rHere, muSunHere, sunTransmittance);
    }
    if (includeMultipleScattering) {
      lookUpMultipleScattering(atmosphere, height, muSunHere, multipleScattering);
    }

    for (let k = 0; k < WAVELENGTH_COUNT; k++) {
      const rayleigh = atmosphere.rayleighScattering[k] * rayleighDensity;
      const mie = atmosphere.mieScattering[k] * mieDensity;
      const extinction =
        rayleigh +
        atmosphere.mieExtinction[k] * mieDensity +
        atmosphere.ozoneAbsorption[k] * ozoneDensityHere;
      let scattered = sunVisible
        ? sunTransmittance[k] * (rayleigh * rayleighPhase + mie * miePhase)
        : 0;
      if (includeMultipleScattering) {
        scattered += (rayleigh + mie) * multipleScattering[k];
      }
      // Integrate over the step, treating the air as uniform within it and
      // allowing for light lost within the step (the paper's energy-conserving form)
      const stepTransmittance = Math.exp(-extinction * dt);
      const stepLength = extinction > 0 ? (1 - stepTransmittance) / extinction : dt;
      radiance[k] += throughput[k] * scattered * stepLength;
      transfer[k] += throughput[k] * (rayleigh + mie) * stepLength;
      throughput[k] *= stepTransmittance;
    }
  }

  // Sunlight reflected by the ground where the ray hits it
  if (hitsGround && groundAlbedo > 0) {
    const muSunAtGround = (r * muSun + length * nu) / GROUND_RADIUS;
    if (muSunAtGround > 0) {
      lookUpTransmittance(atmosphere, GROUND_RADIUS, muSunAtGround, sunTransmittance);
      for (let k = 0; k < WAVELENGTH_COUNT; k++) {
        radiance[k] +=
          (throughput[k] * sunTransmittance[k] * muSunAtGround * groundAlbedo) / Math.PI;
      }
    }
  }

  return { radiance, transfer };
}

/*
 * Transmittance table: the fraction of light at each wavelength that makes it
 * from a point to the top of the atmosphere, for every height and every
 * direction that doesn't hit the ground. Uses Bruneton's layout, which puts
 * more entries near the horizon, where transmittance changes fastest.
 */
function buildTransmittanceTable(atmosphere) {
  const width = TRANSMITTANCE_TABLE_WIDTH;
  const height = TRANSMITTANCE_TABLE_HEIGHT;
  const table = new Float64Array(width * height * WAVELENGTH_COUNT);
  for (let j = 0; j < height; j++) {
    const rho = HORIZON_DISTANCE_FROM_TOP * (j / (height - 1));
    const r = Math.sqrt(rho * rho + GROUND_RADIUS ** 2);
    const minDistance = TOP_RADIUS - r;
    const maxDistance = rho + HORIZON_DISTANCE_FROM_TOP;
    for (let i = 0; i < width; i++) {
      const distance = minDistance + (i / (width - 1)) * (maxDistance - minDistance);
      const mu =
        distance === 0
          ? 1
          : clamp(
              (HORIZON_DISTANCE_FROM_TOP ** 2 - rho * rho - distance * distance) / (2 * r * distance),
              -1,
              1,
            );
      const depth = opticalDepths(atmosphere, r, mu, distance);
      const offset = (j * width + i) * WAVELENGTH_COUNT;
      for (let k = 0; k < WAVELENGTH_COUNT; k++) {
        table[offset + k] = Math.exp(
          -(
            atmosphere.rayleighScattering[k] * depth.rayleigh +
            atmosphere.mieExtinction[k] * depth.mie +
            atmosphere.ozoneAbsorption[k] * depth.ozone
          ),
        );
      }
    }
  }
  return table;
}

// Density of air, haze and ozone summed along a ray, in density-weighted meters
function opticalDepths(atmosphere, r, mu, length) {
  const dt = length / TRANSMITTANCE_STEPS;
  let rayleigh = 0;
  let mie = 0;
  let ozone = 0;
  for (let step = 0; step < TRANSMITTANCE_STEPS; step++) {
    const t = (step + 0.5) * dt;
    const height = Math.max(0, Math.sqrt(r * r + t * t + 2 * r * t * mu) - GROUND_RADIUS);
    rayleigh += Math.exp(-height / atmosphere.rayleighScaleHeight);
    mie += Math.exp(-height / MIE_SCALE_HEIGHT);
    ozone += ozoneDensity(height);
  }
  return { rayleigh: rayleigh * dt, mie: mie * dt, ozone: ozone * dt };
}

function lookUpTransmittance(atmosphere, r, mu, out) {
  const rho = Math.sqrt(Math.max(0, r * r - GROUND_RADIUS ** 2));
  const minDistance = TOP_RADIUS - r;
  const maxDistance = rho + HORIZON_DISTANCE_FROM_TOP;
  const u =
    maxDistance > minDistance
      ? (distanceToTop(r, mu) - minDistance) / (maxDistance - minDistance)
      : 0;
  const v = rho / HORIZON_DISTANCE_FROM_TOP;
  interpolate(atmosphere.transmittance, TRANSMITTANCE_TABLE_WIDTH, TRANSMITTANCE_TABLE_HEIGHT, u, v, out);
}

/*
 * Multiple scattering table (Ψms in the paper): light that has scattered more
 * than once, for sunlight of irradiance 1, by sun direction (muSun from -1 to 1)
 * and height. Entries are closer together near the ground, and for the sun near
 * the horizon, where twilight makes the light change quickly.
 */
function buildMultipleScatteringTable(atmosphere) {
  const size = MULTIPLE_SCATTERING_TABLE_SIZE;
  const table = new Float64Array(size * size * WAVELENGTH_COUNT);
  const secondOrder = new Float64Array(WAVELENGTH_COUNT);
  const transfer = new Float64Array(WAVELENGTH_COUNT);
  const rayOptions = {
    steps: MULTIPLE_SCATTERING_STEPS,
    rayleighPhase: ISOTROPIC_PHASE,
    miePhase: ISOTROPIC_PHASE,
    includeMultipleScattering: false,
    groundAlbedo: atmosphere.groundAlbedo,
  };
  const directions = gatheringDirections();

  for (let j = 0; j < size; j++) {
    const r = GROUND_RADIUS + ATMOSPHERE_HEIGHT * (j / (size - 1)) ** 2;
    for (let i = 0; i < size; i++) {
      const muSun = fromSignedSquareRoot(i / (size - 1));
      secondOrder.fill(0);
      transfer.fill(0);
      for (const { mu, cosAzimuth, weight } of directions) {
        const nu = mu * muSun + Math.sqrt(1 - mu * mu) * Math.sqrt(1 - muSun * muSun) * cosAzimuth;
        const ray = integrateRay(atmosphere, r, mu, muSun, nu, rayOptions);
        for (let k = 0; k < WAVELENGTH_COUNT; k++) {
          secondOrder[k] += ray.radiance[k] * weight;
          transfer[k] += ray.transfer[k] * weight;
        }
      }
      const offset = (j * size + i) * WAVELENGTH_COUNT;
      for (let k = 0; k < WAVELENGTH_COUNT; k++) {
        // Each further bounce passes on the same fraction of the light, so all
        // bounces together are 1 + f + f² + ... = 1 / (1 - f) times the second
        const light = secondOrder[k] / (1 - transfer[k]);
        // Stored as a logarithm: in twilight the light falls off exponentially
        // as the sun sinks, which interpolates badly as a straight line
        table[offset + k] = Math.log(Math.max(light, MIN_LIGHT));
      }
    }
  }
  return table;
}

/*
 * Directions covering the whole sphere, each weighted by the share of the
 * sphere it stands for, so the weights add up to 1. The bands are closer
 * together near the horizon, where twilight light comes from. Directions
 * mirrored across the sun's vertical plane give the same result, so only half
 * of the azimuths are included.
 */
function gatheringDirections() {
  const bands = MULTIPLE_SCATTERING_ELEVATIONS;
  const azimuths = MULTIPLE_SCATTERING_AZIMUTHS;
  const directions = [];
  for (let a = 0; a < bands; a++) {
    // mu = s|s| for s spread evenly from 1 to -1, so the share of the sphere
    // each band covers is proportional to |dmu/ds| = 2|s|
    const s = 1 - (2 * (a + 0.5)) / bands;
    for (let b = 0; b < azimuths / 2; b++) {
      directions.push({
        mu: s * Math.abs(s),
        cosAzimuth: Math.cos((2 * Math.PI * (b + 0.5)) / azimuths),
        weight: Math.abs(s),
      });
    }
  }
  const totalWeight = directions.reduce((total, direction) => total + direction.weight, 0);
  for (const direction of directions) {
    direction.weight /= totalWeight;
  }
  return directions;
}

function lookUpMultipleScattering(atmosphere, height, muSun, out) {
  const size = MULTIPLE_SCATTERING_TABLE_SIZE;
  const u = toSignedSquareRoot(muSun);
  const v = Math.sqrt(clamp(height / ATMOSPHERE_HEIGHT, 0, 1));
  interpolate(atmosphere.multipleScattering, size, size, u, v, out);
  for (let k = 0; k < WAVELENGTH_COUNT; k++) {
    out[k] = out[k] <= NO_LIGHT_THRESHOLD ? 0 : Math.exp(out[k]);
  }
}

// Maps 0–1 to -1–1, with values closer together near 0
function fromSignedSquareRoot(u) {
  const s = 2 * u - 1;
  return s * Math.abs(s);
}

function toSignedSquareRoot(value) {
  return (Math.sign(value) * Math.sqrt(Math.abs(value)) + 1) / 2;
}

// Bilinear interpolation between the table entries around (u, v), each 0 to 1
function interpolate(table, width, height, u, v, out) {
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.min(Math.floor(x), width - 2);
  const y0 = Math.min(Math.floor(y), height - 2);
  const fx = x - x0;
  const fy = y - y0;
  const o00 = (y0 * width + x0) * WAVELENGTH_COUNT;
  const o10 = o00 + WAVELENGTH_COUNT;
  const o01 = o00 + width * WAVELENGTH_COUNT;
  const o11 = o01 + WAVELENGTH_COUNT;
  for (let k = 0; k < WAVELENGTH_COUNT; k++) {
    out[k] =
      (table[o00 + k] * (1 - fx) + table[o10 + k] * fx) * (1 - fy) +
      (table[o01 + k] * (1 - fx) + table[o11 + k] * fx) * fy;
  }
}

function rayleighPhase(nu) {
  return (3 / (16 * Math.PI)) * (1 + nu * nu);
}

function henyeyGreensteinPhase(nu, g) {
  const denominator = 1 + g * g - 2 * g * nu;
  return (1 - g * g) / (4 * Math.PI * denominator * Math.sqrt(denominator));
}

function ozoneDensity(height) {
  return Math.max(0, 1 - Math.abs(height - OZONE_PEAK_ALTITUDE) / OZONE_HALF_WIDTH);
}

function rayIntersectsGround(r, mu) {
  return mu < 0 && r * r * (mu * mu - 1) + GROUND_RADIUS ** 2 >= 0;
}

function distanceToGround(r, mu) {
  const discriminant = r * r * (mu * mu - 1) + GROUND_RADIUS ** 2;
  return Math.max(0, -r * mu - Math.sqrt(Math.max(0, discriminant)));
}

function distanceToTop(r, mu) {
  const discriminant = r * r * (mu * mu - 1) + TOP_RADIUS ** 2;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, discriminant)));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
