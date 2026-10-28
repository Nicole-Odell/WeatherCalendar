/*
 * Holding the sky's redraws while the page responds to a tap or runs an
 * animation. On the Pi 3 each redraw of the sky is a full-screen redraw
 * (~135 ms), which the page's own changes would otherwise wait behind; held,
 * the sky skips redrawing (its updates wait, see skyRenderer.js) and the page
 * gets the screen to itself. A hold only ever lasts HOLD_LONGEST at a time,
 * so a long run of taps or animation can't stop the sky altogether.
 */

// How long the sky waits after a tap (ms): enough for the page to draw what
// the tap changed
export const HOLD_AFTER_TAP = 1500;
// The longest the sky is held in one go (ms)
const HOLD_LONGEST = 4000;
// After a hold that ran the full HOLD_LONGEST, how long until a new one can
// start (ms), so the sky gets to redraw between them
const HOLD_GAP = 1000;

// When the current hold ends and started (performance.now() ms), and who's
// told when it changes
let until = 0;
let since = -Infinity;
let capped = false;
const listeners = new Set();

/** Holds the sky's redraws for the next `ms` (within HOLD_LONGEST) */
export function holdSky(ms) {
  const now = performance.now();
  if (now >= until) {
    // A new hold, unless the last ran its longest and only just ended
    if (capped && now < until + HOLD_GAP) return;
    since = now;
  }
  const next = Math.min(now + ms, since + HOLD_LONGEST);
  if (next <= until) return;
  until = next;
  capped = until >= since + HOLD_LONGEST;
  listeners.forEach((listener) => listener(until));
}

/**
 * Calls `listener(until)` with the time (performance.now() ms) the hold now
 * ends, whenever one starts or is extended; returns a function to stop
 */
export function onSkyHold(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
