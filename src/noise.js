// 2D gradient (Perlin) noise from a fixed seed, so the same position always
// gives the same value and the clouds don't change between redraws

const PERMUTATION = buildPermutation(1);

function buildPermutation(seed) {
  const values = Array.from({ length: 256 }, (_, i) => i);
  let state = seed;
  for (let i = 255; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i++) table[i] = values[i & 255];
  return table;
}

// Noise at (x, y), from about -1 to 1, changing smoothly over a distance of about 1
function perlin(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = PERMUTATION[x0 & 255] + (y0 & 255);
  const b = PERMUTATION[(x0 & 255) + 1] + (y0 & 255);
  const u = fade(fx);
  const v = fade(fy);
  const bottom = lerp(gradient(PERMUTATION[a], fx, fy), gradient(PERMUTATION[b], fx - 1, fy), u);
  const top = lerp(
    gradient(PERMUTATION[a + 1], fx, fy - 1),
    gradient(PERMUTATION[b + 1], fx - 1, fy - 1),
    u,
  );
  return lerp(bottom, top, v);
}

function gradient(hash, x, y) {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return y - x;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Noise with detail at several scales (each octave half the size and strength
 * of the one before), from about 0 to 1 with most values near 0.5
 */
export function fractalNoise(x, y, octaves = 5) {
  let sum = 0;
  let strength = 1;
  let totalStrength = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum += strength * perlin(x * frequency, y * frequency);
    totalStrength += strength;
    strength /= 2;
    frequency *= 2;
  }
  return 0.5 + (0.5 * sum) / totalStrength;
}

// Sorted sample of fractalNoise values, to find what share of positions fall below a value
const SAMPLES = (() => {
  const samples = new Float64Array(4096);
  let state = 7;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = fractalNoise(random() * 256, random() * 256);
  }
  return samples.sort();
})();

/**
 * The fractalNoise value that the given fraction (0–1) of positions fall
 * below. Showing only noise above quantile(1 - c) covers a fraction c of the area.
 */
export function noiseQuantile(fraction) {
  const index = Math.round(Math.min(1, Math.max(0, fraction)) * (SAMPLES.length - 1));
  return SAMPLES[index];
}
