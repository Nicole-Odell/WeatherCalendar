import { useCallback, useEffect, useRef, useState } from 'react';
import { readableTextColor } from './color.js';
import {
  renderClouds,
  renderHazeColumn,
  renderSkyColumn,
  renderStarGlow,
  renderStars,
} from './skyImage.js';

// Share of the window's resolution the clouds are drawn at. The browser smooths
// them up to full size, which suits soft clouds and keeps drawing fast.
const CLOUD_RENDER_SCALE = 0.25;
// Width in pixels the star glow is drawn at before being smoothed up
const STAR_GLOW_WIDTH = 240;
// How often a new frame of cloud motion is drawn (ms), faded in over the same time
const CLOUD_INTERVAL = 250;
// How long changes to the settings take to fade in (ms)
const SETTINGS_FADE = 300;

/**
 * The sky, stars, clouds and haze, drawn behind the page on three canvases
 * stacked with normal blending:
 * 1. The sky, with the stars added over it with a screen blend. It only
 *    changes when the settings do.
 * 2. The cloud layers, with a new frame of their motion every CLOUD_INTERVAL.
 * 3. The haze, which only changes when the settings do.
 * Each new frame fades in from what's showing. Only pixels that differ between
 * the two frames change, and each moves straight from its old value to its new
 * one, so layers that aren't changing stay exactly as they are. Reports the
 * text color that's easiest to read over the scene through onTextColor.
 */
