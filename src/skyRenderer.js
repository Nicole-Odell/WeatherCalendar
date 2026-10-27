import { createCloudRenderer } from './cloudsGL.js';
import { createCpuCloudRenderer } from './cpuClouds.js';
import { PRECIPITATION_INTERVAL, PRECIPITATION_SCALE, createPrecipitation } from './precipitation.js';
import moonUrl from '../assets/images/moon.png';
import {
  cloudShaderData,
  computeRows,
  drawStars,
  renderHazeColumn,
  moonCloudColor,
  moonCloudFalloff,
  moonCloudLight,
  moonGlowMargin,
  overcastOf,
  renderMoon,
  renderSkyColumn,
  renderStarGlow,
  starColors,
  starsKey,
} from './skyImage.js';

// Share of the window's resolution the clouds are drawn at, and the sky and
// haze worked out at. The browser smooths them up to full size, which suits
// soft clouds and smooth gradients and keeps drawing fast.
const RENDER_SCALE = 0.25;
// The moon: its radius as a share of the screen's height, and the distance
// from the right of the screen to its right edge as a share of the screen's
// width. Its height follows its altitude, from its center on the bottom of the
// screen (the horizon) at 0° to its top edge at the top of the screen at MOON_TOP_ALTITUDE.
const MOON_RADIUS = 0.0375;
const MOON_FROM_RIGHT = 0.1;
// Altitude (degrees) the moon is shown at until the server has given one
const DEFAULT_MOON_ALTITUDE = 45;
// The moon's altitude (degrees) shown at the top of the screen, with the
// horizon at the bottom (here, at 47.65° N, it never gets above about 70°)
const MOON_TOP_ALTITUDE = 80;
// Moonlight on the clouds weaker than this (see moonCloudLight) isn't drawn
const MOON_CLOUD_LIGHT_LEAST = 0.01;
// As the moon rises and sets, it's only drawn again once it has moved this
// many pixels (or the sky or its settings change); until then the drawing
// just moves with it
const MOON_REDRAW_MOVE = 8;
// The sky is painted (fades shown, the canvases updated) at most this often
// (ms): 30 times a second, every other frame of the display. Each paint has
// the browser composite the whole screen again, which is the Pi 3's limit,
// so painting half as often keeps frames steady rather than spiking.
const PAINT_INTERVAL = 1000 / 30;
// (frames come every 16.7 ms, so a frame this much early still counts)
const PAINT_SLACK = 4;

// Width in pixels the star glow is drawn at before being smoothed up
const STAR_GLOW_WIDTH = 240;
// In twilight, when the stars change with the sky, they're worked out again
// at most this often (ms): they change too slowly to see in between, and
// working them out takes a while on the Pi 3
const STAR_TWILIGHT_INTERVAL = 5000;
// How often a new frame of cloud motion is drawn (ms), faded in over the same time
const CLOUD_INTERVAL = 250;
// The clouds are drawn with WebGL (with motion) if the GPU draws a cloud frame
// within this many ms, leaving it plenty of time for everything else between
// frames; otherwise they're drawn on the CPU
const CLOUD_ANIMATION_BUDGET = 50;
// Sky and haze changes of at most this many steps (of 255) are shown straight
// away: too small to see, so not worth the work of fading
const INSTANT_CHANGE = 2;
// The moon's rotation and lit side are drawn in steps of this many degrees
const MOON_ANGLE_STEP = 0.5;
// On the CPU, the clouds are only recolored once their colors (in the cloud
// data) have moved this many steps (of 255) from those last drawn, as each
// recolor takes a while there
const CPU_RECOLOR_STEP = 1;

