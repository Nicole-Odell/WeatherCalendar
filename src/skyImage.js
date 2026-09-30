import { decodeSrgb, encodeSrgb, hsvToLinearRgb, withScreenBrightness } from './color.js';
import { fractalNoise, noiseQuantile } from './noise.js';

/*
 * Draws the sky, stars, clouds and haze shown behind the page. The sky colors
 * run from their lowest elevation at the bottom of the screen to their highest
 * at the top. Clouds are drawn in bands by altitude, from the ground at the
 * bottom of the screen to CLOUD_TOP_HEIGHT at the top. Each cloud covers
 * what's behind it in proportion to its opacity, mixed in linear light, as a
 * real cloud blocks the sky behind it and adds its own light. The stars go over
 * the sky, the cloud layers over them, and the haze over everything.
 */

const CLOUD_TOP_HEIGHT = 10; // km, at the top of the screen

// Eigengrau (#16161D), the color the eye sees in total darkness, is used in
// place of pure black. BLACK_LEVEL is eigengrau at the lowest 8-bit brightness
// that keeps its hue (240°) and saturation (0.24 vs 0.25): the darkest the sky
// is shown, with brighter values scaling from it up to white.
const EIGENGRAU = [22, 22, 29];
const BLACK_LEVEL = [3, 3, 4];
// Eigengrau's hue and saturation at full brightness, for faint stars
const EIGENGRAU_TINT = EIGENGRAU.map((value) => value / Math.max(...EIGENGRAU));

// Cloud layers from the weather data, with how many noise features fit across
// and up one screen height (wider than tall, like real cloud layers). The low
// band is drawn twice as tall, centered on the bottom of the screen, so only its
// top half shows and it has no edge along the bottom.
// `height` is the layer's typical altitude in km, used to decide when it's lit
// from below. `speed` is how fast it drifts sideways, in screen heights per second.
const CLOUD_LAYERS = [
  { name: 'low', bottom: -3, top: 3, height: 1.5, speed: 0.0012, frequency: [3, 6], offset: 0 },
  { name: 'mid', bottom: 3, top: 8, height: 5.5, speed: 0.0009, frequency: [2.5, 5], offset: 100 },
  { name: 'high', bottom: 8, top: 10, height: 9, speed: 0.0015, frequency: [1.5, 10], offset: 200 },
];
// How fast cloud shapes change as the noise shifts through itself, in noise
// units per second. Cloud motion depends only on the clock time, so it stays
// smooth whatever other settings change.
const CLOUD_EVOLUTION = 0.002;

/*
 * Clouds are lit from below once the sun is beneath their own horizontal.
 * Each layer is treated as sitting on our horizon toward the sun, which for
 * height h is √(2Rh) away. Earth's curvature makes the sun higher there by the
 * angle acos(R / (R + h)), so the layer is lit from below once the sun is
 * that far below our horizon. Its brightness then flips top to bottom within
 * its band, blending in over LIT_FROM_BELOW_BLEND degrees of sun elevation.
 */
const EARTH_RADIUS = 6371; // km
const LIT_FROM_BELOW_BLEND = 1; // degrees
// How soft the edges of gaps in the clouds are, in noise units
const COVER_SOFTNESS = 0.04;
// Share of a band's height at its top and bottom where its lumpy edges can be
const EDGE_ZONE = 0.3;
const EDGE_FREQUENCY = 5; // lumps per screen height
const EDGE_SOFTNESS = 0.15;

// A white haze over the whole sky: none up to 50% total cover, rising to 95%
// opacity at 100%
const HAZE_START = 50;
const HAZE_MAX_OPACITY = 0.95;
// Above CLOUD_FADE_START total cover, cloud layers fade into the haze, from
// fully opaque there to CLOUD_FADE_END_OPACITY at 100%
const CLOUD_FADE_START = 75;
const CLOUD_FADE_END_OPACITY = 0.05;
// How much the haze's brightness differences from top to bottom are changed:
// each row's distance from the haze's average on-screen brightness is
// multiplied by a factor. Above 1 exaggerates them, below 1 reduces them. The
// factor is the maximum when the brightest sky color is at or above the
// exposure ceiling, the minimum when it's at or below the floor, and in
// between it follows the on-screen brightness of the brightest sky color.
export const DEFAULT_HAZE_CONTRAST = { min: 0.1, max: 2 };

