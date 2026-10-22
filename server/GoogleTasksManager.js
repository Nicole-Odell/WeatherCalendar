import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SunriseOn } from './TimeOfDayManager.js';

/*
 * Google Tasks, from the Apps Script web app in scripts/googleTasks.gs, which
 * returns them as JSON (Google Tasks has no calendar feed). Its URL and key
 * are kept in config/googleTasks.json, which git ignores:
 *   { "url": "https://script.google.com/macros/s/.../exec", "key": "..." }
 * Fetched at most every FETCH_EVERY_MS; if a fetch fails, the last one is used.
 *
 * Google doesn't say which tasks repeat: a recurring task is just its current
 * occurrence, a task due on that day, and completing it makes the next. So
 * a day's tasks are the ones due that day (done or not), and on today, the
 * ones due earlier but not done (which is where a recurring task whose
 * latest occurrence isn't done shows up).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'googleTasks.json');
const FETCH_EVERY_MS = 5 * 60 * 1000;
// Tasks never shown, by their exact title
const HIDDEN_TITLES = ['💆‍♀️AM', '💆‍♀️PM'];
const TIMEOUT = 20 * 1000;

let last = null; // { fetchedAt (ms), tasks }

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`config/googleTasks.json is unreadable: ${error.message}`);
  }
}

// All the tasks, fetched again if the last fetch is old or `fresh`
async function allTasks(config, fresh) {
  if (!fresh && last && Date.now() - last.fetchedAt < FETCH_EVERY_MS) return last.tasks;
  try {
    const url = `${config.url}${config.url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.key)}`;
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error || `request failed (${response.status})`);
    last = { fetchedAt: Date.now(), tasks: body.tasks || [] };
    return last.tasks;
  } catch (error) {
    if (last) {
      console.error('Using the Google Tasks last fetched, as fetching them again failed:', error.message);
      return last.tasks;
    }
    throw error;
  }
}

/**
 * Marks a task completed in Google Tasks (through the Apps Script), and in
 * the tasks last fetched, so it shows done straight away
 */
export async function CompleteTask(listId, taskId) {
  const config = await readConfig();
  if (!config.url || !config.key) throw new Error('Google Tasks is not set up');
  if (!listId || !taskId) throw new Error('Give listId and taskId');
  // (the script answers a POST with a redirect to its result, which fetch
  // follows with a GET)
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ key: config.key, listId, taskId }),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // (a script error comes back as Google's error page: its message, if
    // there is one, else the script needs updating)
    const message = text
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .match(/(?:Exception|Error):[^(]+/);
    throw new Error(
      message ? `Apps Script ${message[0].trim()}` : 'The Apps Script needs updating to complete tasks (see scripts/googleTasks.gs)',
    );
  }
  if (body.error) throw new Error(body.error);
  if (last) {
    last.tasks = last.tasks.map((task) =>
      task.id === taskId ? { ...task, status: 'completed', completed: body.completed || new Date().toISOString() } : task,
    );
  }
  return body;
}

/**
 * The order tasks are listed in: completed ones first, in the order they
 * were completed (so completing them top to bottom leaves them in place, and
 * bottom to top reverses them), then the open ones, overdue first, then by
 * title (the display sorts the same way as soon as one's tapped)
 */
export function compareTasks(a, b) {
  if (a.done !== b.done) return a.done ? -1 : 1;
  if (a.done) return (Date.parse(a.completed) || 0) - (Date.parse(b.completed) || 0);
  return Number(b.overdue) - Number(a.overdue) || a.title.localeCompare(b.title);
}

// Whether a task was completed on the day `date` (YYYY-MM-DD), which runs
// from its sunrise, as the display's days do
function completedToday(task, date) {
  if (!task.completed) return false;
  const [year, month, day] = date.split('-').map(Number);
  return Date.parse(task.completed) >= SunriseOn(new Date(year, month - 1, day, 12)).getTime();
}

/**
 * The tasks for the day `date` (YYYY-MM-DD), as { configured, tasks }: each
 * { id, listId, list, title, notes, due (YYYY-MM-DD), done, completed (an
 * ISO 8601 time, or null), overdue }, in compareTasks's order. `today` is the display's
 * today (YYYY-MM-DD).
 */
export async function GetTasks(date, today, { fresh = false } = {}) {
  const config = await readConfig();
  if (!config.url || !config.key) return { configured: false, tasks: [] };
  const tasks = (await allTasks(config, fresh))
    .filter((task) => !HIDDEN_TITLES.includes(task.title))
    .map((task) => ({
      id: task.id,
      listId: task.listId,
      list: task.list,
      title: task.title,
      notes: task.notes,
      // (Google keeps due dates as midnight UTC of the day)
      due: task.due ? task.due.slice(0, 10) : null,
      done: task.status === 'completed',
      completed: task.completed,
    }))
    .filter(
      (task) =>
        task.due &&
        (task.due === date ||
          // (overdue ones on today, open or completed today, so completing
          // one moves it up rather than out)
          (date === today && task.due < date && (!task.done || completedToday(task, date)))),
    )
    .map((task) => ({ ...task, overdue: task.due < date }));
  tasks.sort(compareTasks);
  return { configured: true, tasks };
}
