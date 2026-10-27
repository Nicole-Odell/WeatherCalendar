import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCache, writeCache } from './cache.js';
import { SunriseOn } from './TimeOfDayManager.js';

/*
 * The daily tasks shown under "Today", kept by day in cache/tasks.json so
 * they survive restarts and show the same on every screen. Days run from
 * sunrise to sunrise (so a task done at 2 am counts for the day before), and
 * are named by their date (YYYY-MM-DD). Each day is { completedTasks, focus }:
 * the tasks with any progress that day, and how much (1 when done; water
 * counts a glass at a time, to 2), and the day's focus (one of the options
 * in config/dailyFocus.json, see GetFocusOptions), if one was chosen (each
 * cleared on its own from Settings, see ResetTasks and ResetFocus). Every
 * day with any progress or focus is kept. (TaskRange is the days the page's
 * calendar can be moved between.)
 */
const CACHE_NAME = 'tasks';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The daily focus's options, as { "options": ["💼 Work", ...] }; these if
// it's missing
const FOCUS_FILE = path.join(__dirname, '..', 'config', 'dailyFocus.json');
const DEFAULT_FOCUS_OPTIONS = ['💼 Work', '😊 Mental Health'];
// The tasks, and how many times a day each is done (water is two glasses)
export const TASKS = { sleep: 1, leave: 1, office: 1, water: 2, work: 1, stretch: 1 };

// A date as YYYY-MM-DD on this computer's clock
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// The day (YYYY-MM-DD) a moment counts for: its date, or the day before if
// it's before that date's sunrise
function taskDay(moment) {
  const date = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), 12);
  if (moment < SunriseOn(date)) date.setDate(date.getDate() - 1);
  return localDate(date);
}

/**
 * The days the page's calendar can be moved between, around today
 * (YYYY-MM-DD, by taskDay): from the Monday of last week to the Sunday of
 * next week, as { start, end }
 */
export function TaskRange(today = taskDay(new Date())) {
  const [year, month, day] = today.split('-').map(Number);
  const monday = new Date(year, month - 1, day, 12);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const start = new Date(monday);
  start.setDate(start.getDate() - 7);
  const end = new Date(monday);
  end.setDate(end.getDate() + 13);
  return { start: localDate(start), end: localDate(end) };
}

// Each day kept, as { date: { completedTasks: { task: progress } } }, read
// from the cache (converting the old form, a list of times each task was
// done, into days)
async function readDays() {
  const cached = await readCache(CACHE_NAME);
  let days = {};
  if (cached && cached.days) {
    days = cached.days;
  } else if (cached) {
    for (const task of Object.keys(TASKS)) {
      for (const time of Array.isArray(cached[task]) ? cached[task] : []) {
        const day = taskDay(new Date(time));
        const completed = (days[day] = days[day] || { completedTasks: {} }).completedTasks;
        completed[task] = Math.min(TASKS[task], (completed[task] || 0) + 1);
      }
    }
  }
  return days;
}

/**
 * Returns the tasks as { today, range: { start, end }, days }: today's date
 * (by taskDay), the days the page can show (see TaskRange), and every day
 * with any progress, as { date: { completedTasks: { task: progress } } }
 */
export async function GetTasks() {
  const today = taskDay(new Date());
  return { today, range: TaskRange(today), days: await readDays() };
}

/** Returns the daily focus's options (see FOCUS_FILE), as { options } */
export async function GetFocusOptions() {
  try {
    const { options } = JSON.parse(await fs.readFile(FOCUS_FILE, 'utf8'));
    if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
      throw new Error('"options" must be a list of text');
    }
    return { options };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('config/dailyFocus.json is unreadable, so using the default options:', error.message);
    return { options: DEFAULT_FOCUS_OPTIONS };
  }
}

/**
 * Sets the focus of the day `date` (YYYY-MM-DD) to `focus`, one of the
 * options (see GetFocusOptions). Returns the tasks as GetTasks does.
 */
export async function SetFocus(focus, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`Not a date: ${date}`);
  const { options } = await GetFocusOptions();
  if (!options.includes(focus)) throw new Error(`Not a focus option: ${focus}`);
  const days = await readDays();
  days[date] = { completedTasks: {}, ...days[date], focus };
  await writeCache(CACHE_NAME, { days });
  return { today: taskDay(new Date()), range: TaskRange(), days };
}

/**
 * Records a step of `task` on the day `date` (YYYY-MM-DD), unless it's
 * already been done its number of times that day. Returns the tasks as
 * GetTasks does.
 */
export async function DoTask(task, date) {
  if (!(task in TASKS)) throw new Error(`Unknown task: ${task}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`Not a date: ${date}`);
  const range = TaskRange();
  const days = await readDays();
  days[date] = { ...days[date], completedTasks: (days[date] && days[date].completedTasks) || {} };
  const completed = days[date].completedTasks;
  if ((completed[task] || 0) < TASKS[task]) {
    completed[task] = (completed[task] || 0) + 1;
    await writeCache(CACHE_NAME, { days });
  }
  return { today: taskDay(new Date()), range, days };
}

/** Clears every task on the day `date` (YYYY-MM-DD), keeping its focus. Returns the tasks as GetTasks does. */
export async function ResetTasks(date) {
  const days = await readDays();
  if (days[date] && days[date].focus) days[date] = { completedTasks: {}, focus: days[date].focus };
  else delete days[date];
  await writeCache(CACHE_NAME, { days });
  return { today: taskDay(new Date()), range: TaskRange(), days };
}

/** Clears the focus of the day `date` (YYYY-MM-DD). Returns the tasks as GetTasks does. */
export async function ResetFocus(date) {
  const days = await readDays();
  if (days[date]) {
    const { focus, ...rest } = days[date];
    if (Object.keys(rest.completedTasks || {}).length > 0) days[date] = rest;
    else delete days[date];
  }
  await writeCache(CACHE_NAME, { days });
  return { today: taskDay(new Date()), range: TaskRange(), days };
}
