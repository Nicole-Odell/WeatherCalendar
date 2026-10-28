import { useEffect, useRef, useState } from 'react';
import { onSkyHold } from './skyHold.js';
import { createSkyRenderer } from './skyRenderer.js';
// Built as a classic worker script for Chromium 74 (see vite.config.js)
import SkyWorker from './skyWorker.js?worker';

/**
 * The sky, stars, clouds and haze, drawn behind the page (see skyRenderer.js).
 * Drawing happens on a worker thread where the browser can hand canvases to
 * one (OffscreenCanvas), so it never holds up taps or page updates; otherwise
 * on the page itself. Reports how drawing is going through onStatus. While
 * `paused`, the clouds stop moving (new scenes are still drawn). `cloudStep`
 * is how far the clouds move with each new sky, in screen pixels. Redraws
 * wait while the sky is held (see skyHold.js).
 */
export default function SkyCanvas({ onStatus, cloudStep, paused, fadeDuration, ...settings }) {
  const containerRef = useRef(null);
  const renderer = useRef(null);
  const callbacks = useRef(null);
  callbacks.current = { onStatus };
  const [windowSize, setWindowSize] = useState(currentWindowSize);

  useEffect(() => {
    const onResize = () => setWindowSize(currentWindowSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The canvases, created here (not by React) so each mount gets fresh ones:
  // a canvas can only be handed to a worker once
  useEffect(() => {
    const container = containerRef.current;
    const canvases = {};
    // Stacked in this order (see skyRenderer.js): the moon is placed by the
    // renderer's reports, the stars added over the sky, the rest stretched
    // over the whole screen
    for (const name of ['sky', 'stars', 'moon', 'clouds', 'haze', 'precipitation']) {
      canvases[name] = document.createElement('canvas');
      canvases[name].className = name === 'moon' ? 'sky-moon' : `sky-background sky-${name}`;
      container.appendChild(canvases[name]);
    }
    // Until the renderer says what they show, these have nothing to show
    for (const name of ['stars', 'moon', 'clouds', 'precipitation']) canvases[name].style.display = 'none';
    const report = ({ status, layers }) => {
      if (status) callbacks.current.onStatus?.(status);
      if (layers) showLayers(canvases, layers);
    };
    renderer.current = startRenderer(canvases, report);
    return () => {
      renderer.current.dispose();
      renderer.current = null;
      container.replaceChildren();
    };
  }, []);

  const {
    colors,
    sunlight,
    sunElevation,
    exposure,
    clouds,
    cloudBrightness,
    cloudLighting,
    cloudGlow,
    hazeContrast,
    moon,
    stars,
    precipitation,
  } = settings;
  const { total, low, mid, high, darkness } = clouds;
  useEffect(() => {
    renderer.current.setScene({
      settings: {
        colors,
        sunlight,
        sunElevation,
        exposure,
        clouds: { total, low, mid, high, darkness },
        cloudBrightness,
        cloudLighting,
        cloudGlow,
        hazeContrast,
        moon,
        stars,
        precipitation,
      },
      windowSize,
      fadeDuration,
    });
  }, [
    windowSize,
    colors,
    sunlight,
    sunElevation,
    exposure,
    total,
    low,
    mid,
    high,
    darkness,
    cloudBrightness,
    cloudLighting,
    cloudGlow,
    hazeContrast,
    moon,
    stars,
    precipitation,
    fadeDuration,
  ]);

  useEffect(() => {
    renderer.current.setCloudStep(cloudStep ?? 1);
  }, [cloudStep]);

  // Held while the page responds to a tap or animates (see skyHold.js):
  // held from when a hold starts until it ends, however it's extended
  useEffect(() => {
    let timer = 0;
    const release = () => {
      timer = 0;
      renderer.current?.setHeld(false);
    };
    const stop = onSkyHold((until) => {
      if (!timer) renderer.current.setHeld(true);
      clearTimeout(timer);
      timer = setTimeout(release, Math.max(0, until - performance.now()));
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);

  // Bedtime: cloud motion pauses while the screen is off
  useEffect(() => {
    renderer.current.setPaused(Boolean(paused));
  }, [paused]);

  return <div ref={containerRef} />;
}

/**
 * Starts drawing on `canvases`: on a worker thread if the browser can hand
 * canvases to one, otherwise on the page. Returns { setScene, setCloudStep,
 * setPaused, setHeld, dispose }; `report` gets the renderer's reports, with each status saying
 * which thread it's drawing on.
 */
function startRenderer(canvases, report) {
  // Adding ?clouds=cpu to the page's address draws the clouds on the CPU even
  // where WebGL is fast, for testing
  const forceCpuClouds = new URLSearchParams(window.location.search).get('clouds') === 'cpu';
  if (typeof Worker !== 'undefined' && 'transferControlToOffscreen' in canvases.sky) {
    try {
      const worker = new SkyWorker();
      const offscreen = {};
      for (const [name, canvas] of Object.entries(canvases)) {
        offscreen[name] = canvas.transferControlToOffscreen();
      }
      worker.postMessage({ type: 'init', canvases: offscreen, forceCpuClouds }, Object.values(offscreen));
      worker.onmessage = ({ data }) =>
        report(data.status ? { status: { ...data.status, thread: 'background thread' } } : data);
      worker.onerror = (event) => console.error('Sky worker failed:', event.message);
      return {
        setScene: (props) => worker.postMessage({ type: 'scene', props }),
        setCloudStep: (pixels) => worker.postMessage({ type: 'cloudStep', pixels }),
        setPaused: (paused) => worker.postMessage({ type: 'paused', paused }),
        setHeld: (held) => worker.postMessage({ type: 'held', held }),
        dispose: () => worker.terminate(),
      };
    } catch (error) {
      console.warn('Drawing the sky on the page, as a worker thread is not available:', error);
    }
  }
  return createSkyRenderer({
    canvases,
    createCanvas: () => document.createElement('canvas'),
    forceCpuClouds,
    report: (message) =>
      report(message.status ? { status: { ...message.status, thread: 'page thread' } } : message),
  });
}

// Shows the canvases the renderer reports on: hidden while they've nothing
// to show, or the clouds' canvas shows them (so they aren't composited), and
// the moon placed and sized (in CSS pixels) where it's drawn
function showLayers(canvases, { sky, haze, stars, clouds, precipitation, moon }) {
  canvases.sky.style.display = sky ? '' : 'none';
  canvases.haze.style.display = haze ? '' : 'none';
  canvases.stars.style.display = stars ? '' : 'none';
  canvases.clouds.style.display = clouds ? '' : 'none';
  canvases.precipitation.style.display = precipitation ? '' : 'none';
  if (!moon) {
    canvases.moon.style.display = 'none';
    return;
  }
  Object.assign(canvases.moon.style, {
    display: '',
    transform: `translate(${moon.left}px, ${moon.top}px)`,
    width: `${moon.size}px`,
    height: `${moon.size}px`,
  });
}

function currentWindowSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio || 1,
  };
}