// Thick haze is darker, as overcast days are: its on-screen brightness is cut
// by up to this share at 100% total cover, rising from none at HAZE_START
const HAZE_MAX_DIMMING = 0.3;

// Clouds are brighter than the sky in daylight and darker at dusk. They're
// shown as neutral gray at the sky's on-screen luminance times
// (sky luminance / pivot)^exponent, so at the pivot (cd/m²) they match the sky.
export const DEFAULT_CLOUD_BRIGHTNESS = { pivot: 500, exponent: 0.5 };

/*
 * The scene is drawn as three layers, stacked by the browser with normal
 * blending: the sky, the cloud layers (with transparency), and the haze (with
 * transparency). The sky and the haze only vary from top to bottom, so they're
 * drawn as one-pixel-wide columns and stretched across the screen.
 *
 * The browser blends layers using on-screen values, but clouds and haze should
 * mix with the sky in linear light, as real light does. So each cloud and haze
 * pixel's color is chosen so that the browser's blend over the sky behind it
 * gives the linear-light result. (Haze over a cloud is blended by the browser
 * as-is, since the haze doesn't change as the clouds move.)
 *
 * The settings for all of them are:
 * - colors: the sky colors from the server, lowest elevation first
 * - sunElevation: in degrees
 * - exposure: { floor, ceiling }
 * - clouds: { total, low, mid, high } cover in percent
 * - cloudBrightness: { pivot, exponent } (see DEFAULT_CLOUD_BRIGHTNESS)
 * - hazeContrast: { min, max } (see DEFAULT_HAZE_CONTRAST)
 * - time: the clock time in seconds, which sets where the clouds have drifted to
 */

/**
 * Draws the sky into `pixels`: an RGBA column 1 pixel wide and `height` tall
 */
export function renderSkyColumn(pixels, height, settings) {
  const { sky } = rowColors(settings, height);
  for (let row = 0; row < height; row++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[row * 4 + channel] = toScreenValue(sky[row][channel], channel);
    }
    pixels[row * 4 + 3] = 255;
  }
}

/**
 * Draws the haze into `pixels`: an RGBA column 1 pixel wide and `height` tall,
 * to go over the sky and clouds
 */
export function renderHazeColumn(pixels, height, settings) {
  const { scene, sky, haze } = rowColors(settings, height);
  const alpha = Math.round(255 * scene.hazeOpacity);
  for (let row = 0; row < height; row++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[row * 4 + channel] = colorOver(sky[row][channel], haze[row], alpha, channel);
    }
    pixels[row * 4 + 3] = alpha;
  }
}

/**
 * Draws the cloud layers into `pixels` (RGBA, width × height), to go over the
 * sky and under the haze. Returns the average color of the whole scene (sky,
 * clouds and haze, without stars), in linear-light sRGB.
 */
export function renderClouds(pixels, width, height, settings) {
  const { scene, sky, cloud, haze, rowHeight, layerAt } = rowColors(settings, height);
  const { cloudMaxOpacity, hazeOpacity } = scene;
  const total = [0, 0, 0];
  for (let row = 0; row < height; row++) {
    const up = rowHeight(row);
    const layer = layerAt(up);
    for (let column = 0; column < width; column++) {
      const opacity =
        layer && cloudMaxOpacity > 0
          ? cloudMaxOpacity * cloudOpacity(layer, (column + 0.5) / height, up)
          : 0;
      const alpha = Math.round(255 * opacity);
      const offset = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = alpha > 0 ? colorOver(sky[row][channel], cloud[row], alpha, channel) : 0;
        // The whole scene at this pixel, for the average
        let value = sky[row][channel];
        value += (cloud[row] - value) * (alpha / 255);
        value += (haze[row] - value) * hazeOpacity;
        total[channel] += value;
      }
      pixels[offset + 3] = alpha;
    }
  }
  return total.map((value) => value / (width * height));
}

