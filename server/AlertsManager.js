import { readCache, writeCache } from './cache.js';
import { LATITUDE, LONGITUDE } from './location.js';

const CACHE_NAME = 'alerts';
const CACHE_DURATION_MS = 5 * 60 * 1000;
// The National Weather Service asks for a User-Agent naming the app and a contact
const USER_AGENT = 'WeatherCalendar (nicole.odellp@gmail.com)';

/**
 * Returns the National Weather Service's active watches, warnings and
 * advisories as { fetchedAt, alerts }, each alert being { id, event,
 * headline, severity (Extreme, Severe, Moderate, Minor or Unknown), urgency,
 * certainty, onset, ends (ISO times, or null), description, instruction }, most
 * severe first. Alerts are for the display's location, or for `area` (a state
 * or marine area code, such as "TX") when given, which skips the cache (for
 * testing). Data comes from the cache unless it is over 5 minutes old.
 */
export async function GetAlerts(area) {
  if (area) return fetchAlerts({ area });
  const cached = await readCache(CACHE_NAME);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_DURATION_MS) return cached;
  const alerts = await fetchAlerts({ point: `${LATITUDE},${LONGITUDE}` });
  await writeCache(CACHE_NAME, alerts);
  return alerts;
}

const SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

async function fetchAlerts(params) {
  const response = await fetch(`https://api.weather.gov/alerts/active?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!response.ok) {
    throw new Error(`NWS alerts request failed (${response.status}): ${await response.text()}`);
  }
  const { features } = await response.json();
  const alerts = features
    .map(({ properties: p }) => ({
      id: p.id,
      event: p.event,
      headline: p.headline,
      severity: p.severity,
      urgency: p.urgency,
      certainty: p.certainty,
      onset: p.onset ?? p.effective,
      ends: p.ends ?? p.expires,
      description: p.description,
      instruction: p.instruction,
    }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return { fetchedAt: new Date().toISOString(), alerts };
}
