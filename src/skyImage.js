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
 * How cloud bodies are lit:
 * - 'physical': by the sunlight reaching each row's altitude (its color and
 *   strength from the sky model), reflected with `reflectance`, plus a
 *   `skylight` share of the average sky's light. The sun lights the tops of
 *   each band while it's above the horizon and the bases once it's below.
 * - 'mirrored': neutral gray, lit like the sky at the mirrored height and
 *   scaled by the cloud brightness pivot and exponent, with each band flipped
 *   top to bottom once its layer would be lit from below.
 * - 'blended': the mirrored brightness, tinted with the physical color by
 *   `colorBlend` (0 is plain mirrored gray, 1 is fully tinted). The tint
 *   takes the physical color's hue and saturation at the mirrored brightness,
 *   like an image editor's Color blend mode, so it adds color without changing
 *   the overall brightness much.
 * - 'scattering': physically based, from how thick the cloud is at each pixel
 *   (see scatteringCloudLighting). Body and rim both come from the sunlight
 *   reaching that altitude, so they can't disagree in color. The glow settings
 *   aren't used: the bright rims come from the scattering itself.
 *   `forwardScattering` is how strongly droplets scatter light forward (the
 *   Henyey-Greenstein g, about 0.85 for cloud droplets), and `thickness` is
 *   the optical thickness of a cloud's interior.
 */
export const DEFAULT_CLOUD_LIGHTING = {
  mode: 'blended',
  reflectance: 0.7,
  skylight: 0.5,
  colorBlend: 0.8,
  forwardScattering: 0.85,
  thickness: 20,
};
// Scattering lighting: optical thickness is 0 at a cloud's edge and grows as
// e^(depth / d) - 1 inside it, up to the `thickness` setting, where d is the
// glow width setting times this. Smaller widths give sharper rims.
const SCATTERING_RIM_SCALE = 0.25;
// Scattering lighting: share of full sunlight the sides of clouds facing the
// sun get (clouds aren't flat). They're only seen looking away from the sun.
const CLOUD_SIDE_ILLUMINATION = 0.3;
// Share of the light reaching the ground that it reflects back up to cloud bases
const GROUND_ALBEDO = 0.15;
// Share of direct sunlight the side of a cloud facing away from the sun still gets
const CLOUD_SIDE_LIGHT = 0.35;
// Sun elevations (degrees) over which the lit side moves from bases to tops
const CLOUD_LIT_SIDE_BLEND = 1;

// Thin cloud edges glow with the sunlight passing through them, as in a
// "silver lining" (golden at sunset). `width` is how far into a cloud the glow
// reaches, in noise units above the edge; `strength` multiplies its light.
// A boost layer, a copy of the glow with more contrast and saturation, then
// goes over the cloud and glow with a color blend, which adds its hue and
// saturation while keeping the brightness below, without clipping: `boost` is
// its opacity (0 turns it off), `boostContrast` sharpens where it falls off
// inside the cloud, and `boostSaturation` multiplies its saturation. Only the
// layer whose band the sun is behind on screen gets the boost layer, since
// its clouds are the ones backlit by the sun.
export const DEFAULT_CLOUD_GLOW = {
  width: 0.04,
  strength: 2,
  boost: 0.5,
  boostContrast: 2,
  boostSaturation: 2,
};
// Share of the screen's height over which a layer's boost fades in and out as
// the sun passes its band's edge (about 4° of sun elevation)
const BOOST_BAND_FADE = 0.05;
// A glow less saturated than its cloud takes on the cloud's color, fully once
// the cloud is this much more saturated (HSV saturation, 0–1)
const GLOW_COLOR_MATCH_RANGE = 0.1;
// Luminance (cd/m²) of a glowing edge for each lux of sunlight reaching it
const EDGE_GLOW_LUMINANCE_PER_LUX = 0.1;
// The glow reaches this many times as far into the lumpy top and bottom edges
// of the cloud bands, which are measured in edge zones rather than noise units
const EDGE_GLOW_ZONES_PER_UNIT = 4;

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
 * - cloudLighting: { mode, reflectance, skylight } (see DEFAULT_CLOUD_LIGHTING)
 * - cloudGlow: { width, strength } (see DEFAULT_CLOUD_GLOW)
 * - sunlight: direct sunlight by height from the server, as
 *   [{ height, hue, saturation, illuminance }]
 * - time: the clock time in seconds, which sets where the clouds have drifted to
 */

/**
 * Draws the sky into `pixels`: an RGBA column 1 pixel wide and `height` tall
 */