/**
 * Each row's colors, in linear light, for a screen `height` rows tall: the sky,
 * and the brightness of the clouds and of the haze
 */
function rowColors(settings, height) {
  const { colors, cloudBrightness, hazeContrast: contrastRange } = settings;
  const scene = prepareScene(settings);
  const { toScreen, skyAt, layers, hazeDimming } = scene;

  // Brightness (linear light) of cloud lit like the given sky sample
  const cloudLightFrom = ({ rgb: [red, green, blue], luminance }) => {
    const skyOnScreen = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return Math.min(1, skyOnScreen * cloudToSkyRatio(luminance, cloudBrightness));
  };

  const rowHeight = (row) => 1 - (row + 0.5) / height; // 0 at the bottom of the screen, 1 at the top
  const layerAt = (up) => layers.find((l) => up >= l.bottomOnScreen && up < l.topOnScreen);
  const sky = Array.from({ length: height }, (_, row) => skyAt(rowHeight(row)).rgb);

  // Cloud layers take their brightness from the sky at the mirrored height,
  // so higher clouds are lit like the brighter sky near the horizon. A layer
  // lit from below has that brightness flipped within its visible band.
  const cloud = Array.from({ length: height }, (_, row) => {
    const up = rowHeight(row);
    const layer = layerAt(up);
    const light = cloudLightFrom(skyAt(1 - up));
    if (!(layer?.litFromBelow > 0)) return light;
    const flippedUp = Math.max(0, layer.bottomOnScreen) + Math.min(1, layer.topOnScreen) - up;
    return light + (cloudLightFrom(skyAt(1 - flippedUp)) - light) * layer.litFromBelow;
  });
  const brightestCloud = Math.max(...cloud);

  // The haze is lit like the sky beside it, with its contrast changed around
  // its average on-screen brightness, never brighter than the brightest cloud,
  // and then dimmed by its thickness
  const hazeOnScreen = Array.from({ length: height }, (_, row) =>
    encodeSrgb(cloudLightFrom(skyAt(rowHeight(row)))),
  );
  const hazeAverage = hazeOnScreen.reduce((sum, value) => sum + value, 0) / height;
  const brightestSky = Math.max(...colors.map((color) => color.brightness));
  const hazeContrast =
    contrastRange.min + (contrastRange.max - contrastRange.min) * toScreen(brightestSky);
  const haze = hazeOnScreen.map((value) => {
    const contrasted = clamp(hazeAverage + (value - hazeAverage) * hazeContrast, 0, 1);
    const capped = Math.min(encodeSrgb(brightestCloud), contrasted);
    return decodeSrgb(capped * (1 - hazeDimming));
  });

  return { scene, sky, cloud, haze, rowHeight, layerAt };
}

// A linear-light value (0–1) as an on-screen value (0–255), from the black level up
function toScreenValue(linear, channel) {
  return BLACK_LEVEL[channel] + (255 - BLACK_LEVEL[channel]) * encodeSrgb(linear);
}

/**
 * The on-screen color value (0–255) for a layer pixel with opacity
 * `alpha` (0–255) and color `light` (linear light), so that the browser's
 * blend over `behind` (linear light) gives the linear-light mix of the two
 */
function colorOver(behind, light, alpha, channel) {
  const opacity = alpha / 255;
  const target = toScreenValue(behind + (light - behind) * opacity, channel);
  const behindOnScreen = toScreenValue(behind, channel);
  return clamp((target - behindOnScreen * (1 - opacity)) / opacity, 0, 255);
}

/*
 * Stars: a fixed field, with far more faint stars than bright ones (about 3
 * times as many for each magnitude fainter, roughly as in the real sky). The
 * brightest have STAR_MAX_BRIGHTNESS times the exposure floor's luminance, and
 * the faintest are at the floor. They're spread by starDensity: a thin
 * background everywhere, noisy clumps, and a Milky Way–like band.
 */