export default function SkyCanvas(props) {
  const backgroundRef = useRef(null);
  const cloudsRef = useRef(null);
  const hazeRef = useRef(null);
  const state = useRef(null);
  if (!state.current) {
    const offScreen = () => document.createElement('canvas');
    state.current = {
      sky: createLayer(offScreen()),
      clouds: createLayer(null),
      haze: createLayer(null),
      // Star frames: what was showing, the new frame, and the blend being shown
      stars: {
        from: offScreen(),
        to: offScreen(),
        shown: offScreen(),
        fade: { start: 0, duration: 1 },
        fading: false,
      },
      animationFrame: 0,
    };
  }
  const [windowSize, setWindowSize] = useState(currentWindowSize);
  // The latest props, for drawing cloud frames
  const latest = useRef(null);
  latest.current = { ...props, windowSize };

  useEffect(() => {
    const onResize = () => setWindowSize(currentWindowSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Shows each fade as of now, continuing each animation frame until they're done
  const paint = useCallback(() => {
    const { sky, clouds, haze, stars } = state.current;
    const now = performance.now();
    let fading = false;

    for (const layer of [sky, clouds, haze]) {
      if (layer.changes.length === 0) continue;
      const progress = fadeProgress(layer.fade, now);
      blendLayer(layer, progress);
      layer.canvas.getContext('2d').putImageData(layer.image, 0, 0);
      if (progress < 1) fading = true;
    }
    const backgroundChanged = sky.changed || stars.fading;
    sky.changed = false;
    if (stars.fading) {
      const progress = fadeProgress(stars.fade, now);
      blendFrames(stars.shown, stars.from, stars.to, progress);
      stars.fading = progress < 1;
      if (stars.fading) fading = true;
    }

    // The sky stretched across the screen, with the stars' light added over it
    if (backgroundChanged) {
      const canvas = backgroundRef.current;
      const context = canvas.getContext('2d');
      context.globalCompositeOperation = 'copy';
      context.drawImage(sky.canvas, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'screen';
      context.drawImage(stars.shown, 0, 0, canvas.width, canvas.height);
    }

    state.current.animationFrame = fading ? requestAnimationFrame(paint) : 0;
  }, []);

  const startPainting = useCallback(() => {
    cancelAnimationFrame(state.current.animationFrame);
    state.current.animationFrame = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(
    () => () => {
      cancelAnimationFrame(state.current.animationFrame);
      state.current.animationFrame = 0;
    },
    [],
  );

  // Draws a new frame of the cloud layers, fading it in over `duration` ms.
  // Returns the average color of the scene.
  const drawClouds = useCallback(
    (duration) => {
      const settings = sceneSettings(latest.current);
      const { width, height } = latest.current.windowSize;
      const cloudWidth = Math.max(1, Math.round(width * CLOUD_RENDER_SCALE));
      const cloudHeight = Math.max(1, Math.round(height * CLOUD_RENDER_SCALE));
      const next = new Uint8ClampedArray(cloudWidth * cloudHeight * 4);
      const average = renderClouds(next, cloudWidth, cloudHeight, settings);
      const { clouds } = state.current;
      clouds.canvas = cloudsRef.current;
      setLayerFrame(clouds, next, cloudWidth, cloudHeight, duration);
      startPainting();
      return average;
    },
    [startPainting],
  );

  // Draws every layer for the current settings, fading them in over `duration` ms
  const drawAll = useCallback(
    (duration) => {
      const settings = sceneSettings(latest.current);
      const { width, height, pixelRatio } = latest.current.windowSize;
      const fullWidth = Math.round(width * pixelRatio);
      const fullHeight = Math.round(height * pixelRatio);
      const { sky, haze, stars } = state.current;
      const background = backgroundRef.current;
      if (background.width !== fullWidth || background.height !== fullHeight) {
        resize(background, fullWidth, fullHeight);
        sky.changed = true;
      }

      const skyColumn = new Uint8ClampedArray(fullHeight * 4);
      renderSkyColumn(skyColumn, fullHeight, settings);
      setLayerFrame(sky, skyColumn, 1, fullHeight, duration);

      const hazeColumn = new Uint8ClampedArray(fullHeight * 4);
      renderHazeColumn(hazeColumn, fullHeight, settings);
      haze.canvas = hazeRef.current;
      setLayerFrame(haze, hazeColumn, 1, fullHeight, duration);

      // The new stars, over the glow where they're densest, fading in from
      // the stars showing now
      copyInto(stars.from, stars.shown, fullWidth, fullHeight);
      resize(stars.shown, fullWidth, fullHeight);
      resize(stars.to, fullWidth, fullHeight);
      const starsContext = stars.to.getContext('2d');
      starsContext.clearRect(0, 0, fullWidth, fullHeight);
      const glow = document.createElement('canvas');
      glow.width = STAR_GLOW_WIDTH;
      glow.height = Math.max(1, Math.round((STAR_GLOW_WIDTH * height) / width));
      const glowContext = glow.getContext('2d');
      const glowImage = glowContext.createImageData(glow.width, glow.height);
      renderStarGlow(glowImage.data, glow.width, glow.height, settings);
      glowContext.putImageData(glowImage, 0, 0);
      starsContext.drawImage(glow, 0, 0, fullWidth, fullHeight);
      renderStars(starsContext, fullWidth, fullHeight, settings, Math.max(1, Math.round(pixelRatio)));
      stars.fade = { start: performance.now(), duration };
      stars.fading = true;

      const average = drawClouds(duration);
      latest.current.onTextColor(readableTextColor(average));
    },
    [drawClouds],
  );

  const { colors, sunElevation, exposure, clouds, cloudBrightness, hazeContrast } = props;
  const { total, low, mid, high } = clouds;
  useEffect(() => {
    drawAll(SETTINGS_FADE);
  }, [
    drawAll,
    windowSize,
    colors,
    sunElevation,
    exposure,
    total,
    low,
    mid,
    high,
    cloudBrightness,
    hazeContrast,
  ]);

  // Cloud motion, only while there are cloud layers to move
  const hasCloudLayers = low > 0 || mid > 0 || high > 0;
  useEffect(() => {
    if (!hasCloudLayers) return undefined;
    const timer = setInterval(() => drawClouds(CLOUD_INTERVAL), CLOUD_INTERVAL);
    return () => clearInterval(timer);
  }, [drawClouds, hasCloudLayers]);

  return (
    <>
      <canvas ref={backgroundRef} className="sky-background" />
      <canvas ref={cloudsRef} className="sky-background" />
      <canvas ref={hazeRef} className="sky-background" />
    </>
  );
}

// The settings for drawing the scene now, from the component's props
function sceneSettings({ colors, sunElevation, exposure, clouds, cloudBrightness, hazeContrast }) {
  return {
    colors,
    sunElevation,
    exposure,
    clouds,
    cloudBrightness,
    hazeContrast,
    time: Date.now() / 1000,
  };
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
 * At a new size, the new frame is shown straight away.
 */
function setLayerFrame(layer, next, width, height, duration) {
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
  for (let i = 0; i < next.length; i += 4) if (differs(i)) count++;

  layer.changes = new Int32Array(count);
  layer.from = new Float32Array(count * 4);
  layer.to = new Float32Array(count * 4);
  layer.target = next;
  layer.fade = { start: performance.now(), duration };
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

/**
 * Shows `to` faded in over `from` by `progress` (0–1) in `target`. Both frames
 * are opaque (the stars are black where there's nothing), so drawing the new
 * one over the old blends each pixel between them in one step, which keeps
 * rounding from making faint light flicker.
 */
function blendFrames(target, from, to, progress) {
  const context = target.getContext('2d');
  context.globalCompositeOperation = 'copy';
  context.globalAlpha = 1;
  context.drawImage(from, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = progress;
  context.drawImage(to, 0, 0);
}

// Sets a canvas's size, which also clears it, only if it's changing
function resize(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

// Replaces `target` with a copy of `source`, scaled to width × height
function copyInto(target, source, width, height) {
  resize(target, width, height);
  const context = target.getContext('2d');
  context.globalCompositeOperation = 'copy';
  context.drawImage(source, 0, 0, width, height);
}

function currentWindowSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio || 1,
  };
}
