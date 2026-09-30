import { parentPort } from 'node:worker_threads';
import { SKY_MODELS } from './skyModels.js';

/*
 * Builds a sky model's atmosphere tables on its own thread, so the server
 * keeps answering requests (with the previous tables) while it works.
 * Receives { id, model, conditions }; replies { id, atmosphere } or { id, error }.
 */
parentPort.on('message', ({ id, model, conditions }) => {
  try {
    const atmosphere = SKY_MODELS[model].createAtmosphere(conditions);
    // Hand the tables' memory over instead of copying it
    const buffers = Object.values(atmosphere)
      .filter((value) => ArrayBuffer.isView(value))
      .map((value) => value.buffer);
    parentPort.postMessage({ id, atmosphere }, buffers);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
