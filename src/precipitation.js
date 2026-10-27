/*
 * Rain and snow, on one canvas over the sky (see skyRenderer.js).
 *
 * Rain is frames made ahead (by scripts/makeRainTiles.py, for light,
 * moderate and heavy rain), all in one image, which is loaded when needed
 * and copied from: the frame for the time, stretched to the canvas's width
 * and repeated down. Copying is cheap, unlike the hundreds of streaks it
 * shows. It's only drawn every RAIN_INTERVAL ms on its own (more often
 * changes the screen more often, which the Pi 3 is slow at), skipping
 * frames to keep its speed.
 *
 * Snow is drawn as moving particles: each frame draws every particle of a
 * layer in one path with one fill, so the work is a handful of drawing calls
 * however many particles there are. Particles move by real time passed, so
 * motion stays steady if a frame is late. Layers, far to near, give depth:
 * nearer particles are bigger, faster and more opaque. Intensity (0–100)
 * sets how many of each layer's particles show and how opaque they are.
 */

// How often a frame is drawn (ms)
export const PRECIPITATION_INTERVAL = 100;
// Share of the screen's resolution particles are drawn at; the page scales
// them up. At half, clearing and drawing a frame on the Pi 3 takes about a
// quarter of the time it does at full resolution.
export const PRECIPITATION_SCALE = 0.5;
// Sizes and speeds below are in pixels of the display's 1920-pixel-tall
// screen, and counts are for its area, scaled to the canvas drawn
const REFERENCE_WIDTH = 1080;
const REFERENCE_HEIGHT = 1920;

// The rain frames for each intensity (0–100), each used up to `upTo`; how
// many frames each holds, one above the other, and how far apart they are
// in time (ms), as makeRainTiles.py makes them
const RAIN_SHEETS = [
  { upTo: 45, url: '/rain/rain-light.webp' },
  { upTo: 80, url: '/rain/rain-moderate.webp' },
  { upTo: 100, url: '/rain/rain-heavy.webp' },
];
const RAIN_FRAMES = 20;
const RAIN_FRAME_MS = 100;
// How often rain on its own is drawn again (ms); with snow, it's drawn with
// each of the snow's frames
const RAIN_INTERVAL = 333;

/*
 * Snow: flakes `size` px across, falling at `speed` px/s and swaying side to
 * side by up to `sway` px, once every `swayPeriod` s
 */
const SNOW_LAYERS = [
  { count: 220, size: 3, speed: 45, sway: 12, swayPeriod: 5, opacity: 0.55 },
  { count: 110, size: 5, speed: 75, sway: 20, swayPeriod: 4, opacity: 0.7 },
  { count: 40, size: 8, speed: 110, sway: 30, swayPeriod: 3.2, opacity: 0.85 },
];

// (Flakes are drawn as squares, which the scaling up softens: two to three
// times as quick as circles on the Pi 3)

// Particles' places and variations, kept between frames: x and y (px), a
// size and speed factor, and a sway phase (radians)
function createParticles(count, width, height) {
  const particles = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    particles[i * 4] = Math.random() * width;
    particles[i * 4 + 1] = Math.random() * height;
    particles[i * 4 + 2] = 0.7 + 0.6 * Math.random();
    particles[i * 4 + 3] = Math.random() * 2 * Math.PI;
  }
  return particles;
}

/**
 * Returns a drawer for `canvas`: setScene({ rain, snow }, width, height) sets
 * the intensities (0–100) and the canvas's size, and frame(seconds) moves
 * things on by that much time and draws them. `active()` says whether
 * there's anything to draw.
 */