const STAR_COUNT = 9000;
const STAR_MAX_BRIGHTNESS = 10; // times the exposure floor
const STAR_MAGNITUDE_RANGE = 2.5; // 2.5 magnitudes is a factor of 10 in brightness
// Stars brighten as the whole sky goes dark, like eyes adjusting to the dark.
// While the brightest sky color's on-screen brightness is at or above this,
// stars use the sky's exposure. As it falls to black, they shift to a scale
// where the brightest star is full brightness.
const STAR_DARK_ADAPTATION_START = 0.3;
// Stars have eigengrau's hue and saturation, fading to white from this share
// of the brightest star's brightness up to the brightest
const STAR_WHITE_START = 0.4;
// The Milky Way band: a line across the screen (from `start` to `end`, as
// shares of the screen's width and height) and how wide its core is
const MILKY_WAY = { start: [0, 0.2], end: [1, 0.9], width: 0.09 };
const STAR_BACKGROUND_DENSITY = 0.08;
const STAR_CLUMP_DENSITY = 0.35;
const STAR_BAND_DENSITY = 3;
const MAX_STAR_DENSITY = STAR_BACKGROUND_DENSITY + STAR_CLUMP_DENSITY + STAR_BAND_DENSITY;

// A faint glow where stars are densest, like the Milky Way's light from stars
// too faint to see one by one. It starts at STAR_GLOW_START of the densest
// star density, rising from the exposure floor (not visible) to
// STAR_GLOW_BRIGHTNESS times the floor (about as bright as the dimmest stars
// shown), tinted slightly blue.
const STAR_GLOW_START = 0.15;
const STAR_GLOW_BRIGHTNESS = 1.15;
const STAR_GLOW_TINT = [0.85, 0.92, 1];

// Relative star density at a position (shares of the screen's width and height)
function starDensity(across, up) {
  // Clumps and voids over the whole sky
  const clumps = clamp((fractalNoise(across * 6 + 400, up * 6 + 400, 4) - 0.4) / 0.25, 0, 1);

  // Distance from the band's center line, with noise bending its edges
  const [x0, y0] = MILKY_WAY.start;
  const [x1, y1] = MILKY_WAY.end;
  const length = Math.hypot(x1 - x0, y1 - y0);
  const distance = Math.abs((x1 - x0) * (y0 - up) - (x0 - across) * (y1 - y0)) / length;
  const wobble = (fractalNoise(across * 3 + 500, up * 3 + 500, 3) - 0.5) * MILKY_WAY.width;
  const band = Math.exp(-(((distance + wobble) / MILKY_WAY.width) ** 2));
  // Bright patches and dark dust lanes within the band
  const patches = clamp((fractalNoise(across * 12 + 600, up * 12 + 600, 4) - 0.3) / 0.35, 0, 1);

  return (
    STAR_BACKGROUND_DENSITY + STAR_CLUMP_DENSITY * clumps + STAR_BAND_DENSITY * band * patches
  );
}

const STARS = (() => {
  let state = 11;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const stars = [];
  while (stars.length < STAR_COUNT) {
    // Keeps random positions in proportion to the density there
    const across = random();
    const up = random();
    if (random() * MAX_STAR_DENSITY > starDensity(across, up)) continue;
    // Picks a magnitude so that counts rise by 10^0.5 per magnitude fainter
    const magnitude = 2 * Math.log10(1 + random() * (10 ** (STAR_MAGNITUDE_RANGE / 2) - 1));
    stars.push({ across, up, brightness: 10 ** (-0.4 * magnitude) });
  }
  return stars;
})();

/**
 * Returns a function giving the on-screen brightness (0–1) of starlight of a
 * given luminance at a height on screen (0 at the bottom, 1 at the top).
 * Starlight only shows where it's brighter than the sky behind it. The cloud
 * and haze layers are drawn over the stars, so they cover them.
 */
