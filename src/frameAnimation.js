import { holdSky } from './skyHold.js';

/*
 * Animations run from requestAnimationFrame, setting the transform and
 * opacity of elements on their own layer (will-change: transform), rather
 * than as CSS animations. On Chromium 74, while a CSS transform animation
 * runs, everything painted after it is given its own layer ("assumed
 * overlap"): on the Pi 3 that repaints much of the page as it starts and
 * ends, and makes every redraw meanwhile twice as slow. The sky is held
 * while they run (see skyHold.js), so they get the screen to themselves.
 */

/** A CSS cubic-bezier() timing function, as a function of progress (0–1) */
export function cubicBezier(x1, y1, x2, y2) {
  const along = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // The curve's t for this x, by halving (x only grows with t)
    let low = 0;
    let high = 1;
    for (let i = 0; i < 20; i++) {
      const t = (low + high) / 2;
      if (along(x1, x2, t) < x) low = t;
      else high = t;
    }
    return along(y1, y2, (low + high) / 2);
  };
}

export const EASE_OUT = cubicBezier(0, 0, 0.58, 1);

/**
 * A value through keyframes, as CSS animates one: `stops` are [at, value]
 * pairs (at from 0 to 1, in order), with `easing` applied between each pair
 */
export function keyframes(stops, easing) {
  return (progress) => {
    let i = 0;
    while (i < stops.length - 2 && progress > stops[i + 1][0]) i++;
    const [fromAt, from] = stops[i];
    const [toAt, to] = stops[i + 1];
    const local = toAt > fromAt ? Math.min(1, Math.max(0, (progress - fromAt) / (toAt - fromAt))) : 1;
    return from + (to - from) * easing(local);
  };
}

// The most an animation moves on between frames (ms): when the Pi 3 is slow
// to draw a frame (as when what was tapped is repainted, just as it starts),
// the animation slows down rather than skipping ahead past what wasn't seen
const MOST_PER_FRAME = 50;

/**
 * Calls `frame(progress)` (0–1) each animation frame for `duration` ms of
 * animation time, ending with 1, then `done()`: its time starts with its
 * first frame, and moves on at most MOST_PER_FRAME a frame. The sky is held
 * meanwhile. Returns a function that stops it (without calling `done`).
 */
export function animate(duration, frame, done) {
  holdSky(duration);
  let elapsed = -1;
  let last = 0;
  let id = 0;
  const tick = (now) => {
    elapsed = elapsed < 0 ? 0 : elapsed + Math.min(MOST_PER_FRAME, Math.max(0, now - last));
    last = now;
    // (held for the rest of it, however long it now takes)
    holdSky(duration - elapsed + MOST_PER_FRAME);
    const progress = Math.min(1, elapsed / duration);
    frame(progress);
    if (progress < 1) id = requestAnimationFrame(tick);
    else if (done) done();
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}
