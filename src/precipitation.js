/*
 * Rain and snow, drawn as moving particles on one canvas over the sky (see
 * skyRenderer.js). Each frame clears the canvas and draws every particle of a
 * layer in one path with one stroke or fill, so the work is a handful of
 * drawing calls however many particles there are. Particles move by real
 * time passed, so motion stays steady if a frame is late.
 *
 * Layers, far to near, give depth: nearer particles are bigger, faster and
 * more opaque. Intensity (0–100) sets how many of each layer's particles show
 * and how opaque they are.
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

/*
 * Rain: streaks `length` px long and `width` px wide, falling at `speed`
 * px/s and leaning `slant` px across per px down
 */
const RAIN_LAYERS = [
  { count: 220, length: 22, width: 1, speed: 900, slant: 0.08, opacity: 0.35 },
  { count: 120, length: 36, width: 1.5, speed: 1300, slant: 0.08, opacity: 0.45 },
  { count: 50, length: 56, width: 2, speed: 1800, slant: 0.08, opacity: 0.55 },
];
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
 * the intensities (0–100) and the canvas's size, and frame(seconds) moves the
 * particles on by that much time and draws them. `active()` says whether
 * there's anything to draw.
 */
export function createPrecipitation(canvas) {
  const context = canvas.getContext('2d');
  let rain = 0;
  let snow = 0;
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
    layers = [
      ...RAIN_LAYERS.map((layer) => ({ ...layer, kind: 'rain' })),
      ...SNOW_LAYERS.map((layer) => ({ ...layer, kind: 'snow' })),
    ].map((layer) => {
      const count = Math.max(1, Math.round(layer.count * area));
      return { ...layer, count, particles: createParticles(count, width, height) };
    });
  }

  function drawRain(layer, shown, share) {
    const { particles, slant } = layer;
    const length = layer.length * scale;
    context.strokeStyle = `rgba(220, 230, 245, ${layer.opacity * (0.4 + 0.6 * share)})`;
    context.lineWidth = layer.width * scale;
    context.beginPath();
    for (let i = 0; i < shown; i++) {
      const x = particles[i * 4];
      const y = particles[i * 4 + 1];
      const streak = length * particles[i * 4 + 2];
      context.moveTo(x, y);
      context.lineTo(x - slant * streak, y + streak);
    }
    context.stroke();
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
      context.clearRect(0, 0, width, height);
      drawnEmpty = false;
      context.lineCap = 'round';
      for (const layer of layers) {
        const share = (layer.kind === 'rain' ? rain : snow) / 100;
        const shown = Math.round(layer.count * share);
        if (shown === 0) continue;
        // Moves the shown particles down, wrapping from the bottom to the top
        // (and across, for the rain's lean), then draws them
        const { particles, speed } = layer;
        const lean = layer.kind === 'rain' ? layer.slant : 0;
        for (let i = 0; i < shown; i++) {
          const fall = speed * scale * particles[i * 4 + 2] * seconds;
          let y = particles[i * 4 + 1] + fall;
          let x = particles[i * 4] - lean * fall;
          if (y > height) y -= height + 60 * scale;
          if (x < -60 * scale) x += width + 120 * scale;
          particles[i * 4] = x;
          particles[i * 4 + 1] = y;
        }
        if (layer.kind === 'rain') drawRain(layer, shown, share);
        else drawSnow(layer, shown, share);
      }
    },
  };
}