function starlightScale(settings) {
  const { toScreen, skyAt } = prepareScene(settings);
  const { floor } = settings.exposure;
  const brightestSky = Math.max(...settings.colors.map((color) => color.brightness));
  // 0 when the whole sky is black, 1 once it's bright enough to use the sky's exposure
  const skyExposureShare = clamp(toScreen(brightestSky) / STAR_DARK_ADAPTATION_START, 0, 1);
  return (luminance, up) => {
    if (luminance <= skyAt(up).luminance) return 0;
    const darkAdapted = clamp(Math.log(luminance / floor) / Math.log(STAR_MAX_BRIGHTNESS), 0, 1);
    return darkAdapted + (toScreen(luminance) - darkAdapted) * skyExposureShare;
  };
}

// Glow strength (0–1) for each pixel of a width × height image, kept for reuse
let glowStrengthCache = { key: null, strengths: null };

function glowStrengths(width, height) {
  const key = `${width}x${height}`;
  if (glowStrengthCache.key !== key) {
    const strengths = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const density =
          starDensity((column + 0.5) / width, 1 - (row + 0.5) / height) / MAX_STAR_DENSITY;
        strengths[row * width + column] = smoothstep(STAR_GLOW_START, 1, density);
      }
    }
    glowStrengthCache = { key, strengths };
  }
  return glowStrengthCache.strengths;
}

/**
 * Draws the glow where stars are densest into `pixels` (RGBA, width × height,
 * black where there's no glow), to be scaled up under the stars
 */
export function renderStarGlow(pixels, width, height, settings) {
  const starlight = starlightScale(settings);
  const { floor } = settings.exposure;
  const strengths = glowStrengths(width, height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = row * width + column;
      const strength = strengths[index];
      const level =
        strength > 0
          ? starlight(floor * (1 + (STAR_GLOW_BRIGHTNESS - 1) * strength), 1 - (row + 0.5) / height)
          : 0;
      for (let channel = 0; channel < 3; channel++) {
        pixels[index * 4 + channel] = 255 * level * STAR_GLOW_TINT[channel];
      }
      pixels[index * 4 + 3] = 255;
    }
  }
}

/**
 * Draws the stars onto the canvas `context` (width × height pixels), each
 * `starSize` pixels square, to go over the sky with a screen blend
 */
export function renderStars(context, width, height, settings, starSize) {
  const starlight = starlightScale(settings);
  const brightest = STAR_MAX_BRIGHTNESS * settings.exposure.floor;
  for (const star of STARS) {
    const level = 255 * starlight(brightest * star.brightness, star.up);
    if (level < 0.5) continue;
    const whiteness = smoothstep(STAR_WHITE_START, 1, star.brightness);
    const [red, green, blue] = EIGENGRAU_TINT.map((tint) =>
      Math.round(level * (tint + (1 - tint) * whiteness)),
    );
    context.fillStyle = `rgb(${red} ${green} ${blue})`;
    context.fillRect(
      Math.floor(star.across * width),
      Math.floor((1 - star.up) * height),
      starSize,
      starSize,
    );
  }
}

