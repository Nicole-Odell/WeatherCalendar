import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache');

// Returns the data saved as cache/<name>.json, or null if there is none
export async function readCache(name) {
  try {
    return JSON.parse(await fs.readFile(cachePath(name), 'utf8'));
  } catch {
    // No cache file yet, or it is unreadable
    return null;
  }
}

export async function writeCache(name, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath(name), JSON.stringify(data, null, 2));
}

function cachePath(name) {
  return path.join(CACHE_DIR, `${name}.json`);
}
