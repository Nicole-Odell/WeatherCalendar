import { cloudBands, cloudShapeKey, cloudShapes, colorClouds, computeRows } from './skyImage.js';

// Cloud time (seconds on the clouds' own clock) between new cloud shapes,
// which pick up the slow change in the clouds' form as they drift
const SHAPE_REFRESH = 24;
// How long new shapes from the drift take to fade in (ms), so the change in
// form is gradual
const SHAPE_FADE = 3000;
// Longest the shape work runs at a time (ms) before letting other work in, so
// motion and sky updates carry on while it's done
const SLICE_MS = 12;
// Rows of shapes worked out between checks of the time
const SLICE_ROWS = 4;
// A recolor changing no value by more than this many steps (of 255) is shown
// straight away: too small to see, so not worth fading
const INSTANT_CHANGE = 2;
// Shape work time (ms) assumed before any has been timed
const FIRST_SHAPES_MS = 1000;
// The columns off the left of the screen are rounded up to a multiple of
// this, so frames keep the same size and their canvases and arrays can be
// reused (see the pools below)
const MARGIN_STEP = 16;
// Most canvases and arrays of each size kept for reuse
const POOL_SIZE = 4;

/**
 * Draws the cloud layers on the CPU, with motion, into `canvas` (2D). Each
 * layer only drifts sideways, so the slow part, working out the shapes (noise
 * at every pixel), is done once for an image a little wider than the screen,
 * and the layer's band of rows is then slid across as cloud time runs on.
 * Coloring the shapes is quick, so it's redone as the sky changes. Every
 * SHAPE_REFRESH seconds of cloud time, new shapes are worked out in short
 * pieces (so nothing waits on them) and faded in.
 *
 * `createCanvas()` makes an off-screen canvas, and `cloudSpeed()` gives the
 * current cloud speed (to know how far the clouds drift while shapes are
 * worked out). It has the same paint(now) as the WebGL renderer in cloudsGL.js.
 */