// Works out what the sky, cloud, haze and star drawing all need for a scene
function prepareScene({ colors, sunElevation, exposure, clouds, time = 0 }) {
  const toScreen = exposureScale(
    colors.map((color) => color.brightness),
    exposure,
  );
  const skyStops = colors.map(({ hue, saturation, brightness }) =>
    withScreenBrightness(hsvToLinearRgb(hue, saturation, 1), toScreen(brightness)),
  );
  // How thick the haze is, from 0 at HAZE_START total cover to 1 at 100%
  const hazeThickness = clamp((clouds.total - HAZE_START) / (100 - HAZE_START), 0, 1);
  const cloudMaxOpacity =
    1 -
    (1 - CLOUD_FADE_END_OPACITY) *
      clamp((clouds.total - CLOUD_FADE_START) / (100 - CLOUD_FADE_START), 0, 1);
  const layers = CLOUD_LAYERS.filter((layer) => clouds[layer.name] > 0).map((layer) => {
    const cover = Math.min(1, clouds[layer.name] / 100);
    // Sun elevation below which this layer is lit from below
    const flipElevation =
      -(Math.acos(EARTH_RADIUS / (EARTH_RADIUS + layer.height)) * 180) / Math.PI;
    return {
      ...layer,
      cover,
      threshold: noiseQuantile(1 - cover),
      bottomOnScreen: layer.bottom / CLOUD_TOP_HEIGHT,
      topOnScreen: Math.min(layer.top, CLOUD_TOP_HEIGHT) / CLOUD_TOP_HEIGHT,
      // 0 when lit from above, 1 when lit from below
      // How far the layer has drifted (screen heights) and its shapes have changed (noise units)
      drift: time * layer.speed,
      evolution: time * CLOUD_EVOLUTION,
      litFromBelow: smoothstep(
        flipElevation + LIT_FROM_BELOW_BLEND / 2,
        flipElevation - LIT_FROM_BELOW_BLEND / 2,
        sunElevation,
      ),
    };
  });

  // Sky color and luminance at a height on screen (0 at the bottom, 1 at the top)
  const skyAt = (up) => {
    const position = up * (colors.length - 1);
    const i = Math.min(Math.floor(position), colors.length - 2);
    const t = position - i;
    return {
      rgb: skyStops[i].map((value, channel) => value * (1 - t) + skyStops[i + 1][channel] * t),
      luminance: colors[i].brightness * (1 - t) + colors[i + 1].brightness * t,
    };
  };

  return {
    toScreen,
    skyAt,
    layers,
    hazeOpacity: HAZE_MAX_OPACITY * hazeThickness,
    hazeDimming: HAZE_MAX_DIMMING * hazeThickness,
    cloudMaxOpacity,
  };
}

/**
 * Maps luminance (cd/m²) to screen brightness (0–1). The floor is black, and
 * full brightness is the brightest sky luminance or the ceiling, whichever is
 * higher, so the sky dims once all of it is darker than the ceiling. In
 * between, the scale is logarithmic, which gives dim light more contrast, as
 * human vision does. Anything dimmer than the floor is black, and anything
 * brighter than full brightness is full brightness.
 */
function exposureScale(skyLuminances, { floor, ceiling }) {
  const top = Math.max(ceiling, ...skyLuminances);
  const range = Math.log(top / floor);
  return (luminance) =>
    luminance < floor ? 0 : Math.min(1, Math.log(luminance / floor) / range);
}

// How much brighter (above 1) or darker (below 1) clouds are than the sky
function cloudToSkyRatio(skyLuminance, { pivot, exponent }) {
  if (skyLuminance <= 0) return 0;
  return (skyLuminance / pivot) ** exponent;
}

/**
 * Cloud opacity (0–1) at a position in a layer's band. x is across the screen
 * and `up` up it, both measured in screen heights. Noise above the layer's
 * threshold is cloud, so the cloudy share of the band matches its cover. Near
 * the band's top and bottom, a second noise decides how far the cloud reaches,
 * giving lumpy edges. Both noises move with the layer's drift and evolution.
 */
function cloudOpacity(layer, x, up) {
  const [frequencyX, frequencyY] = layer.frequency;
  const drifted = x - layer.drift;
  let opacity = 1;
  if (layer.cover < 1) {
    const density = fractalNoise(
      drifted * frequencyX + layer.offset,
      up * frequencyY + layer.offset + layer.evolution,
    );
    opacity = smoothstep(layer.threshold - COVER_SOFTNESS, layer.threshold + COVER_SOFTNESS, density);
    if (opacity === 0) return 0;
  }

  // Distance from the band's nearer edge, measured in edge zones
  const withinBand = (up - layer.bottomOnScreen) / (layer.topOnScreen - layer.bottomOnScreen);
  const edgeDistance = Math.min(withinBand, 1 - withinBand) / EDGE_ZONE;
  if (edgeDistance < 1 + EDGE_SOFTNESS) {
    const lump = fractalNoise(
      drifted * EDGE_FREQUENCY + layer.offset + 50,
      up * EDGE_FREQUENCY + layer.offset + 50 + layer.evolution,
      3,
    );
    const reach = clamp(0.5 + (0.5 - lump) * 2, 0, 1);
    opacity *= smoothstep(reach - EDGE_SOFTNESS, reach + EDGE_SOFTNESS, edgeDistance);
  }
  return opacity;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