export function createPrecipitation(canvas) {
  const context = canvas.getContext('2d');
  let rain = 0;
  let snow = 0;
  // The rain frames shown (see RAIN_SHEETS): their address, and the image
  // once loaded; and when the rain was last drawn (ms)
  let rainUrl = null;
  let rainSheet = null;
  let rainDrawn = -Infinity;
  let layers = [];
  let width = 0;
  let height = 0;
  let clock = 0;
  let drawnEmpty = true;
  // Pixels drawn per pixel of the reference screen
  let scale = 1;

  // Each layer's particles, made for the most there can be and reused, so
  // changing intensity only changes how many are drawn
  function makeLayers() {
    const area = (width * height) / (REFERENCE_WIDTH * scale * REFERENCE_HEIGHT * scale);
    layers = SNOW_LAYERS.map((layer) => {
      const count = Math.max(1, Math.round(layer.count * area));
      return { ...layer, count, particles: createParticles(count, width, height) };
    });
  }

  // Shows the rain frames at `url` (null for none), loading them
  function useRainSheet(url) {
    if (url === rainUrl) return;
    rainUrl = url;
    if (rainSheet) rainSheet.close();
    rainSheet = null;
    if (!url) return;
    fetch(url)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
      .then((sheet) => {
        // (unless other frames were wanted meanwhile)
        if (rainUrl === url) rainSheet = sheet;
        else sheet.close();
      })
      .catch((error) => console.error('The rain could not be loaded:', error));
  }

  // Draws the rain frame for `now` (ms), stretched across and repeated down
  function drawRain(now) {
    const tileWidth = rainSheet.width;
    const tileHeight = rainSheet.height / RAIN_FRAMES;
    const top = (Math.floor(now / RAIN_FRAME_MS) % RAIN_FRAMES) * tileHeight;
    const drawnHeight = (width * tileHeight) / tileWidth;
    for (let y = 0; y < height; y += drawnHeight) {
      context.drawImage(rainSheet, 0, top, tileWidth, tileHeight, 0, y, width, drawnHeight);
    }
    rainDrawn = now;
  }

  function drawSnow(layer, shown, share) {
    const { particles, swayPeriod } = layer;
    const size = layer.size * scale;
    const sway = layer.sway * scale;
    context.fillStyle = `rgba(255, 255, 255, ${layer.opacity * (0.4 + 0.6 * share)})`;
    context.beginPath();
    for (let i = 0; i < shown; i++) {
      const phase = particles[i * 4 + 3] + (2 * Math.PI * clock) / swayPeriod;
      const x = particles[i * 4] + sway * Math.sin(phase);
      const y = particles[i * 4 + 1];
      const side = size * particles[i * 4 + 2];
      context.rect(x - side / 2, y - side / 2, side, side);
    }
    context.fill();
  }

  return {
    setScene(intensities, newWidth, newHeight) {
      rain = Math.max(0, Math.min(100, intensities.rain || 0));
      snow = Math.max(0, Math.min(100, intensities.snow || 0));
      useRainSheet(rain > 0 ? (RAIN_SHEETS.find((sheet) => rain <= sheet.upTo) || RAIN_SHEETS[2]).url : null);
      if (newWidth !== width || newHeight !== height) {
        width = newWidth;
        height = newHeight;
        scale = height / REFERENCE_HEIGHT;
        canvas.width = width;
        canvas.height = height;
        makeLayers();
        drawnEmpty = true;
      }
    },

    active() {
      return rain > 0 || snow > 0;
    },

    frame(seconds) {
      clock += seconds;
      if (!this.active()) {
        // Cleared once, then left alone
        if (!drawnEmpty) context.clearRect(0, 0, width, height);
        drawnEmpty = true;
        return;
      }
      // Rain on its own is only drawn every RAIN_INTERVAL (and once loaded)
      const now = performance.now();
      if (snow === 0 && (!rainSheet || now - rainDrawn < RAIN_INTERVAL)) return;
      context.clearRect(0, 0, width, height);
      drawnEmpty = false;
      if (rainSheet) drawRain(now);
      if (snow === 0) return;
      for (const layer of layers) {
        const share = snow / 100;
        const shown = Math.round(layer.count * share);
        if (shown === 0) continue;
        // Moves the shown particles down, wrapping from the bottom to the
        // top, then draws them
        const { particles, speed } = layer;
        for (let i = 0; i < shown; i++) {
          let y = particles[i * 4 + 1] + speed * scale * particles[i * 4 + 2] * seconds;
          if (y > height) y -= height + 60 * scale;
          particles[i * 4 + 1] = y;
        }
        drawSnow(layer, shown, share);
      }
    },
  };
}
