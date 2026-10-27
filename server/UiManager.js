import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Display settings kept on the server, so every screen and every reload
 * shows the same: the UI flavor (how controls, panels and the calendar look,
 * see src/flavors/) and the wake-up time (HH:MM, for the sleep estimate under
 * the sleep task), and whether rain and snow are shown from the weather
 * (`showRain`, `showSnow`). Kept in config/ui.json.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'ui.json');
export const FLAVORS = ['glass', 'default'];
const DEFAULT_SETTINGS = { flavor: 'glass', wakeTime: '07:00', showRain: true, showSnow: true };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns the display settings, as { flavor, wakeTime, showRain, showSnow } */
export async function GetSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...(FLAVORS.includes(saved.flavor) ? { flavor: saved.flavor } : {}),
      ...(TIME.test(saved.wakeTime || '') ? { wakeTime: saved.wakeTime } : {}),
      ...(typeof saved.showRain === 'boolean' ? { showRain: saved.showRain } : {}),
      ...(typeof saved.showSnow === 'boolean' ? { showSnow: saved.showSnow } : {}),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('config/ui.json is unreadable, so using the default settings:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Changes the settings given (`flavor`: one of FLAVORS; `wakeTime`: HH:MM;
 * `showRain`, `showSnow`: booleans), returning the settings as GetSettings
 * does
 */
export async function SetSettings({ flavor, wakeTime, showRain, showSnow }) {
  if (flavor !== undefined && !FLAVORS.includes(flavor)) throw new Error(`Unknown UI flavor: ${flavor}`);
  if (wakeTime !== undefined && !TIME.test(wakeTime)) throw new Error(`Not a time (HH:MM): ${wakeTime}`);
  for (const [name, value] of Object.entries({ showRain, showSnow })) {
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  }
  const settings = {
    ...(await GetSettings()),
    ...(flavor !== undefined ? { flavor } : {}),
    ...(wakeTime !== undefined ? { wakeTime } : {}),
    ...(showRain !== undefined ? { showRain } : {}),
    ...(showSnow !== undefined ? { showSnow } : {}),
  };
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