/**
 * Draws the sky, stars, moon, clouds, haze and rain or snow on canvases the
 * page stacks, either on the page or on a worker thread (see skyWorker.js).
 * Each changes only when what it shows does, as every change has the
 * browser composite the screen again, which is slow on the Pi 3:
 * 1. `sky`: the sky, a column 1 pixel wide that the page stretches
 * 2. `stars`: the stars and their glow, at full resolution, over the sky
 *    with plain transparency (see drawStars); only redrawn when they change
 * 3. `moon`: the moon and its glow, on a canvas just its size that the page
 *    places (see reportLayers; its colors already include the sky's light)
 * 4. `clouds`: the cloud layers, drawn with WebGL if the GPU is fast enough,
 *    otherwise on the CPU (see cpuClouds.js)
 * 5. `haze`: the haze, a column 1 pixel wide that the page stretches
 * 6. `precipitation`: rain and snow, drawn every
 *    PRECIPITATION_INTERVAL ms while there's any (see precipitation.js)
 * `createCanvas()` makes an off-screen canvas for working in.
 * `report(message)` passes back { status } (renderer and timings) and
 * { layers } (see reportLayers).
 * `forceCpuClouds` draws the clouds on the CPU even if WebGL is fast enough.
 *
 * Each redraw fades in from what's showing. Only pixels that differ between
 * the two frames change, and each moves straight from its old value to its
 * new one, so layers that aren't changing stay exactly as they are. The work
 * is skipped where nothing has changed: the stars are only worked out during
 * twilight (see starsKey), and the clouds only redrawn when their data changes.
 *
 * Cloud motion moves the clouds on every CLOUD_INTERVAL ms. With WebGL, each
 * step is a new frame faded in over that time; on the CPU, each layer's band
 * is slid across.
 */
