import { useEffect, useRef, useState } from 'react';
import { createSkyRenderer } from './skyRenderer.js';
// Built as a classic worker script for Chromium 74 (see vite.config.js)
import SkyWorker from './skyWorker.js?worker';

/**
 * The sky, stars, clouds and haze, drawn behind the page (see skyRenderer.js).
 * Drawing happens on a worker thread where the browser can hand canvases to
 * one (OffscreenCanvas), so it never holds up taps or page updates; otherwise
 * on the page itself. Reports how drawing is going through onStatus.
 */
export default function SkyCanvas({ onStatus, cloudSpeed, fadeDuration, ...settings }) {
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
    for (const name of ['background', 'clouds', 'haze']) {
      canvases[name] = document.createElement('canvas');
      canvases[name].className = 'sky-background';
      container.appendChild(canvases[name]);
    }
    const report = ({ status }) => {
      if (status) callbacks.current.onStatus?.(status);
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
  } = settings;
  const { total, low, mid, high } = clouds;
  useEffect(() => {
    renderer.current.setScene({
      settings: {
        colors,
        sunlight,
        sunElevation,
        exposure,
        clouds: { total, low, mid, high },
        cloudBrightness,
        cloudLighting,
        cloudGlow,
        hazeContrast,
        moon,
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
    cloudBrightness,
    cloudLighting,
    cloudGlow,
    hazeContrast,
    moon,
    fadeDuration,
  ]);

  useEffect(() => {
    renderer.current.setCloudSpeed(cloudSpeed ?? 1);
  }, [cloudSpeed]);

  return <div ref={containerRef} />;
}

/**
 * Starts drawing on `canvases`: on a worker thread if the browser can hand
 * canvases to one, otherwise on the page. Returns { setScene, setCloudSpeed,
 * dispose }; `report` gets the renderer's reports, with each status saying
 * which thread it's drawing on.
 */
function startRenderer(canvases, report) {
  // Adding ?clouds=cpu to the page's address draws the clouds on the CPU even
  // where WebGL is fast, for testing
  const forceCpuClouds = new URLSearchParams(window.location.search).get('clouds') === 'cpu';
  if (typeof Worker !== 'undefined' && 'transferControlToOffscreen' in canvases.background) {
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
        setCloudSpeed: (speed) => worker.postMessage({ type: 'cloudSpeed', speed }),
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

function currentWindowSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio || 1,
  };
}
