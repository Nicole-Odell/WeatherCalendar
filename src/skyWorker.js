import { createSkyRenderer } from './skyRenderer.js';

/*
 * Draws the sky on a worker thread, so it never holds up the page: taps,
 * buttons and page updates are handled on the main thread while this works.
 * Messages from the page (see SkyCanvas.jsx):
 * - { type: 'init', canvases }: the page's canvases, handed over with
 *   transferControlToOffscreen
 * - { type: 'scene', props } and { type: 'cloudSpeed', speed }: as for
 *   createSkyRenderer's setScene and setCloudSpeed
 * It posts back the renderer's reports ({ textColor } and { status }).
 */
let renderer = null;

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    renderer = createSkyRenderer({
      canvases: data.canvases,
      createCanvas: () => new OffscreenCanvas(1, 1),
      report: (message) => self.postMessage(message),
    });
  } else if (data.type === 'scene') {
    renderer.setScene(data.props);
  } else if (data.type === 'cloudSpeed') {
    renderer.setCloudSpeed(data.speed);
  }
};
