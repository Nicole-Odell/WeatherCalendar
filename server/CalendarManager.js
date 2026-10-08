import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ical from 'node-ical';

/*
 * Today's events from Google Calendar (or any calendar with an iCal feed),
 * read from each calendar's "secret address in iCal format": in Google
 * Calendar on the web, Settings > the calendar under "Settings for my
 * calendars" > "Integrate calendar" > "Secret address in iCal format". It's a
 * private, read-only link, so it's kept in config/calendar.json, which git
 * ignores (see server/calendar.example.json for its form):
 *   { "calendars": [{ "url": "https://calendar.google.com/calendar/ical/.../basic.ics",
 *                     "name": "Personal", "color": "Peacock" }] }
 * `name` is optional (the calendar's own name from its feed by default), as
 * is `color`: one of Google Calendar's color names (see GOOGLE_COLORS, as
 * Google's feeds don't include the color you chose) or any CSS color. Without
 * one, each calendar gets the next of DEFAULT_COLORS.
 * Feeds are fetched at most every FEED_REFRESH_MS; if a fetch fails, the last
 * one fetched is used.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'calendar.json');
const FEED_REFRESH_MS = 5 * 60 * 1000;

// Google Calendar's calendar colors, by the names it shows for them
const GOOGLE_COLORS = {
  tomato: '#d50000',
  flamingo: '#e67c73',
  tangerine: '#f4511e',
  banana: '#f6bf26',
  sage: '#33b679',
  basil: '#0b8043',
  peacock: '#039be5',
  blueberry: '#3f51b5',
  lavender: '#7986cb',
  grape: '#8e24aa',
  graphite: '#616161',
};
const DEFAULT_COLORS = ['peacock', 'sage', 'tangerine', 'grape', 'banana', 'tomato', 'lavender', 'basil', 'flamingo', 'blueberry'];

// A calendar's color as CSS: a Google color name's color, or as given
function calendarColor(color, index) {
  const name = color || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
  return GOOGLE_COLORS[String(name).toLowerCase()] || name;
}

// Each feed's last fetch, by URL: { fetchedAt (ms), events (parsed) }
const feeds = new Map();

// The calendars set up in config/calendar.json, or [] if there are none
async function readCalendars() {
  try {
    const { calendars } = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    return Array.isArray(calendars) ? calendars.filter((calendar) => calendar && calendar.url) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`config/calendar.json is unreadable: ${error.message}`);
  }
}

// A feed's parsed events, fetched again if the last fetch is old or `fresh`
async function feedEvents(url, fresh = false) {
  const cached = feeds.get(url);
  if (!fresh && cached && Date.now() - cached.fetchedAt < FEED_REFRESH_MS) return cached.events;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`calendar feed request failed (${response.status})`);
    const events = await ical.async.parseICS(await response.text());
    feeds.set(url, { fetchedAt: Date.now(), events });
    return events;
  } catch (error) {
    if (cached) {
      console.error('Using the last calendar feed fetched, as fetching it again failed:', error.message);
      return cached.events;
    }
    throw error;
  }
}

// Text from a parsed property, which may carry parameters
const text = (value) => (value && typeof value === 'object' ? value.val : value) || '';

// Midnight starting the day `date` is in, and the next midnight, on this
// computer's clock (the display's time zone)
function dayAround(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
}

// An all-day instance's day as YYYY-MM-DD, from its date (all-day dates are
// midnight UTC of the day they're on)
const allDayDate = (date) => date.toISOString().slice(0, 10);
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * Returns the events on the day `date` is in (today by default), from every
 * calendar set up, as { configured, date (YYYY-MM-DD), calendars, events,
 * errors }:
 * - configured: whether any calendars are set up
 * - calendars: [{ name, color }], in the order set up
 * - events: [{ id, calendar (its name), color (its calendar's, as CSS), title,
 *   location, allDay, start, end }]
 *   with start and end as ISO 8601 times (for all-day events, the day's
 *   midnights), all-day events first, then by start time. Events that began
 *   before the day or end after it are included.
 * - errors: [{ calendar, error }] for calendars that couldn't be read
 * With `fresh`, every feed is fetched again rather than taken from the last
 * fetch.
 */
export async function GetEvents(date = new Date(), { fresh = false } = {}) {
  const calendars = await readCalendars();
  const { start: dayStart, end: dayEnd } = dayAround(date);
  const today = localDate(dayStart);
  const events = [];
  const errors = [];
  const shown = calendars.map((calendar, index) => ({
    name: calendar.name || `Calendar ${index + 1}`,
    color: calendarColor(calendar.color, index),
  }));
  await Promise.all(
    calendars.map(async (calendar, index) => {
      let name = shown[index].name;
      const { color } = shown[index];
      try {
        const parsed = await feedEvents(calendar.url, fresh);
        // Without a name set, the calendar's own
        const own = parsed.vcalendar && text(parsed.vcalendar['WR-CALNAME']);
        if (!calendar.name && own) name = shown[index].name = own;
        for (const event of Object.values(parsed)) {
          if (event.type !== 'VEVENT' || event.status === 'CANCELLED') continue;
          const instances = ical.expandRecurringEvent(event, {
            from: dayStart,
            to: dayEnd,
            expandOngoing: true,
          });
          for (const instance of instances) {
            const start = new Date(instance.start);
            const end = new Date(instance.end || instance.start);
            if (instance.isFullDay) {
              // All-day events run from their first day up to (not
              // including) their end date
              const first = allDayDate(start);
              const last = instance.end ? allDayDate(end) : first;
              if (!(first <= today && (today < last || first === last))) continue;
            } else if (!(start < dayEnd && end > dayStart)) {
              continue;
            }
            if (instance.event && instance.event.status === 'CANCELLED') continue;
            events.push({
              id: `${index}:${instance.event?.uid || event.uid}:${start.toISOString()}`,
              calendar: name,
              color,
              title: text(instance.summary) || '(No title)',
              location: text(instance.event?.location ?? event.location),
              allDay: Boolean(instance.isFullDay),
              start: instance.isFullDay ? dayStart.toISOString() : start.toISOString(),
              end: instance.isFullDay ? dayEnd.toISOString() : end.toISOString(),
            });
          }
        }
      } catch (error) {
        console.error(`Failed to read the calendar "${name}":`, error.message);
        errors.push({ calendar: name, error: error.message });
      }
    }),
  );
  events.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return { configured: calendars.length > 0, date: today, calendars: shown, events, errors };
}