export function renderSkyColumn(pixels, height, settings, rows = rowColors(settings, height)) {
  const { sky } = rows;
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
export function renderHazeColumn(pixels, height, settings, rows = rowColors(settings, height)) {
  const { scene, sky, haze } = rows;
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
export function renderClouds(pixels, width, height, settings, rows = rowColors(settings, height)) {
  const { scene, sky, cloud, cloudAt, haze, rowHeight, layerAt } = rows;
  const { cloudMaxOpacity, hazeOpacity } = scene;
  const lighting = settings.cloudLighting ?? DEFAULT_CLOUD_LIGHTING;
  const scattering = lighting.mode === 'scattering';
  const glowWidth = scattering ? 0 : (settings.cloudGlow?.width ?? 0);
  const glowSettings = { ...DEFAULT_CLOUD_GLOW, ...settings.cloudGlow };
  const { boost, boostContrast } = glowSettings;
  // Scattering lighting: how quickly optical thickness grows inside a cloud,
  // and the depth (noise units) at which it reaches full thickness
  const rimDepth = Math.max(
    1e-3,
    (settings.cloudGlow?.width ?? DEFAULT_CLOUD_GLOW.width) * SCATTERING_RIM_SCALE,
  );
  const fullThicknessDepth = scattering ? rimDepth * Math.log(lighting.thickness + 1) : 0;
  const shape = { opacity: 0, thinness: 0, depth: 0 };
  const light = [0, 0, 0];
  const total = [0, 0, 0];
  for (let row = 0; row < height; row++) {
    const up = rowHeight(row);
    const layer = layerAt(up);
    const glowMatch = layer && !scattering ? glowMatchingCloud(layer.glow, cloud[row]) : null;
    const glow = glowMatch?.glow;
    const boostColor = glowMatch ? boostedGlowColor(glow, glowSettings.boostSaturation) : null;
    for (let column = 0; column < width; column++) {
      if (layer && cloudMaxOpacity > 0) {
        cloudShape(layer, (column + 0.5) / height, up, glowWidth, shape, fullThicknessDepth);
      } else {
        shape.opacity = 0;
      }
      let opacity = cloudMaxOpacity * shape.opacity;
      if (scattering && opacity > 0) {
        // Optical thickness here, which also sets how much of the sky shows
        // through (in place of the soft noise edge)
        const tau = Math.min(lighting.thickness, Math.exp(shape.depth / rimDepth) - 1);
        opacity = cloudMaxOpacity * (1 - Math.exp(-tau));
        const color = cloudAt[row](tau);
        for (let channel = 0; channel < 3; channel++) light[channel] = color[channel];
      }
      const alpha = Math.round(255 * opacity);
      const offset = (row * width + column) * 4;
      if (!scattering && alpha > 0) {
        // The cloud's own light, plus sunlight glowing through its thin edges,
        // capped at full brightness. Where the glow was given the cloud's
        // color, it's scaled down as a whole instead, so that color holds.
        let peak = 0;
        for (let channel = 0; channel < 3; channel++) {
          light[channel] = cloud[row][channel] + glow[channel] * shape.thinness;
          peak = Math.max(peak, light[channel]);
        }
        const match = glowMatch.match;
        for (let channel = 0; channel < 3; channel++) {
          const capped = Math.min(1, light[channel]);
          light[channel] = peak > 1 ? capped + (light[channel] / peak - capped) * match : capped;
        }

        // The boost layer, over the cloud and glow in a color blend
        if (boost > 0 && layer.boostShare > 0 && shape.thinness > 0) {
          const strength =
            boost *
            layer.boostShare *
            clamp(0.5 + (shape.thinness - 0.5) * boostContrast, 0, 1);
          colorBlend(light, boostColor, strength);
        }
      } else if (!scattering) {
        light.fill(0);
      }
      for (let channel = 0; channel < 3; channel++) {
        const value = light[channel];
        pixels[offset + channel] = alpha > 0 ? colorOver(sky[row][channel], value, alpha, channel) : 0;
        // The whole scene at this pixel, for the average
        let scene = sky[row][channel];
        scene += (value - scene) * (alpha / 255);
        scene += (haze[row] - scene) * hazeOpacity;
        total[channel] += scene;
      }
      pixels[offset + 3] = alpha;
    }
  }
  return total.map((value) => value / (width * height));
}

/**
 * Each row's colors for a screen `height` rows tall, to pass to the drawing
 * functions above and below so they all share one calculation
 */
export function computeRows(settings, height) {
  return rowColors(settings, height);
}

/**
 * The scene's approximate average color (linear light), from `rows` (see
 * computeRows): the sky, covered in each cloud band by that layer's share of
 * cloud cover, then the haze over it. It's close enough to choose a readable
 * text color without drawing the clouds.
 */
export function sceneAverageColor({ scene, sky, cloud, haze, rowHeight, layerAt }) {
  const total = [0, 0, 0];
  sky.forEach((rgb, row) => {
    const layer = layerAt(rowHeight(row));
    const coverage = layer ? layer.cover * scene.cloudMaxOpacity : 0;
    for (let channel = 0; channel < 3; channel++) {
      let value = rgb[channel] + (cloud[row][channel] - rgb[channel]) * coverage;
      value += (haze[row] - value) * scene.hazeOpacity;
      total[channel] += value;
    }
  });
  return total.map((value) => value / sky.length);
}

/*
 * Drawing the cloud layers on the GPU (see cloudsGL.js). The shader does the
 * per-pixel work of renderClouds (noise, cloud shape, glow and boost, and the
 * blend over the sky); the per-row colors are worked out here, by the same
 * code as renderClouds, and passed to it as small images.
 */
export const CLOUD_SHADER_CONSTANTS = {
  COVER_SOFTNESS,
  EDGE_ZONE,
  EDGE_FREQUENCY,
  EDGE_SOFTNESS,
  EDGE_GLOW_ZONES_PER_UNIT,
  BLACK_LEVEL,
  // Glow light is stored divided by this, so values above 1 fit in 0–1
  GLOW_ENCODE_RANGE: 8,
  // Values per row in cloudShaderData's `rows`
  ROW_TEXELS: 4,
  // Optical thicknesses per row in cloudShaderData's `scatteringLut`
  SCATTERING_LUT_SIZE: 32,
};

/**
 * The per-row data and settings for drawing the cloud layers on the GPU for a
 * screen `height` rows tall:
 * - rows: an RGBA image ROW_TEXELS wide and `height` tall, bottom row first.
 *   Each row holds on-screen (sRGB) values: 0 the sky, exactly as the sky
 *   layer shows it; 1 the clouds' own light; 2 the glow's light divided by
 *   GLOW_ENCODE_RANGE, with its color match in alpha; 3 the boost layer's color.
 * - scatteringLut: for scattering lighting, an RGBA image SCATTERING_LUT_SIZE
 *   wide and `height` tall, bottom row first: each row's cloud color (on
 *   screen) for optical thickness τ = (thickness + 1)^s - 1, s from 0 to 1
 * - uniforms: values that are the same for every pixel
 * - layers: for each cloud layer showing, its band and noise settings
 */
export function cloudShaderData(settings, height, colorRows = rowColors(settings, height)) {
  const { scene, sky, cloud, cloudAt, rowHeight, layerAt } = colorRows;
  const { ROW_TEXELS, GLOW_ENCODE_RANGE, SCATTERING_LUT_SIZE } = CLOUD_SHADER_CONSTANTS;
  const lighting = settings.cloudLighting ?? DEFAULT_CLOUD_LIGHTING;
  const scattering = lighting.mode === 'scattering';
  const glowSettings = { ...DEFAULT_CLOUD_GLOW, ...settings.cloudGlow };
  const rimDepth = Math.max(1e-3, glowSettings.width * SCATTERING_RIM_SCALE);
  const toByte = (linear) => Math.round(255 * encodeSrgb(clamp(linear, 0, 1)));

  const rows = new Uint8Array(ROW_TEXELS * 4 * height);
  const scatteringLut = scattering ? new Uint8Array(SCATTERING_LUT_SIZE * 4 * height) : null;
  for (let row = 0; row < height; row++) {
    const bottomFirst = height - 1 - row;
    const offset = bottomFirst * ROW_TEXELS * 4;
    for (let channel = 0; channel < 3; channel++) {
      rows[offset + channel] = Math.round(toScreenValue(sky[row][channel], channel));
      rows[offset + 4 + channel] = toByte(cloud[row][channel]);
    }
    rows[offset + 3] = 255;
    rows[offset + 7] = 255;
    const layer = layerAt(rowHeight(row));
    if (layer && !scattering) {
      const { glow, match } = glowMatchingCloud(layer.glow, cloud[row]);
      const boostColor = boostedGlowColor(glow, glowSettings.boostSaturation);
      for (let channel = 0; channel < 3; channel++) {
        rows[offset + 8 + channel] = toByte(glow[channel] / GLOW_ENCODE_RANGE);
        rows[offset + 12 + channel] = toByte(boostColor[channel]);
      }
      rows[offset + 11] = Math.round(255 * match);
    }
    rows[offset + 15] = 255;
    if (scatteringLut) {
      for (let i = 0; i < SCATTERING_LUT_SIZE; i++) {
        const s = i / (SCATTERING_LUT_SIZE - 1);
        const color = cloudAt[row]((lighting.thickness + 1) ** s - 1);
        const lutOffset = (bottomFirst * SCATTERING_LUT_SIZE + i) * 4;
        for (let channel = 0; channel < 3; channel++) scatteringLut[lutOffset + channel] = toByte(color[channel]);
        scatteringLut[lutOffset + 3] = 255;
      }
    }
  }

  return {
    rows,
    scatteringLut,
    uniforms: {
      cloudMaxOpacity: scene.cloudMaxOpacity,
      scattering,
      glowWidth: scattering ? 0 : glowSettings.width,
      rimDepth,
      thickness: lighting.thickness,
      depthNeeded: scattering ? rimDepth * Math.log(lighting.thickness + 1) : 0,
      boost: glowSettings.boost,
      boostContrast: glowSettings.boostContrast,
    },
    layers: scene.layers.map((layer) => ({
      bottom: layer.bottomOnScreen,
      top: layer.topOnScreen,
      cover: layer.cover,
      threshold: layer.threshold,
      frequency: layer.frequency,
      boostShare: layer.boostShare,
    })),
  };
}

/**
 * Where each cloud layer showing has drifted to at `settings.time`, as offsets
 * for its noise (see cloudShape), for the GPU: [density x, density y, lumps x,
 * lumps y]. The noise repeats every 256 units, so they're wrapped to 0–256,
 * which keeps them precise on GPUs.
 */
export function cloudNoiseOrigins(settings) {
  const wrap = (value) => ((value % 256) + 256) % 256;
  return prepareScene(settings).layers.map((layer) => [
    wrap(layer.offset - layer.drift * layer.frequency[0]),
    wrap(layer.offset + layer.evolution),
    wrap(layer.offset + 50 - layer.drift * EDGE_FREQUENCY),
    wrap(layer.offset + 50 + layer.evolution),
  ]);
}

/**
 * The glow's color for cloud of color `cloud` (both linear light). A glow less
 * saturated than the cloud takes on the cloud's color at its own luminance, so
 * rims are never paler than the cloud they're on; the change blends in over
 * GLOW_COLOR_MATCH_RANGE of saturation difference.
 */
function glowMatchingCloud(glow, cloud) {
  const glowLuminance = luminanceOf(glow);
  const cloudLuminance = luminanceOf(cloud);
  if (glowLuminance <= 0 || cloudLuminance <= 0) return { glow, match: 0 };
  const match = smoothstep(0, GLOW_COLOR_MATCH_RANGE, saturationOf(cloud) - saturationOf(glow));
  if (match === 0) return { glow, match };
  const cloudColored = cloud.map((value) => (value / cloudLuminance) * glowLuminance);
  return {
    glow: glow.map((value, channel) => value + (cloudColored[channel] - value) * match),
    match,
  };
}

/**
 * The boost layer's color (linear light, brightest channel 1): the glow's
 * color with its saturation multiplied by `saturation`, keeping its hue.
 * Saturation can't go past 1.
 */
function boostedGlowColor(glow, saturation) {
  const peak = Math.max(...glow);
  if (peak <= 0) return [0, 0, 0];
  // Scaling each channel's distance below the brightest channel changes the
  // saturation without changing the hue
  const current = saturationOf(glow);
  const scale = current > 0 ? Math.min(current * saturation, 1) / current : 1;
  return glow.map((value) => 1 - (1 - value / peak) * scale);
}

/**
 * Blends `color`'s hue and saturation into `light` (both linear light) by
 * `amount` (0–1), keeping `light`'s luminance, like an image editor's Color
 * blend mode. Where that color can't be shown at that luminance, it's scaled
 * down as a whole rather than clipped, so its hue holds. Changes `light`.
 */
function colorBlend(light, color, amount) {
  const luminance = luminanceOf(light);
  const colorLuminance = luminanceOf(color);
  if (luminance <= 0 || colorLuminance <= 0 || amount <= 0) return;
  let scale = luminance / colorLuminance;
  scale = Math.min(scale, 1 / Math.max(...color));
  for (let channel = 0; channel < 3; channel++) {
    light[channel] += (color[channel] * scale - light[channel]) * amount;
  }
}

function luminanceOf([red, green, blue]) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// HSV saturation of a color: 0 for gray, 1 for fully saturated
function saturationOf(rgb) {
  const max = Math.max(...rgb);
  return max > 0 ? (max - Math.min(...rgb)) / max : 0;
}

/**
 * Each row's colors, in linear light, for a screen `height` rows tall: the sky,
 * the clouds' color, and the haze's brightness
 */
function rowColors(settings, height) {
  const { colors, cloudBrightness, hazeContrast: contrastRange } = settings;
  const lighting = settings.cloudLighting ?? DEFAULT_CLOUD_LIGHTING;
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

  // Mirrored lighting: cloud layers take their brightness from the sky at the
  // mirrored height, so higher clouds are lit like the brighter sky near the
  // horizon. A layer lit from below has that brightness flipped within its
  // visible band.
  const mirroredLight = (up) => {
    const layer = layerAt(up);
    const light = cloudLightFrom(skyAt(1 - up));
    if (!(layer?.litFromBelow > 0)) return light;
    const flippedUp = Math.max(0, layer.bottomOnScreen) + Math.min(1, layer.topOnScreen) - up;
    return light + (cloudLightFrom(skyAt(1 - flippedUp)) - light) * layer.litFromBelow;
  };
  const physicalLight = physicalCloudLighting(settings, scene, lighting);
  // Scattering lighting: for each row, the cloud color by optical thickness
  const cloudAt =
    lighting.mode === 'scattering'
      ? (() => {
          const scatteringLight = scatteringCloudLighting(settings, scene, lighting);
          return Array.from({ length: height }, (_, row) => scatteringLight(rowHeight(row)));
        })()
      : null;
  const cloud = Array.from({ length: height }, (_, row) => {
    const up = rowHeight(row);
    // A cloud's interior, which the haze is kept below
    if (cloudAt) return cloudAt[row](lighting.thickness);
    if (lighting.mode === 'physical') return physicalLight(up, layerAt(up));
    const gray = mirroredLight(up);
    if (lighting.mode === 'blended') {
      return tintKeepingBrightness(gray, physicalLight(up, layerAt(up)), lighting.colorBlend);
    }
    return [gray, gray, gray];
  });
  const brightestCloud = Math.max(...cloud.map((rgb) => Math.max(...rgb)));

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

  return { scene, sky, cloud, cloudAt, haze, rowHeight, layerAt };
}

/**
 * Tints `gray` (linear light) with the hue and saturation of `color` by
 * `amount` (0–1), keeping the luminance of `gray`
 */
function tintKeepingBrightness(gray, color, amount) {
  const [red, green, blue] = color;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  if (luminance <= 0) return [gray, gray, gray];
  // The color rescaled to the gray's luminance, mixed in by `amount`
  return color.map((value) => Math.min(1, gray + ((value * gray) / luminance - gray) * amount));
}

/**
 * Returns a function giving the physically lit color (linear light) of cloud
 * at a height on screen, in `layer` (or undefined outside any layer): the
 * sunlight reaching that altitude reflected off it, plus light from the sky
 */
function physicalCloudLighting(settings, scene, { reflectance, skylight }) {
  const { sunElevation, sunlight = [] } = settings;
  const { toScreen } = scene;
  const { ambientColor, ambient } = skylightOnClouds(settings, scene, skylight);
  // 1 while the sun is above the horizon (tops lit), 0 once it's below (bases lit)
  const sunAbove = smoothstep(-CLOUD_LIT_SIDE_BLEND / 2, CLOUD_LIT_SIDE_BLEND / 2, sunElevation);

  return (up, layer) => {
    // Position within the layer's visible band, 0 at its base and 1 at its top
    let withinBand = 0.5;
    if (layer) {
      const bottom = Math.max(0, layer.bottomOnScreen);
      const top = Math.min(1, layer.topOnScreen);
      withinBand = clamp((up - bottom) / (top - bottom), 0, 1);
    }
    const facingSun = sunAbove * withinBand + (1 - sunAbove) * (1 - withinBand);
    const facing = CLOUD_SIDE_LIGHT + (1 - CLOUD_SIDE_LIGHT) * facingSun;

    // A matte surface's luminance is its reflectance times the lux reaching it, over π
    const sun = sunlightAt(sunlight, Math.max(0, up * CLOUD_TOP_HEIGHT));
    const direct = (sun.illuminance * reflectance * facing) / Math.PI;
    return cloudColor(sun.color, direct, ambientColor, ambient, toScreen);
  };
}

/**
 * Returns a function that, for a height on screen, gives a function from
 * optical thickness τ to the cloud's color there (linear light). Cloud
 * droplets scatter all colors equally, so all the direct light has the color
 * of the sunlight reaching that row's altitude. Seen from below:
 * - With the sun above the cloud's horizontal, light passes through it to its
 *   base: the two-stream diffuse transmission T = 1 / (1 + 0.75 (1 - g) τ).
 * - With the sun below it, the base reflects it: R = 1 - T (droplets absorb
 *   almost nothing). Sun-facing cloud sides reflect some too, seen more the
 *   further we look from the sun.
 * - Light scattered once on its way through goes mostly forward, so thin
 *   cloud near the sun's direction glows (the silver lining): the sunlight
 *   times the Henyey-Greenstein phase for the angle between the sun and the
 *   view, times τ e^-τ, which peaks at τ = 1. The glow strength setting
 *   multiplies it (1 is physical).
 * - A share of the sky's average light gets through as sunlight does, plus
 *   what the ground reflects back up. Thick cloud is dark underneath.
 */
function scatteringCloudLighting(settings, scene, { skylight, forwardScattering: g }) {
  const { colors, sunElevation, sunlight = [] } = settings;
  const { toScreen } = scene;
  const { ambientColor, ambient } = skylightOnClouds(settings, scene, skylight);
  const rimStrength = settings.cloudGlow?.strength ?? 1;
  // The screen runs from the sky colors' lowest view elevation to their highest
  const bottomElevation = colors[0].elevation;
  const topElevation = colors[colors.length - 1].elevation;

  return (up) => {
    const altitude = Math.max(0.1, up * CLOUD_TOP_HEIGHT);
    const { color, illuminance } = sunlightAt(sunlight, altitude);
    // The sun's elevation above the cloud's own horizontal, which is lower
    // than ours by Earth's curvature over the distance to it
    const dip = (Math.acos(EARTH_RADIUS / (EARTH_RADIUS + altitude)) * 180) / Math.PI;
    const localElevation = sunElevation + dip;
    const viewElevation = bottomElevation + (topElevation - bottomElevation) * up;
    const cosAngle = Math.cos(toRadians(viewElevation - sunElevation));
    const fromAbove = Math.sin(toRadians(Math.max(0, localElevation)));
    // Sides lit by the sun face away from us when we look toward it
    const sides = (CLOUD_SIDE_ILLUMINATION * (1 - cosAngle)) / 2;
    const fromBelow = Math.sin(toRadians(Math.max(0, -localElevation))) + sides;
    const phase = henyeyGreenstein(cosAngle, g) * rimStrength;

    return (tau) => {
      const transmitted = 1 / (1 + 0.75 * (1 - g) * tau);
      const reflected = 1 - transmitted;
      const diffuse = (fromAbove * transmitted + fromBelow * reflected) / Math.PI;
      const direct = illuminance * (diffuse + phase * tau * Math.exp(-tau));
      // Skylight gets through the cloud as sunlight does; its base also
      // reflects some of the light the ground sends back up
      const skylightThrough = ambient * (transmitted + GROUND_ALBEDO * reflected);
      return cloudColor(color, direct, ambientColor, skylightThrough, toScreen);
    };
  };
}

// Henyey-Greenstein phase function (per steradian) for scattering angle θ
function henyeyGreenstein(cosTheta, g) {
  const denominator = 1 + g * g - 2 * g * cosTheta;
  return (1 - g * g) / (4 * Math.PI * denominator * Math.sqrt(denominator));
}

/**
 * Skylight reaching clouds: `ambient`, a `share` of the sky's average
 * luminance (cd/m²), and `ambientColor`, the sky's average color (brightest
 * channel 1)
 */
function skylightOnClouds({ colors }, { skyAt }, share) {
  const averageSkyLuminance =
    colors.reduce((sum, color) => sum + color.brightness, 0) / colors.length;
  const skyColor = [0, 0, 0];
  const samples = 20;
  for (let i = 0; i < samples; i++) {
    skyAt((i + 0.5) / samples).rgb.forEach((value, channel) => (skyColor[channel] += value));
  }
  const skyPeak = Math.max(...skyColor);
  return {
    ambientColor: skyPeak > 0 ? skyColor.map((value) => value / skyPeak) : [1, 1, 1],
    ambient: averageSkyLuminance * share,
  };
}

/**
 * Cloud color (linear light) from `direct` sunlight luminance of color
 * `sunColor` and `ambient` skylight luminance of color `ambientColor` (both
 * cd/m²), at the on-screen brightness of their total. Its brightest channel is
 * that brightness, so it never clips.
 */
function cloudColor(sunColor, direct, ambientColor, ambient, toScreen) {
  const total = direct + ambient;
  if (total <= 0) return [0, 0, 0];
  const mix = sunColor.map((value, channel) => value * direct + ambientColor[channel] * ambient);
  const peak = Math.max(...mix);
  const onScreen = decodeSrgb(toScreen(total));
  return mix.map((value) => (value / peak) * onScreen);
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Direct sunlight at `height` km, blended from the two calculated heights
 * around it: its color (brightest channel 1) and illuminance in lux. It's
 * blended as light, so colors near red (where hue wraps around) mix correctly.
 * The color is white-balanced, or with `forGlow`, the more saturated color
 * without white balance.
 */
function sunlightAt(sunlight, height, forGlow = false) {
  if (sunlight.length === 0) return { color: [1, 1, 1], illuminance: 0 };
  const position = clamp(height - sunlight[0].height, 0, sunlight.length - 1);
  const below = sunlight[Math.floor(position)];
  const above = sunlight[Math.min(Math.floor(position) + 1, sunlight.length - 1)];
  const t = position - Math.floor(position);
  const lightOf = ({ hue, saturation, glowHue, glowSaturation, illuminance }) =>
    (forGlow ? hsvToLinearRgb(glowHue, glowSaturation, 1) : hsvToLinearRgb(hue, saturation, 1)).map(
      (value) => value * illuminance,
    );
  const [lowLight, highLight] = [lightOf(below), lightOf(above)];
  const light = lowLight.map((value, channel) => value + (highLight[channel] - value) * t);
  const illuminance = below.illuminance + (above.illuminance - below.illuminance) * t;
  const peak = Math.max(...light);
  return { color: peak > 0 ? light.map((value) => value / peak) : [1, 1, 1], illuminance };
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
 * A key for the stars' colors and glow: scenes with the same key have the same
 * stars, so they needn't be worked out again. It's 'day' when the whole sky is
 * at least as bright as the brightest star, so none show. When the whole sky
 * is darker than the exposure floor, every star shows and only the exposure
 * matters, so the key is from that. In between (twilight) it's null, and they
 * have to be worked out.
 */
export function starsKey({ colors, exposure }) {
  const brightestStar = STAR_MAX_BRIGHTNESS * exposure.floor;
  if (colors.every((color) => color.brightness >= brightestStar)) return 'day';
  if (colors.every((color) => color.brightness < exposure.floor)) {
    return `night ${exposure.floor} ${exposure.ceiling}`;
  }
  return null;
}

/**
 * Each star's on-screen color for the scene, as red, green and blue (0–255)
 * per star, 0 where it isn't shown. Comparing these between frames shows
 * whether the stars need redrawing.
 */
export function starColors(settings) {
  const starlight = starlightScale(settings);
  const brightest = STAR_MAX_BRIGHTNESS * settings.exposure.floor;
  const colors = new Uint8Array(STARS.length * 3);
  STARS.forEach((star, i) => {
    const level = 255 * starlight(brightest * star.brightness, star.up);
    if (level < 0.5) return;
    const whiteness = smoothstep(STAR_WHITE_START, 1, star.brightness);
    EIGENGRAU_TINT.forEach((tint, channel) => {
      colors[i * 3 + channel] = Math.round(level * (tint + (1 - tint) * whiteness));
    });
  });
  return colors;
}

/**
 * Draws the stars, in `colors` from starColors, onto the canvas `context`
 * (width × height pixels), each `starSize` pixels square, to go over the sky
 * with a screen blend
 */
export function drawStars(context, width, height, colors, starSize) {
  STARS.forEach((star, i) => {
    const [red, green, blue] = colors.subarray(i * 3, i * 3 + 3);
    if (red === 0 && green === 0 && blue === 0) return;
    context.fillStyle = `rgb(${red} ${green} ${blue})`;
    context.fillRect(
      Math.floor(star.across * width),
      Math.floor((1 - star.up) * height),
      starSize,
      starSize,
    );
  });
}

// Works out what the sky, cloud, haze and star drawing all need for a scene
function prepareScene({
  colors,
  sunElevation,
  exposure,
  clouds,
  cloudGlow = DEFAULT_CLOUD_GLOW,
  cloudLighting = DEFAULT_CLOUD_LIGHTING,
  sunlight = [],
  time = 0,
}) {
  // With blended lighting, the color blend also sets how much of the
  // sunlight's color the edge glow keeps (the rest is neutral at the same brightness)
  const glowColorAmount = cloudLighting.mode === 'blended' ? cloudLighting.colorBlend : 1;
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
  // Where the sun is on screen (0 at the bottom, 1 at the top), placed by the
  // sky colors' view elevations. It's below 0 when the sun is low.
  const sunOnScreen =
    (sunElevation - colors[0].elevation) / (colors[colors.length - 1].elevation - colors[0].elevation);
  const layers = CLOUD_LAYERS.filter((layer) => clouds[layer.name] > 0).map((layer) => {
    const bottomOnScreen = layer.bottom / CLOUD_TOP_HEIGHT;
    const topOnScreen = Math.min(layer.top, CLOUD_TOP_HEIGHT) / CLOUD_TOP_HEIGHT;
    // How far outside the layer's band the sun is, on screen (negative inside it)
    const sunOutside = Math.max(bottomOnScreen - sunOnScreen, sunOnScreen - topOnScreen);
    const cover = Math.min(1, clouds[layer.name] / 100);
    // Sun elevation below which this layer is lit from below
    const flipElevation =
      -(Math.acos(EARTH_RADIUS / (EARTH_RADIUS + layer.height)) * 180) / Math.PI;
    return {
      ...layer,
      cover,
      threshold: noiseQuantile(1 - cover),
      bottomOnScreen,
      topOnScreen,
      // Share of the glow's boost layer this layer gets: all of it while the
      // sun is behind the layer's band on screen, none once it's clear of it
      boostShare: 1 - smoothstep(-BOOST_BAND_FADE / 2, BOOST_BAND_FADE / 2, sunOutside),
      // How far the layer has drifted (screen heights) and its shapes have changed (noise units)
      drift: time * layer.speed,
      evolution: time * CLOUD_EVOLUTION,
      // Light (linear, per channel) added at the layer's thin edges by the
      // sunlight reaching its height
      glow: edgeGlow(sunlight, layer.height, toScreen, cloudGlow.strength, glowColorAmount),
      // 0 when lit from above, 1 when lit from below
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

/**
 * The light (linear, per channel) that sunlight at `height` km adds to thin
 * cloud edges: the sunlight's color without white balance (more vivid, so
 * golden-hour rims stand out against the clouds), at the on-screen brightness
 * of the luminance it gives a glowing edge, times `strength`. `colorAmount`
 * (0–1) is how much of that color it keeps; the rest is neutral at the same
 * brightness.
 */
function edgeGlow(sunlight, height, toScreen, strength, colorAmount) {
  const { color, illuminance } = sunlightAt(sunlight, height, true);
  if (illuminance <= 0) return [0, 0, 0];
  const onScreen = decodeSrgb(toScreen(illuminance * EDGE_GLOW_LUMINANCE_PER_LUX));
  const [red, green, blue] = color;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return color.map(
    (value) => (luminance + (value - luminance) * colorAmount) * onScreen * strength,
  );
}

// How much brighter (above 1) or darker (below 1) clouds are than the sky
function cloudToSkyRatio(skyLuminance, { pivot, exponent }) {
  if (skyLuminance <= 0) return 0;
  return (skyLuminance / pivot) ** exponent;
}

/**
 * Sets `shape.opacity` (0–1) and `shape.thinness` (0–1) at a position in a
 * layer's band. x is across the screen and `up` up it, both measured in screen
 * heights. Noise above the layer's threshold is cloud, so the cloudy share of
 * the band matches its cover. Near the band's top and bottom, a second noise
 * decides how far the cloud reaches, giving lumpy edges. Both noises move with
 * the layer's drift and evolution. Thinness is 1 at a cloud's edge, fading to
 * 0 `glowWidth` noise units inside it. `shape.depth` is how far inside the
 * cloud the position is, in noise units (edges of the band count ¼ as much per
 * edge zone), measured accurately up to `depthNeeded`.
 */
function cloudShape(layer, x, up, glowWidth, shape, depthNeeded = 0) {
  const [frequencyX, frequencyY] = layer.frequency;
  const drifted = x - layer.drift;
  let opacity = 1;
  let thinness = 0;
  let depth = Infinity;
  if (layer.cover < 1) {
    const density = fractalNoise(
      drifted * frequencyX + layer.offset,
      up * frequencyY + layer.offset + layer.evolution,
    );
    const edge = layer.threshold - COVER_SOFTNESS;
    opacity = smoothstep(edge, layer.threshold + COVER_SOFTNESS, density);
    if (opacity === 0) {
      shape.opacity = 0;
      return;
    }
    thinness = 1 - smoothstep(edge, layer.threshold + glowWidth, density);
    depth = density - edge;
  }

  // Distance from the band's nearer edge, measured in edge zones
  const withinBand = (up - layer.bottomOnScreen) / (layer.topOnScreen - layer.bottomOnScreen);
  const edgeDistance = Math.min(withinBand, 1 - withinBand) / EDGE_ZONE;
  const edgeGlowDepth = Math.max(glowWidth, depthNeeded) * EDGE_GLOW_ZONES_PER_UNIT;
  if (edgeDistance < 1 + EDGE_SOFTNESS + edgeGlowDepth) {
    const lump = fractalNoise(
      drifted * EDGE_FREQUENCY + layer.offset + 50,
      up * EDGE_FREQUENCY + layer.offset + 50 + layer.evolution,
      3,
    );
    const reach = clamp(0.5 + (0.5 - lump) * 2, 0, 1);
    opacity *= smoothstep(reach - EDGE_SOFTNESS, reach + EDGE_SOFTNESS, edgeDistance);
    const edgeThinness =
      1 - smoothstep(reach - EDGE_SOFTNESS, reach + EDGE_SOFTNESS + edgeGlowDepth, edgeDistance);
    thinness = Math.max(thinness, edgeThinness);
    const edgeDepth = (edgeDistance - (reach - EDGE_SOFTNESS)) / EDGE_GLOW_ZONES_PER_UNIT;
    depth = Math.min(depth, Math.max(0, edgeDepth));
  }
  shape.opacity = opacity;
  shape.depth = depth;
  shape.thinness = glowWidth > 0 ? thinness : 0;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
