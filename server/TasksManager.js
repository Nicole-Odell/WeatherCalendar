import { readCache, writeCache } from './cache.js';

/*
 * The daily tasks shown under "Today": when each was done, kept in
 * cache/tasks.json so they survive restarts and show the same on every
 * screen. The page counts a task as done today if it was done since the last
 * sunrise, so they reset at sunrise without the server doing anything.
 */
const CACHE_NAME = 'tasks';
// The tasks, and how many times a day each is done (water is two glasses)
export const TASKS = { sleep: 1, leave: 1, water: 2, work: 1, stretch: 1 };
// Times older than this are dropped, as they no longer count (ms)
const KEEP_FOR = 3 * 24 * 60 * 60 * 1000;

// When each task was done, as { task: [ISO 8601 times] }
async function readTasks() {
  const cached = await readCache(CACHE_NAME);
  const tasks = {};
  for (const task of Object.keys(TASKS)) {
    const times = Array.isArray(cached?.[task]) ? cached[task] : [];
    tasks[task] = times.filter((time) => Date.now() - Date.parse(time) < KEEP_FOR);
  }
  return tasks;
}

/** Returns when each task was done, as { tasks: { task: [ISO 8601 times] } } */
export async function GetTasks() {
  return { tasks: await readTasks() };
}

/**
 * Records `task` as done now, unless it's been done its number of times
 * since `since` (an ISO 8601 time, the last sunrise). Returns the tasks as
 * GetTasks does.
 */
export async function DoTask(task, since) {
  if (!(task in TASKS)) throw new Error(`Unknown task: ${task}`);
  const tasks = await readTasks();
  const start = Date.parse(since) || 0;
  const doneSince = tasks[task].filter((time) => Date.parse(time) > start).length;
  if (doneSince < TASKS[task]) {
    tasks[task].push(new Date().toISOString());
    await writeCache(CACHE_NAME, tasks);
  }
  return { tasks };
}

/** Clears every task, so none are done. Returns the tasks as GetTasks does. */
export async function ResetTasks() {
  const tasks = Object.fromEntries(Object.keys(TASKS).map((task) => [task, []]));
  await writeCache(CACHE_NAME, tasks);
  return { tasks };
}
