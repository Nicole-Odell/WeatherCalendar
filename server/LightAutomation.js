import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LightsManager from './LightsManager.js';
import * as TimeOfDayManager from './TimeOfDayManager.js';
import * as UiManager from './UiManager.js';

/*
 * Lighting automations, set in the lighting panel and run here, so they
 * carry on whether or not a screen is showing. Kept, with what last ran, in
 * config/lightlineAutomation.json.
 *
 * Each automation is { id, condition, timeKind, time, offset, brightness,
 * powered, fade }: at its time (a clock time, HH:MM, or `offset` minutes
 * from a sun event or the wake-up time set in Settings, an hour earlier on
 * office days, as the sleep estimate under the sleep task), if its condition holds (always, or only when the lights
 * are off, or only when on), the lights are set to its brightness (0–100)
 * and power. Checked every second (see Tick).
 *
 * What last ran is kept as `lastRun`: { id, at, applied, brightness } for the
 * automation whose time came most recently (each one replaces it; with only
 * one automation, it's cleared straight away). If it applied and has `fade`
 * set, the brightness then moves evenly from its brightness to the next
 * automation's, in time order, until that one's time. Setting the brightness
 * by hand clears it, so a fade stops and the lights are left as set; so does
 * the brightness being found changed from what the fade last set (by anyone,
 * here or elsewhere), checked before each step.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'config', 'lightlineAutomation.json');

// How close to an automation's time it runs (ms either side)
const RUN_WINDOW = 10 * 1000;
const CONDITIONS = ['always', 'whenOff', 'whenOn'];
const TIME_KINDS = ['time', 'sunset', 'sunrise', 'astroDusk', 'astroDawn', 'wakeUp'];
// The days (0 is Sunday) the wake-up time is OFFICE_EARLIER_MINUTES earlier,
// as the page's (OFFICE_DAYS and OFFICE_EARLIER_MINUTES in src/App.jsx)
const OFFICE_DAYS = [2, 3, 4];
const OFFICE_EARLIER_MINUTES = 60;
// How far the lights' brightness (0–1) can be from what a fade last set
// before it counts as changed by someone else
const FADE_CHANGED_BY = 0.005;

let state = null;
// The occurrences already handled (`${id}@${time}`), so each runs once in
// its window; and the last brightness a fade sent
const handled = new Set();
let lastFadeSent = null;

async function load() {
  if (state) return state;
  try {
    const saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
    state = { automations: (saved.automations || []).map(clean).filter(Boolean), lastRun: saved.lastRun || null };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('config/lightlineAutomation.json is unreadable:', error.message);
    state = { automations: [], lastRun: null };
  }
  return state;
}

async function save() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// An automation with only known fields and values, or null if it isn't one
function clean(automation) {
  if (!automation || typeof automation.id !== 'string') return null;
  const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
  return {
    id: automation.id,
    condition: CONDITIONS.includes(automation.condition) ? automation.condition : 'always',
    timeKind: TIME_KINDS.includes(automation.timeKind) ? automation.timeKind : 'time',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(automation.time || '') ? automation.time : '20:00',
    offset: number(automation.offset, 0, -720, 720),
    brightness: number(automation.brightness, 100, 0, 100),
    powered: Boolean(automation.powered),
    fade: Boolean(automation.fade),
  };
}

/** Returns the automations and what last ran, as { automations, lastRun } */
export async function GetAutomations() {
  return load();
}

/** Replaces the automations (as the panel shows them), returning them as GetAutomations does */
export async function SetAutomations(automations) {
  await load();
  state.automations = (Array.isArray(automations) ? automations : []).map(clean).filter(Boolean);
  // What last ran no longer counts if that automation's gone
  if (state.lastRun && !state.automations.some((a) => a.id === state.lastRun.id)) state.lastRun = null;
  await save();
  return state;
}

/**
 * The brightness was set by hand (or found changed during a fade): any fade
 * stops, and what last ran is forgotten
 */
export async function BrightnessSetByHand() {
  await load();
  lastFadeSent = null;
  if (!state.lastRun) return;
  state.lastRun = null;
  await save();
}