export function createSkyRenderer({ canvases, createCanvas, report, forceCpuClouds = false }) {
  const requestFrame = globalThis.requestAnimationFrame
    ? (callback) => globalThis.requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 16);
  const cancelFrame = globalThis.cancelAnimationFrame
    ? (id) => globalThis.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

  const state = {
    sky: createLayer(canvases.sky),
    haze: createLayer(canvases.haze),
    // The stars shown, their colors, glow and key (to tell when they change)
    // (the glow is drawn on its own canvas, kept to be reused)
    stars: {
      canvas: canvases.stars,
      glowCanvas: createCanvas(),
      colors: null,
      glow: null,
      key: undefined,
      changed: false,
    },
    // The moon picture once loaded, its pixels at the size drawn, the moon as
    // drawn, where it goes (top left, in screen pixels) and its key (to tell
    // when it changes)
    moon: {
      picture: null,
      image: null,
      pixels: null,
      canvas: canvases.moon,
      left: 0,
      top: 0,
      key: null,
      sky: null,
      changed: false,
      // How much brighter than the sky its disc shows (0–1, see renderMoon)
      shown: 0,
    },
    // How the clouds are drawn, once chosen: 'webgl' or 'cpu', with the
    // renderer (from cloudsGL.js or cpuClouds.js) and how long the GPU took
    // to draw a cloud frame (null without WebGL)
    cloudMode: undefined,
    cloudRenderer: null,
    cloudFrameMs: null,
    // The cloud data last drawn, to tell when it changes
    cloudData: null,
    // The clouds' own clock (seconds), which sets where they've drifted to,
    // and the real time it was last moved on at
    cloudClock: Date.now() / 1000,
    cloudClockUpdated: Date.now() / 1000,
    cloudSpeed: 1,
    // While paused (bedtime), the clouds stop moving and their clock stops,
    // so they carry on from where they were
    paused: false,
    animating: false,
    animationTimer: 0,
    animationFrame: 0,
    // When the sky was last painted (ms, see PAINT_INTERVAL)
    paintedAt: -Infinity,
    // Rain and snow, and the timer drawing them while there's any (and the
    // time it last drew, in ms)
    precipitation: createPrecipitation(canvases.precipitation),
    precipitationTimer: 0,
    precipitationDrawn: 0,
    // The latest scene: settings, windowSize and fadeDuration
    props: null,
    // What the page was last told about its canvases (see reportLayers)
    layersReported: null,
  };

  /*
   * Tells the page (with `report({ layers })`) how to show the canvases it
   * places itself, when that changes: whether the stars, moon, clouds and
   * rain or snow have anything to show (so empty full-screen canvases are hidden rather than
   * composited), and where the moon's canvas goes (in CSS pixels, its top
   * left and size)
   */
  function reportLayers() {
    const { stars, moon } = state;
    const { pixelRatio } = state.props.windowSize;
    const { low, mid, high } = state.props.settings.clouds;
    const layers = {
      stars: stars.key !== 'day' && stars.key !== undefined,
      clouds: low > 0 || mid > 0 || high > 0,
      precipitation: state.precipitation.active(),
      moon:
        moon.key !== null
          ? { left: moon.left / pixelRatio, top: moon.top / pixelRatio, size: moon.canvas.width / pixelRatio }
          : null,
    };
    const text = JSON.stringify(layers);
    if (text === state.layersReported) return;
    state.layersReported = text;
    report({ layers });
  }

  // Shows each fade as of now, continuing each animation frame until they're
  // done, at most every PAINT_INTERVAL (waiting a frame if it's too soon).
  // The sky and haze are columns 1 pixel wide that the page stretches, so
  // fading them only changes those columns; the stars and moon are on their
  // own canvases, only changed when they are.
  function paint() {
    const { sky, haze, cloudRenderer } = state;
    const now = performance.now();
    if (now - state.paintedAt < PAINT_INTERVAL - PAINT_SLACK) {
      state.animationFrame = requestFrame(paint);
      return;
    }
    state.paintedAt = now;
    let fading = false;

    for (const layer of [sky, haze]) {
      if (layer.changes.length === 0) continue;
      const progress = fadeProgress(layer.fade, now);
      blendLayer(layer, progress);
      layer.canvas.getContext('2d').putImageData(layer.image, 0, 0);
      if (progress < 1) fading = true;
    }
    if (cloudRenderer?.paint(now)) fading = true;

    state.animationFrame = fading ? requestFrame(paint) : 0;
  }

  function startPainting() {
    cancelFrame(state.animationFrame);
    state.animationFrame = requestFrame(paint);
  }

  // The time to show the clouds at, from their own clock. While they're
  // moving, it runs at the cloud speed times real time, so changing the speed
  // changes how fast they move on from where they are, without a jump.
  function cloudTime() {
    const now = Date.now() / 1000;
    if (state.animating && !state.paused) state.cloudClock += (now - state.cloudClockUpdated) * state.cloudSpeed;
    state.cloudClockUpdated = now;
    return state.cloudClock;
  }

  function sizes() {
    const { width, height, pixelRatio } = state.props.windowSize;
    return {
      fullWidth: Math.round(width * pixelRatio),
      fullHeight: Math.round(height * pixelRatio),
      cloudWidth: Math.max(1, Math.round(width * RENDER_SCALE)),
      cloudHeight: Math.max(1, Math.round(height * RENDER_SCALE)),
    };
  }

  // Starts or stops cloud motion, which runs while there are cloud layers to
  // move and it isn't paused (and, with WebGL, while the GPU is fast enough)
  function updateAnimation() {
    const { low, mid, high } = state.props.settings.clouds;
    const run = state.animating && !state.paused && (low > 0 || mid > 0 || high > 0);
    if (run && !state.animationTimer) {
      state.animationTimer = setInterval(() => drawCloudFrame(CLOUD_INTERVAL), CLOUD_INTERVAL);
    } else if (!run && state.animationTimer) {
      clearInterval(state.animationTimer);
      state.animationTimer = 0;
    }
  }

  // Starts or stops drawing rain and snow, which runs while there's any and
  // it isn't paused
  function updatePrecipitation() {
    const { precipitation } = state;
    const { fullWidth, fullHeight } = sizes();
    precipitation.setScene(
      state.props.settings.precipitation || {},
      Math.max(1, Math.round(fullWidth * PRECIPITATION_SCALE)),
      Math.max(1, Math.round(fullHeight * PRECIPITATION_SCALE)),
    );
    const run = precipitation.active() && !state.paused;
    if (run && !state.precipitationTimer) {
      state.precipitationDrawn = performance.now();
      state.precipitationTimer = setInterval(() => {
        const now = performance.now();
        // (at most a quarter second at once, so a long stall doesn't jump)
        precipitation.frame(Math.min(0.25, (now - state.precipitationDrawn) / 1000));
        state.precipitationDrawn = now;
      }, PRECIPITATION_INTERVAL);
    } else if (!run && state.precipitationTimer) {
      clearInterval(state.precipitationTimer);
      state.precipitationTimer = 0;
    }
    // With none left, clears what was drawn
    if (!precipitation.active()) precipitation.frame(0);
  }

  // Moves the clouds on: with WebGL, a new frame faded in over `duration` ms
  function drawCloudFrame(duration) {
    if (!state.cloudRenderer || !state.cloudData) return;
    const time = cloudTime();
    if (state.cloudMode === 'webgl') {
      state.cloudRenderer.drawFrame({ ...state.props.settings, time }, time, duration);
    } else {
      state.cloudRenderer.step(time);
    }
    startPainting();
  }

  /**
   * Chooses how to draw the clouds: with WebGL if the GPU draws a frame within
   * CLOUD_ANIMATION_BUDGET (timed on a spare canvas, since a canvas can only
   * ever have one kind of drawing context), otherwise on the CPU
   */
  function chooseCloudRenderer(settings, data, width, height) {
    const trial = forceCpuClouds ? null : createCloudRenderer(createCanvas());
    if (trial) {
      trial.setScene(data, width, height);
      state.cloudFrameMs = trial.measureFrame(settings);
      trial.dispose();
      if (state.cloudFrameMs <= CLOUD_ANIMATION_BUDGET) {
        state.cloudRenderer = createCloudRenderer(canvases.clouds);
      }
    }
    if (state.cloudRenderer) {
      state.cloudMode = 'webgl';
      return;
    }
    state.cloudMode = 'cpu';
    state.cloudRenderer = createCpuCloudRenderer(canvases.clouds, createCanvas, () => state.cloudSpeed);
    state.cloudRenderer.setOnFrame(startPainting);
    state.animating = true;
  }

  /**
   * Draws the cloud layers for new settings, from `data` (cloudShaderData)
   * and `rows` (computeRows), if anything about them has changed
   */
  function drawClouds(settings, data, rows, duration) {
    const { cloudWidth, cloudHeight } = sizes();
    const resized = state.cloudData?.width !== cloudWidth || state.cloudData?.height !== cloudHeight;
    const tolerance = state.cloudMode === 'cpu' ? CPU_RECOLOR_STEP : 0;
    if (!resized && sameCloudData(data, state.cloudData, tolerance)) return false;

    if (state.cloudMode === undefined) chooseCloudRenderer(settings, data, cloudWidth, cloudHeight);
    const renderer = state.cloudRenderer;
    if (state.cloudMode === 'webgl') {
      renderer.setScene(data, cloudWidth, cloudHeight);
      // Times the GPU at each new size, to decide whether the clouds can move
      if (resized) {
        state.cloudFrameMs = renderer.measureFrame(settings);
        state.animating = state.cloudFrameMs <= CLOUD_ANIMATION_BUDGET;
      }
      renderer.drawFrame(settings, settings.time, duration);
    } else {
      renderer.setScene(settings, rows, cloudWidth, cloudHeight, duration);
    }
    state.cloudData = { ...data, width: cloudWidth, height: cloudHeight };
    return true;
  }

  // Draws the stars and the glow where they're densest, if they've changed
  function drawStarLayer(settings) {
    const { stars } = state;
    const { fullWidth, fullHeight } = sizes();
    const resized = stars.canvas.width !== fullWidth || stars.canvas.height !== fullHeight;
    const key = starsKey(settings);
    if (!resized && key !== null && key === stars.key) return false;
    // In twilight, only every STAR_TWILIGHT_INTERVAL, unless the star
    // settings changed
    const now = performance.now();
    if (
      !resized &&
      key === null &&
      stars.key === null &&
      JSON.stringify(settings.stars) === stars.sizing &&
      now - stars.workedOutAt < STAR_TWILIGHT_INTERVAL
    ) {
      return false;
    }
    stars.workedOutAt = now;
    stars.key = key;
    resize(stars.canvas, fullWidth, fullHeight);
    const context = stars.canvas.getContext('2d');

    // In daylight no stars show
    if (key === 'day') {
      context.clearRect(0, 0, fullWidth, fullHeight);
      stars.colors = null;
      stars.glow = null;
      stars.changed = true;
      return true;
    }

    const { width, height } = state.props.windowSize;
    const colors = starColors(settings);
    const glow = stars.glowCanvas;
    resize(glow, STAR_GLOW_WIDTH, Math.max(1, Math.round((STAR_GLOW_WIDTH * height) / width)));
    const glowContext = glow.getContext('2d');
    const glowImage = glowContext.createImageData(glow.width, glow.height);
    renderStarGlow(glowImage.data, glow.width, glow.height, settings);
    const sizing = JSON.stringify(settings.stars);
    if (
      !resized &&
      sizing === stars.sizing &&
      sameValues(colors, stars.colors) &&
      sameValues(glowImage.data, stars.glow)
    ) {
      return false;
    }
    context.clearRect(0, 0, fullWidth, fullHeight);
    glowContext.putImageData(glowImage, 0, 0);
    context.drawImage(glow, 0, 0, fullWidth, fullHeight);
    drawStars(context, fullWidth, fullHeight, colors, Math.max(1, Math.round(state.props.windowSize.pixelRatio)), settings);
    stars.colors = colors;
    stars.sizing = sizing;
    stars.glow = glowImage.data;
    stars.changed = true;
    return true;
  }

  /**
   * Draws the moon for the sky behind it, if that or the moon's settings
   * changed. `skyColumn` is the sky as drawn (at the clouds' resolution).
   */
  function drawMoon(settings, skyColumn) {
    const { moon } = state;
    if (!moon.picture) return false;
    const { fullWidth, fullHeight, cloudHeight } = sizes();
    const radius = MOON_RADIUS * fullHeight;
    const diameter = Math.max(1, Math.round(2 * radius));
    if (moon.image?.width !== diameter) moon.image = scaledPicture(moon.picture, diameter);
    // The moon and its glow, on a square canvas centered on the moon
    const size = diameter + 2 * moonGlowMargin(radius, settings);
    const altitude = settings.moon.altitude ?? DEFAULT_MOON_ALTITUDE;
    const centerX = fullWidth * (1 - MOON_FROM_RIGHT) - radius;
    const centerY = fullHeight - (Math.min(altitude, MOON_TOP_ALTITUDE) / MOON_TOP_ALTITUDE) * (fullHeight - radius);
    const left = Math.round(centerX - size / 2);
    const top = Math.round(centerY - size / 2);
    // Below the screen (with the moon below the horizon), there's nothing to draw
    if (top >= fullHeight) {
      const changed = moon.key !== null;
      Object.assign(moon, { key: null, changed: moon.changed || changed });
      return changed;
    }
    // Where it's drawn for: where it was last drawn, if it's only moved a little
    const drawTop = moon.key !== null && Math.abs(top - moon.drawnTop) < MOON_REDRAW_MOVE ? moon.drawnTop : top;
    // The sky rows behind the moon, which are all of the sky it depends on. As
    // the sun moves they change by a step most seconds, so the moon is only
    // redrawn once they've changed by more than INSTANT_CHANGE steps since it
    // was last drawn. The phase moves on very slowly, so it's only redrawn for
    // steps of 0.0001.
    const firstRow = Math.max(0, Math.floor((drawTop / fullHeight) * cloudHeight));
    const lastRow = Math.min(cloudHeight, Math.ceil(((drawTop + size) / fullHeight) * cloudHeight) + 1);
    const sky = skyColumn.slice(firstRow * 4, lastRow * 4);
    // The rotation and lit side change slowly too, so they're redrawn in
    // steps of MOON_ANGLE_STEP degrees
    const { altitude: _, phase, rotation, brightLimb, ...moonSettings } = settings.moon;
    const step = (angle) => (typeof angle === 'number' ? Math.round(angle / MOON_ANGLE_STEP) * MOON_ANGLE_STEP : angle);
    settings = { ...settings, moon: { ...settings.moon, rotation: step(rotation), brightLimb: step(brightLimb) } };
    const key = JSON.stringify([
      left,
      drawTop,
      size,
      fullHeight,
      moonSettings,
      phase === null || phase === undefined ? null : Math.round(phase * 10000),
      settings.moon.rotation,
      settings.moon.brightLimb,
      settings.exposure,
      // (the haze changes how it's drawn, see hazyMoon)
      Math.round(overcastOf(settings.clouds)),
    ]);
    if (key === moon.key && sameValues(sky, moon.sky, INSTANT_CHANGE)) {
      // Nothing to draw again, though it may have moved a little
      if (top === moon.top) return false;
      Object.assign(moon, { top, changed: true });
      return true;
    }
    // The pixels are drawn into the same image each time while its size holds
    if (moon.pixels?.width !== size) moon.pixels = new ImageData(size, size);
    moon.shown = renderMoon(moon.pixels.data, size, moon.image.data, diameter, top, fullHeight, settings);
    resize(moon.canvas, size, size);
    moon.canvas.getContext('2d').putImageData(moon.pixels, 0, 0);
    Object.assign(moon, { left, top, drawnTop: top, key, sky, changed: true });
    return true;
  }

  /**
   * The moonlight on the clouds around the moon (see moonCloudLight), in the
   * clouds' pixels: { x, y (the moon's center, from the top left), radius
   * (how far it reaches), strength (0–1) }, or null with none to see
   */
  function moonLightOnClouds(settings) {
    const { moon } = state;
    if (moon.key === null || !(moon.shown > 0)) return null;
    const { fullHeight, cloudHeight } = sizes();
    const { reach, strength } = moonCloudLight(settings, moon.shown);
    if (strength < MOON_CLOUD_LIGHT_LEAST) return null;
    const scale = cloudHeight / fullHeight;
    const center = moon.canvas.width / 2;
    return {
      x: Math.round((moon.left + center) * scale),
      y: Math.round((moon.top + center) * scale),
      radius: Math.max(1, Math.round(reach * MOON_RADIUS * fullHeight * scale)),
      strength: Math.round(strength * 100) / 100,
    };
  }

  // Loads the moon picture's pixels, then draws the scene again with it
  async function loadMoon() {
    try {
      state.moon.picture = await createImageBitmap(await (await fetch(moonUrl)).blob());
      if (state.props) drawAll();
    } catch (error) {
      console.error('The moon picture could not be loaded:', error);
    }
  }
  loadMoon();

  // The pixels of `picture` smoothly scaled to `size` × `size`
  function scaledPicture(picture, size) {
    const canvas = createCanvas();
    resize(canvas, size, size);
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(picture, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  }

  // Draws every layer for the current settings, fading them in
  function drawAll() {
    const started = performance.now();
    const { fadeDuration } = state.props;
    const settings = { ...state.props.settings, time: cloudTime() };
    const { cloudHeight } = sizes();

    // Every layer's colors by height, worked out once at the clouds' resolution
    const rows = computeRows(settings, cloudHeight);
    const skyColumn = new Uint8ClampedArray(cloudHeight * 4);
    renderSkyColumn(skyColumn, cloudHeight, settings, rows);
    setLayerFrame(state.sky, skyColumn, 1, cloudHeight, fadeDuration, INSTANT_CHANGE);
    const hazeColumn = new Uint8ClampedArray(cloudHeight * 4);
    renderHazeColumn(hazeColumn, cloudHeight, settings, rows);
    setLayerFrame(state.haze, hazeColumn, 1, cloudHeight, fadeDuration, INSTANT_CHANGE);
    const skyDone = performance.now();

    const starsRedrawn = drawStarLayer(settings);
    const starsDone = performance.now();

    const moonRedrawn = drawMoon(settings, skyColumn);
    const moonDone = performance.now();

    const moonLight = moonLightOnClouds(settings);
    const cloudData = cloudShaderData(settings, cloudHeight, rows);
    // (on the CPU, it's put on as the clouds are drawn, so needn't recolor them)
    if (state.cloudMode !== 'cpu') cloudData.uniforms.moonLight = moonLight;
    const cloudsRedrawn = drawClouds(settings, cloudData, rows, fadeDuration);
    if (state.cloudMode === 'cpu') state.cloudRenderer.setMoonLight(moonLight, moonCloudFalloff, moonCloudColor);
    updateAnimation();
    updatePrecipitation();
    startPainting();
    reportLayers();
    const done = performance.now();

    report({
      status: {
        cloudRenderer: state.cloudMode === 'webgl' ? 'WebGL' : 'CPU',
        cloudFrameMs: state.cloudFrameMs,
        cpuClouds:
          state.cloudMode === 'cpu' ? { ...state.cloudRenderer.timings(), forced: forceCpuClouds } : null,
        animating: state.animating,
        fullUpdate: {
          totalMs: done - started,
          skyMs: skyDone - started,
          starsMs: starsDone - skyDone,
          starsRedrawn,
          moonMs: moonDone - starsDone,
          moonRedrawn,
          cloudsMs: done - moonDone,
          cloudsRedrawn,
        },
      },
    });
  }

  return {
    /**
     * Draws the scene for new `props`: { settings (as for renderClouds,
     * without `time`), windowSize: { width, height, pixelRatio }, fadeDuration }
     */
    setScene(props) {
      state.props = props;
      drawAll();
    },

    // Sets how fast the clouds move, as a multiple of their normal drift
    setCloudSpeed(speed) {
      cloudTime();
      state.cloudSpeed = speed;
    },

    // Pauses or resumes cloud motion. New scenes are still drawn while paused.
    setPaused(paused) {
      cloudTime();
      state.paused = paused;
      if (state.props) {
        updateAnimation();
        updatePrecipitation();
      }
    },

    dispose() {
      cancelFrame(state.animationFrame);
      clearInterval(state.animationTimer);
      clearInterval(state.precipitationTimer);
    },
  };
}

