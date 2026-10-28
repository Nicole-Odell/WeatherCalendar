import { createSkyRenderer } from './skyRenderer.js';

/*
 * Draws the sky on a worker thread, so it never holds up the page: taps,
 * buttons and page updates are handled on the main thread while this works.
 * Messages from the page (see SkyCanvas.jsx):
 * - { type: 'init', canvases, forceCpuClouds }: the page's canvases, handed
 *   over with transferControlToOffscreen, and createSkyRenderer's option
 * - { type: 'scene', props }, { type: 'cloudStep', pixels },
 *   { type: 'paused', paused } and { type: 'held', held }: as for
 *   createSkyRenderer's setScene, setCloudStep, setPaused and setHeld
 * It posts back the renderer's reports ({ status }).
 */
let renderer = null;

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    renderer = createSkyRenderer({
      canvases: data.canvases,
      forceCpuClouds: data.forceCpuClouds,
      createCanvas: () => new OffscreenCanvas(1, 1),
      report: (message) => self.postMessage(message),
    });
  } else if (data.type === 'scene') {
    renderer.setScene(data.props);
  } else if (data.type === 'cloudStep') {
    renderer.setCloudStep(data.pixels);
  } else if (data.type === 'paused') {
    renderer.setPaused(data.paused);
  } else if (data.type === 'held') {
    renderer.setHeld(data.held);
  }
};
