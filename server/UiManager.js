import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Display settings kept on the server, so every screen and every reload
 * shows the same: the UI flavor (how controls, panels and the calendar look,
 * see src/flavors/) and the wake-up time (HH:MM, for the sleep estimate under
 * the sleep task). Kept in config/ui.json.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'ui.json');
export const FLAVORS = ['glass', 'default'];
const DEFAULT_SETTINGS = { flavor: 'glass', wakeTime: '07:00' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns the display settings, as { flavor, wakeTime } */
export async function GetSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...(FLAVORS.includes(saved.flavor) ? { flavor: saved.flavor } : {}),
      ...(TIME.test(saved.wakeTime || '') ? { wakeTime: saved.wakeTime } : {}),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('config/ui.json is unreadable, so using the default settings:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Changes the settings given (`flavor`: one of FLAVORS; `wakeTime`: HH:MM),
 * returning the settings as GetSettings does
 */
export async function SetSettings({ flavor, wakeTime }) {
  if (flavor !== undefined && !FLAVORS.includes(flavor)) throw new Error(`Unknown UI flavor: ${flavor}`);
  if (wakeTime !== undefined && !TIME.test(wakeTime)) throw new Error(`Not a time (HH:MM): ${wakeTime}`);
  const settings = {
    ...(await GetSettings()),
    ...(flavor !== undefined ? { flavor } : {}),
    ...(wakeTime !== undefined ? { wakeTime } : {}),
  };
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