/**
 * Whether two sets of cloud data (from cloudShaderData) would draw the same
 * clouds, allowing their colors to differ by up to `tolerance` steps (with
 * the layers' share of the glow boost allowed to differ by as much)
 */
function sameCloudData(a, b, tolerance = 0) {
  if (!a || !b) return false;
  const layers = (data) =>
    JSON.stringify(
      tolerance > 0
        ? data.layers.map((layer) => ({ ...layer, boostShare: Math.round((layer.boostShare * 255) / tolerance) }))
        : data.layers,
    );
  return (
    sameValues(a.rows, b.rows, tolerance) &&
    (a.scatteringLut === b.scatteringLut || sameValues(a.scatteringLut, b.scatteringLut, tolerance)) &&
    JSON.stringify(a.uniforms) === JSON.stringify(b.uniforms) &&
    layers(a) === layers(b)
  );
}

// Whether two arrays of numbers hold the same values, to within `tolerance`
function sameValues(a, b, tolerance = 0) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
  return true;
}

/*
 * A layer faded between frames in JavaScript: the image being shown, and for
 * each pixel that differs from the new frame, its old and new values with the
 * colors multiplied by the opacity. Blending those straight from old to new
 * keeps what's on screen exactly between the two frames at every step, even
 * where the opacity changes.
 */