// A date's YYYY-MM-DD on this computer's clock
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// An automation's time on the day `day` (a Date at that day's noon), as ms,
// or null if there's no such time (a sun event the sun times don't have);
// `wakeTime` is the wake-up time set in Settings (HH:MM)
function timeOn(automation, day, sunEvents, wakeTime) {
  if (automation.timeKind === 'time') {
    const [hours, minutes] = automation.time.split(':').map(Number);
    const at = new Date(day);
    at.setHours(hours, minutes, 0, 0);
    return at.getTime();
  }
  if (automation.timeKind === 'wakeUp') {
    const [hours, minutes] = wakeTime.split(':').map(Number);
    const at = new Date(day);
    at.setHours(hours, minutes, 0, 0);
    const earlier = OFFICE_DAYS.includes(day.getDay()) ? OFFICE_EARLIER_MINUTES : 0;
    return at.getTime() + (automation.offset - earlier) * 60 * 1000;
  }
  const type = automation.timeKind === 'sunrise' || automation.timeKind === 'astroDawn' ? 'sunrise' : 'sunset';
  const event = sunEvents.find((e) => e.type === type && localDate(new Date(e.time)) === localDate(day));
  if (!event) return null;
  const base = automation.timeKind === 'astroDusk' || automation.timeKind === 'astroDawn' ? event.twilight : event.time;
  if (!base) return null;
  return Date.parse(base) + automation.offset * 60 * 1000;
}

// Every time each automation comes, yesterday to tomorrow, as
// [{ automation, at }], in order
function occurrences(automations, sunEvents, wakeTime, now) {
  const list = [];
  for (const offset of [-1, 0, 1]) {
    const day = new Date(now);
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    for (const automation of automations) {
      const at = timeOn(automation, day, sunEvents, wakeTime);
      if (at !== null) list.push({ automation, at });
    }
  }
  return list.sort((a, b) => a.at - b.at);
}

// Whether the lights' power is as an automation's condition needs
async function conditionHolds(condition) {
  if (condition === 'always') return true;
  const { powered } = await LightsManager.GetPower();
  return condition === 'whenOn' ? powered : !powered;
}

/**
 * Runs the automations (every second): any whose time has come (within
 * RUN_WINDOW) runs if its condition holds, and a fade from the last one that
 * ran moves the brightness on
 */
export async function Tick() {
  await load();
  const { automations } = state;
  if (automations.length === 0) return;
  const now = Date.now();
  let sunEvents = [];
  try {
    sunEvents = (await TimeOfDayManager.GetSunTimes()).events || [];
  } catch (error) {
    // (clock-time automations still run)
  }
  const { wakeTime } = await UiManager.GetSettings();
  const all = occurrences(automations, sunEvents, wakeTime, now);

  for (const { automation, at } of all) {
    const key = `${automation.id}@${at}`;
    if (Math.abs(now - at) > RUN_WINDOW || handled.has(key)) continue;
    handled.add(key);
    let applied = false;
    let set = null;
    try {
      if (await conditionHolds(automation.condition)) {
        set = await LightsManager.SetBrightness(automation.brightness / 100);
        await LightsManager.SetPower(automation.powered);
        applied = true;
      }
    } catch (error) {
      console.error('A lighting automation could not run:', error.message);
    }
    // (with only one automation, nothing can follow it, so it's forgotten)
    state.lastRun = automations.length > 1 ? { id: automation.id, at, applied, brightness: automation.brightness } : null;
    // (the brightness just set, so a fade from it starts from there)
    lastFadeSent = applied ? brightnessSet(set, automation.brightness / 100) : null;
    await save();
  }
  // Forget occurrences long past
  for (const key of handled) if (Number(key.split('@').pop()) < now - 2 * 24 * 3600 * 1000) handled.delete(key);

  await fade(all, now);
}

// The brightness LightLine says it set (its answer `set`), or `sent` if it
// doesn't say, to compare with later
const brightnessSet = (set, sent) => (set && Number.isFinite(set.brightness) ? set.brightness : sent);

// Moves the brightness on, evenly from the last automation that ran (if it
// applied and fades) to the next one's, by how far between their times now is
async function fade(all, now) {
  const { lastRun, automations } = state;
  if (!lastRun || !lastRun.applied || automations.length < 2) return;
  const from = automations.find((a) => a.id === lastRun.id);
  if (!from || !from.fade) return;
  const next = all.find(({ at }) => at > lastRun.at + RUN_WINDOW);
  if (!next || now >= next.at) return;
  const share = Math.min(1, Math.max(0, (now - lastRun.at) / (next.at - lastRun.at)));
  const brightness = (lastRun.brightness + (next.automation.brightness - lastRun.brightness) * share) / 100;
  // (only sent when it's moved enough to matter)
  if (lastFadeSent !== null && Math.abs(brightness - lastFadeSent) < 0.001) return;
  try {
    // If the brightness isn't what the fade last set, someone changed it, so
    // the fade stops there, as when it's set by hand here
    if (lastFadeSent !== null) {
      const current = (await LightsManager.GetBrightness()).brightness;
      if (Math.abs(current - lastFadeSent) > FADE_CHANGED_BY) {
        console.log(`A lighting fade stopped: the brightness was changed to ${current}`);
        await BrightnessSetByHand();
        return;
      }
    }
    lastFadeSent = brightnessSet(await LightsManager.SetBrightness(brightness), brightness);
  } catch (error) {
    console.error('A lighting fade could not go on:', error.message);
  }
}
