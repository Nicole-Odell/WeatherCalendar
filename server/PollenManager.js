import { readCache, writeCache } from './cache.js';
import { ZIP_CODE } from './location.js';

const CACHE_NAME = 'pollen';
// Pollen.com updates its forecast once a day; checking hourly picks up the
// new one soon after
const CACHE_DURATION_MS = 60 * 60 * 1000;
const POLLEN_URL = `https://www.pollen.com/api/forecast/current/pollen/${ZIP_CODE}`;
// Pollen.com only answers requests that look like they come from its own
// pages. Its API is unofficial, so it could change without notice.
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: `https://www.pollen.com/forecast/current/pollen/${ZIP_CODE}`,
  Accept: 'application/json',
};

// Pollen.com's overall index (0–12) as a level from 0 (none) to 4 (very
// high), by pollen.com's own bands: Low (up to 2.4) and Low-Medium (up to
// 4.8) are 1, Medium (up to 7.2) is 2, Medium-High (up to 9.6) is 3, and
// High is 4
const LEVELS = [
  { upTo: 0, level: 0 },
  { upTo: 4.8, level: 1 },
  { upTo: 7.2, level: 2 },
  { upTo: 9.6, level: 3 },
  { upTo: Infinity, level: 4 },
];

// Pollen.com's plant types, by the category they count toward (it calls weeds
// "Ragweed")
const CATEGORIES = { Grass: 'grass', Tree: 'tree', Ragweed: 'weed', Weed: 'weed' };

/**
 * Returns today's pollen from pollen.com as { fetchedAt, index, levels,
 * allergens }: `index` is pollen.com's overall index (0–12), `levels` is
 * { grass, tree, weed }, each 0 (none) to 4 (very high), and `allergens` are
 * today's top allergens as [{ name, plantType }]. Pollen.com gives one
 * overall level, so each category whose plants are among the top allergens
 * gets that level, and the others get 0. Data comes from the cache unless it
 * is over an hour old; if pollen.com can't be reached, older data is used.
 */
export async function GetPollen() {
  const cached = await readCache(CACHE_NAME);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_DURATION_MS) {
    return cached;
  }
  try {
    const pollen = await fetchPollen();
    await writeCache(CACHE_NAME, pollen);
    return pollen;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function fetchPollen() {
  const response = await fetch(POLLEN_URL, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`pollen.com request failed (${response.status})`);
  }
  const body = await response.json();
  const today = body.Location?.periods?.find((period) => period.Type === 'Today');
  if (!today) {
    throw new Error('pollen.com gave no forecast for today');
  }
  const level = LEVELS.find(({ upTo }) => today.Index <= upTo).level;
  const levels = { grass: 0, tree: 0, weed: 0 };
  for (const { PlantType } of today.Triggers ?? []) {
    const category = CATEGORIES[PlantType];
    if (category) levels[category] = level;
  }
  return {
    fetchedAt: new Date().toISOString(),
    index: today.Index,
    levels,
    allergens: (today.Triggers ?? []).map(({ Name, PlantType }) => ({ name: Name, plantType: PlantType })),
  };
}