function createLayer(canvas) {
  return {
    canvas,
    image: null,
    changes: new Int32Array(0),
    from: null,
    to: null,
    target: null,
    fade: { start: 0, duration: 1 },
    changed: false,
  };
}

/**
 * Starts fading `layer` to `next` (RGBA, width × height) over `duration` ms.
 * At a new size, or if no value changes by more than `instantChange` steps,
 * the new frame is shown straight away.
 */
function setLayerFrame(layer, next, width, height, duration, instantChange = 0) {
  if (layer.image?.width !== width || layer.image?.height !== height) {
    layer.image = new ImageData(new Uint8ClampedArray(next), width, height);
    resize(layer.canvas, width, height);
    layer.canvas.getContext('2d').putImageData(layer.image, 0, 0);
    layer.changes = new Int32Array(0);
    layer.changed = true;
    return;
  }

  const shown = layer.image.data;
  const differs = (i) =>
    shown[i] !== next[i] ||
    shown[i + 1] !== next[i + 1] ||
    shown[i + 2] !== next[i + 2] ||
    shown[i + 3] !== next[i + 3];
  let count = 0;
  let largest = 0;
  for (let i = 0; i < next.length; i += 4) {
    if (!differs(i)) continue;
    count++;
    for (let byte = 0; byte < 4; byte++) largest = Math.max(largest, Math.abs(shown[i + byte] - next[i + byte]));
  }

  layer.changes = new Int32Array(count);
  layer.from = new Float32Array(count * 4);
  layer.to = new Float32Array(count * 4);
  layer.target = next;
  layer.fade = { start: performance.now(), duration: largest <= instantChange ? 1 : duration };
  let k = 0;
  for (let i = 0; i < next.length; i += 4) {
    if (!differs(i)) continue;
    layer.changes[k] = i;
    for (let channel = 0; channel < 3; channel++) {
      layer.from[k * 4 + channel] = (shown[i + channel] * shown[i + 3]) / 255;
      layer.to[k * 4 + channel] = (next[i + channel] * next[i + 3]) / 255;
    }
    layer.from[k * 4 + 3] = shown[i + 3];
    layer.to[k * 4 + 3] = next[i + 3];
    k++;
  }
}

// Updates the image `layer` shows to `progress` (0–1) of the way through its fade
function blendLayer(layer, progress) {
  const shown = layer.image.data;
  const { changes, from, to, target } = layer;
  layer.changed = true;
  if (progress >= 1) {
    for (const i of changes) {
      for (let byte = 0; byte < 4; byte++) shown[i + byte] = target[i + byte];
    }
    layer.changes = new Int32Array(0);
    return;
  }
  for (let k = 0; k < changes.length; k++) {
    const i = changes[k];
    const alpha = from[k * 4 + 3] + (to[k * 4 + 3] - from[k * 4 + 3]) * progress;
    for (let channel = 0; channel < 3; channel++) {
      const premultiplied =
        from[k * 4 + channel] + (to[k * 4 + channel] - from[k * 4 + channel]) * progress;
      shown[i + channel] = alpha > 0 ? (premultiplied * 255) / alpha : 0;
    }
    shown[i + 3] = alpha;
  }
}

function fadeProgress(fade, now) {
  return Math.min(1, (now - fade.start) / fade.duration);
}

// Sets a canvas's size, which also clears it, only if it's changing
function resize(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}
