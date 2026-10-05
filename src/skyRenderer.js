import { createCloudRenderer } from './cloudsGL.js';
import { createCpuCloudRenderer } from './cpuClouds.js';
import moonUrl from '../assets/images/moon.png';
import {
  cloudShaderData,
  computeRows,
  drawStars,
  renderHazeColumn,
  moonGlowMargin,
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
// screen (the horizon) at 0° to its top edge at the top of the screen at 90°.
const MOON_RADIUS = 0.05;
const MOON_FROM_RIGHT = 0.1;
// Altitude (degrees) the moon is shown at until the server has given one
const DEFAULT_MOON_ALTITUDE = 45;
// As the moon rises and sets, it's only drawn again once it has moved this
// many pixels (or the sky or its settings change); until then the drawing
// just moves with it
const MOON_REDRAW_MOVE = 8;
// Width in pixels the star glow is drawn at before being smoothed up
const STAR_GLOW_WIDTH = 240;
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
 * Draws the sky, stars, clouds and haze on three canvases stacked with normal
 * blending, either on the page or on a worker thread (see skyWorker.js):
 * 1. `background`: the sky, with the stars added over it with a screen blend,
 *    and the moon over them (see renderMoon)
 * 2. `clouds`: the cloud layers, drawn with WebGL if the GPU is fast enough,
 *    otherwise on the CPU (see cpuClouds.js)
 * 3. `haze`: the haze, a column 1 pixel wide that the page stretches
 * `createCanvas()` makes an off-screen canvas for drawing the sky and stars
 * into. `report(message)` passes back { status } (renderer and timings).
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
    sky: createLayer(createCanvas()),
    haze: createLayer(canvases.haze),
    // The stars shown, their colors, glow and key (to tell when they change)
    // (the glow is drawn on its own canvas, kept to be reused)
    stars: {
      canvas: createCanvas(),
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
      canvas: createCanvas(),
      left: 0,
      top: 0,
      key: null,
      sky: null,
      changed: false,
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
    // The latest scene: settings, windowSize and fadeDuration
    props: null,
  };

  // Shows each fade as of now, continuing each animation frame until they're done
  function paint() {
    const { sky, haze, stars, moon, cloudRenderer } = state;
    const now = performance.now();
    let fading = false;

    for (const layer of [sky, haze]) {
      if (layer.changes.length === 0) continue;
      const progress = fadeProgress(layer.fade, now);
      blendLayer(layer, progress);
      layer.canvas.getContext('2d').putImageData(layer.image, 0, 0);
      if (progress < 1) fading = true;
    }
    if (cloudRenderer?.paint(now)) fading = true;
    const backgroundChanged = sky.changed || stars.changed || moon.changed;
    sky.changed = false;
    stars.changed = false;
    moon.changed = false;

    // The sky stretched across the screen, with the stars' light added over
    // it, and the moon over them (its colors already include the sky's light)
    if (backgroundChanged) {
      const canvas = canvases.background;
      const context = canvas.getContext('2d');
      context.globalCompositeOperation = 'copy';
      context.drawImage(sky.canvas, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'screen';
      context.drawImage(stars.canvas, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'source-over';
      if (moon.key !== null) context.drawImage(moon.canvas, moon.left, moon.top);
    }

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
    if (!resized && sameValues(colors, stars.colors) && sameValues(glowImage.data, stars.glow)) {
      return false;
    }
    context.clearRect(0, 0, fullWidth, fullHeight);
    glowContext.putImageData(glowImage, 0, 0);
    context.drawImage(glow, 0, 0, fullWidth, fullHeight);
    drawStars(context, fullWidth, fullHeight, colors, Math.max(1, Math.round(state.props.windowSize.pixelRatio)));
    stars.colors = colors;
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
    const centerY = fullHeight - (altitude / 90) * (fullHeight - radius);
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
    ]);
    if (key === moon.key && sameValues(sky, moon.sky, INSTANT_CHANGE)) {
      // Nothing to draw again, though it may have moved a little
      if (top === moon.top) return false;
      Object.assign(moon, { top, changed: true });
      return true;
    }
    // The pixels are drawn into the same image each time while its size holds
    if (moon.pixels?.width !== size) moon.pixels = new ImageData(size, size);
    renderMoon(moon.pixels.data, size, moon.image.data, diameter, top, fullHeight, settings);
    resize(moon.canvas, size, size);
    moon.canvas.getContext('2d').putImageData(moon.pixels, 0, 0);
    Object.assign(moon, { left, top, drawnTop: top, key, sky, changed: true });
    return true;
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
    const { fullWidth, fullHeight, cloudHeight } = sizes();
    if (canvases.background.width !== fullWidth || canvases.background.height !== fullHeight) {
      resize(canvases.background, fullWidth, fullHeight);
      state.sky.changed = true;
    }

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

    const cloudsRedrawn = drawClouds(settings, cloudShaderData(settings, cloudHeight, rows), rows, fadeDuration);
    updateAnimation();
    startPainting();
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
      if (state.props) updateAnimation();
    },

    dispose() {
      cancelFrame(state.animationFrame);
      clearInterval(state.animationTimer);
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