export function createCpuCloudRenderer(canvas, createCanvas, cloudSpeed) {
  const state = {
    // The scene from setScene: settings (with `time`, the cloud clock), the
    // row colors for it, and the image size
    settings: null,
    rows: null,
    width: 0,
    height: 0,
    shapeKey: null,
    // The cloud clock the clouds are shown at
    clock: 0,
    // Frames faded between (see createFrame): `to` fades in over `from`
    from: null,
    to: null,
    fade: { start: 0, duration: 1 },
    // Shapes being worked out, if any
    job: null,
    // How long the last shapes took (ms, from start to finish, including
    // breaks for other work) and the last coloring
    shapesMs: null,
    colorsMs: null,
  };

  /*
   * Canvases and arrays from frames that are done with, kept for new frames.
   * New ones are made several times a minute; on a small device like the Pi 3
   * the memory of discarded ones isn't always freed promptly, so reusing them
   * keeps memory steady.
   */
  const canvasPool = [];
  const arrayPools = new Map();

  function takeArray(Type, length) {
    const pool = arrayPools.get(Type)?.get(length);
    return pool?.length ? pool.pop() : new Type(length);
  }

  function returnArray(array) {
    if (!array) return;
    if (!arrayPools.has(array.constructor)) arrayPools.set(array.constructor, new Map());
    const pools = arrayPools.get(array.constructor);
    if (!pools.has(array.length)) pools.set(array.length, []);
    const pool = pools.get(array.length);
    if (pool.length < POOL_SIZE) pool.push(array);
  }

  // A frame: an image `width` × `height` of the clouds at cloud time `clock`,
  // with its first `margin` columns off the left of the screen. `shapes` (if it
  // has them) can be recolored; a frame made from a blend of others has none.
  function createFrame(width, height, margin, clock, bands, shapes) {
    const frameCanvas = canvasPool.pop() ?? createCanvas();
    if (frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas.width = width;
      frameCanvas.height = height;
    }
    return { canvas: frameCanvas, width, height, margin, clock, bands, shapes, pixels: null };
  }

  // Puts a frame that's no longer shown back in the pools
  function retire(frame) {
    if (!frame) return;
    if (canvasPool.length < POOL_SIZE) canvasPool.push(frame.canvas);
    if (frame.shapes) Object.values(frame.shapes).forEach(returnArray);
    returnArray(frame.pixels);
  }

  // Colors `frame`'s shapes for the current scene, returning the new pixels
  function colorPixels(frame) {
    const started = performance.now();
    const pixels = takeArray(Uint8ClampedArray, frame.width * frame.height * 4);
    colorClouds(pixels, frame.width, frame.height, state.settings, state.rows, frame.shapes);
    state.colorsMs = performance.now() - started;
    return pixels;
  }

  // Shows `pixels` in `frame`, returning the frame's old pixels to the pool
  function showPixels(frame, pixels) {
    if (frame.pixels !== pixels) returnArray(frame.pixels);
    frame.pixels = pixels;
    frame.canvas.getContext('2d').putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  }

  // Draws `frame` into `context` at the current cloud clock: each band of rows
  // slid right by how far its layer has drifted since the frame's clock, and
  // the whole frame `xOffset` columns further right. A band never slides
  // further than the frame's extra columns: if new shapes are late (the CPU is
  // too busy), its clouds wait at the end rather than leaving an empty edge.
  function drawFrame(context, frame, xOffset) {
    for (const band of frame.bands) {
      const drift = Math.min(frame.margin, (state.clock - frame.clock) * band.speed * frame.height);
      const rows = band.end - band.start;
      context.drawImage(
        frame.canvas,
        0,
        band.start,
        frame.width,
        rows,
        xOffset - frame.margin + drift,
        band.start,
        frame.width,
        rows,
      );
    }
  }

  /**
   * Draws what's shown at `progress` (0–1) through the fade into `target`.
   * The fade is a straight mix of the two frames' premultiplied colors: `from`
   * at (1 − progress), with `to` at `progress` added to it.
   */
  function drawBlend(target, progress, xOffset = 0) {
    const context = target.getContext('2d');
    context.clearRect(0, 0, target.width, target.height);
    const { from, to } = state;
    if (from && progress < 1) {
      context.globalAlpha = 1 - progress;
      drawFrame(context, from, xOffset);
      context.globalCompositeOperation = 'lighter';
      context.globalAlpha = progress;
    }
    if (to) drawFrame(context, to, xOffset);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }

  function fadeProgress(now) {
    return Math.min(1, Math.max(0, (now - state.fade.start) / state.fade.duration));
  }

  // What's shown now, as a frame (without shapes) wide enough to slide on
  function snapshot() {
    const { to, from } = state;
    const bands = [...to.bands];
    for (const band of from?.bands ?? []) {
      if (!bands.some((b) => b.layer === band.layer)) bands.push(band);
    }
    const frame = createFrame(to.width, to.height, to.margin, state.clock, bands, null);
    drawBlend(frame.canvas, fadeProgress(performance.now()), to.margin);
    return frame;
  }

  // Starts fading in `frame` over `duration` ms, from what's shown now
  function fadeTo(frame, duration) {
    if (state.to) {
      if (fadeProgress(performance.now()) < 1) {
        const shown = snapshot();
        retire(state.from);
        retire(state.to);
        state.from = shown;
      } else {
        retire(state.from);
        state.from = state.to;
      }
    }
    state.to = frame;
    state.fade = { start: performance.now(), duration: Math.max(1, duration) };
  }

  /**
   * Starts working out new shapes at the current cloud clock, in pieces
   * between other work, then fades them in over `duration` ms
   */
  function startShapes(duration) {
    const { width, height, clock } = state;
    const settings = { ...state.settings, time: clock };
    const rows = computeRows(settings, height);
    const bands = cloudBands(rows, height);
    // Enough columns off the left of the screen to slide the layers across
    // until these shapes have been replaced: until the next shapes are due,
    // worked out and faded in
    const fastest = Math.max(0, ...bands.map((band) => band.speed));
    const nextShapesSeconds = ((state.shapesMs ?? FIRST_SHAPES_MS) + SHAPE_FADE) / 1000;
    const lifetime = SHAPE_REFRESH + nextShapesSeconds * cloudSpeed();
    const margin = Math.ceil((fastest * height * lifetime * 1.25 + 4) / MARGIN_STEP) * MARGIN_STEP;
    const frame = createFrame(width + margin, height, margin, clock, bands, null);
    const shapes = {
      opacity: takeArray(Float32Array, frame.width * height),
      thinness: takeArray(Float32Array, frame.width * height),
      depth: takeArray(Float32Array, frame.width * height),
    };
    // A job still under way is replaced, so what it was filling in is reused
    if (state.job) retire({ ...state.job.frame, shapes: state.job.shapes });
    const job = { frame, shapes, nextRow: 0, started: performance.now() };
    state.job = job;

    const work = () => {
      // A newer job replaces this one
      if (state.job !== job) return;
      const sliceEnd = performance.now() + SLICE_MS;
      while (job.nextRow < height && performance.now() < sliceEnd) {
        const endRow = Math.min(height, job.nextRow + SLICE_ROWS);
        cloudShapes(frame.width, height, settings, rows, {
          firstColumn: -margin,
          startRow: job.nextRow,
          endRow,
          shapes,
        });
        job.nextRow = endRow;
      }
      if (job.nextRow < height) {
        setTimeout(work, 0);
        return;
      }
      state.job = null;
      state.shapesMs = performance.now() - job.started;
      frame.shapes = shapes;
      showPixels(frame, colorPixels(frame));
      fadeTo(frame, duration);
      onFrame();
    };
    setTimeout(work, 0);
  }

  // Called when a new frame is ready to be shown (set by setOnFrame)
  let onFrame = () => {};

  // Recolors the frames with shapes for the current scene, fading the change
  // in over `duration` ms unless it's too small to see
  function recolor(duration) {
    const frames = [state.from, state.to].filter((frame) => frame?.shapes);
    if (frames.length === 0) return;
    const colored = frames.map((frame) => colorPixels(frame));
    if (frames.every((frame, i) => !differsBeyond(frame.pixels, colored[i], INSTANT_CHANGE))) {
      frames.forEach((frame, i) => showPixels(frame, colored[i]));
      return;
    }
    // A visible change fades in from what's shown now. A fade between shapes
    // that's under way is cut short to this one.
    const shown = snapshot();
    const to = state.to;
    frames.forEach((frame, i) => (frame === to ? showPixels(to, colored[i]) : returnArray(colored[i])));
    retire(state.from);
    state.from = shown;
    state.fade = { start: performance.now(), duration: Math.max(1, duration) };
  }

  return {
    /**
     * Sets the scene: `settings` (with `time`, the cloud clock), `rows` from
     * computeRows for it, the image size, and how long changes take to fade in
     * (ms). New shapes are worked out if the size or anything they depend on
     * changed; otherwise the clouds are just recolored.
     */
    setScene(settings, rows, width, height, duration) {
      const resized = width !== state.width || height !== state.height;
      const shapeKey = cloudShapeKey(settings);
      state.settings = settings;
      state.rows = rows;
      state.clock = settings.time;
      if (resized) {
        state.width = width;
        state.height = height;
        canvas.width = width;
        canvas.height = height;
        retire(state.from);
        retire(state.to);
        state.from = null;
        state.to = null;
      }
      if (resized || shapeKey !== state.shapeKey) {
        state.shapeKey = shapeKey;
        startShapes(resized ? 1 : duration);
      } else {
        recolor(duration);
      }
    },

    /**
     * Moves the clouds on to cloud time `clock`, starting new shapes if
     * they're due. Returns whether a fade is under way (paint shows it).
     */
    step(clock) {
      state.clock = clock;
      const { to } = state;
      if (!state.job && to?.shapes) {
        const drifted = Math.max(0, ...to.bands.map((band) => (clock - to.clock) * band.speed * to.height));
        if (clock - to.clock >= SHAPE_REFRESH || drifted >= to.margin * 0.75) startShapes(SHAPE_FADE);
      }
    },

    // Shows the clouds as of `now`; returns whether a fade is still going
    paint(now) {
      if (!state.to) return false;
      const progress = fadeProgress(now);
      drawBlend(canvas, progress);
      if (progress >= 1 && state.from) {
        retire(state.from);
        state.from = null;
      }
      return progress < 1;
    },

    // Sets what to call when a new frame is ready, to start painting
    setOnFrame(callback) {
      onFrame = callback;
    },

    // How long the last shapes and coloring took (ms)
    timings() {
      return { shapesMs: state.shapesMs, colorsMs: state.colorsMs };
    },
  };
}

// Whether any value of two arrays of the same length differs by more than `limit`
function differsBeyond(a, b, limit) {
  if (!a) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > limit) return true;
  }
  return false;
}
