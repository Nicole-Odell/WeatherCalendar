import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as AlertsManager from './AlertsManager.js';
import * as CalendarManager from './CalendarManager.js';
import * as ForecastManager from './ForecastManager.js';
import * as PollenManager from './PollenManager.js';
import * as SkyColorManager from './SkyColorManager.js';
import * as TasksManager from './TasksManager.js';
import * as TimeOfDayManager from './TimeOfDayManager.js';
import * as WeatherManager from './WeatherManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3001;
// How often the weather cache is checked. It only fetches new weather once
// its data is 15 minutes old (or missing).
const WEATHER_CHECK_INTERVAL = 60 * 1000;

const app = express();

// The weather values the sky's atmosphere tables depend on
function atmosphereWeather(current) {
  return {
    surfacePressure: current.surface_pressure,
    temperature: current.temperature_2m,
    aerosolOpticalDepth: current.aerosol_optical_depth,
  };
}

// The latest weather, for the moon's phase
let latestWeather = null;

// Refreshes the weather if it's due, and rebuilds the sky's atmosphere tables
// in the background if it has changed significantly
async function checkWeather(forceRefresh = false) {
  const weather = await WeatherManager.GetCurrentWeatherData(forceRefresh);
  latestWeather = weather;
  SkyColorManager.UpdateAtmosphere(atmosphereWeather(weather.current)).catch((error) =>
    console.error('Failed to build the atmosphere tables:', error),
  );
  return weather;
}

// The first check, which starts the first atmosphere tables building
const firstWeatherCheck = checkWeather().catch((error) =>
  console.error('Failed to get the weather:', error),
);
setInterval(
  () => checkWeather().catch((error) => console.error('Failed to get the weather:', error)),
  WEATHER_CHECK_INTERVAL,
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/weather/current', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    res.json(await checkWeather(forceRefresh));
  } catch (error) {
    console.error('Failed to get current weather:', error);
    res.status(502).json({ error: error.message });
  }
});

// The forecast for the next two days (see ForecastManager.GetForecast)
app.get('/api/forecast', async (req, res) => {
  try {
    res.json(await ForecastManager.GetForecast());
  } catch (error) {
    console.error('Failed to get the forecast:', error);
    res.status(502).json({ error: error.message });
  }
});

// The National Weather Service's active alerts (see AlertsManager.GetAlerts);
// ?area=XX gets a state's instead, for testing
app.get('/api/alerts', async (req, res) => {
  try {
    res.json(await AlertsManager.GetAlerts(req.query.area));
  } catch (error) {
    console.error('Failed to get alerts:', error);
    res.status(502).json({ error: error.message });
  }
});

// Today's pollen: pollen.com's overall index, and each category's level (see
// PollenManager.GetPollen)
app.get('/api/pollen', async (req, res) => {
  try {
    res.json(await PollenManager.GetPollen());
  } catch (error) {
    console.error('Failed to get pollen:', error);
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/time-of-day/sun-times', async (req, res) => {
  try {
    res.json(await TimeOfDayManager.GetSunTimes());
  } catch (error) {
    console.error('Failed to get sun times:', error);
    res.status(502).json({ error: error.message });
  }
});

// A day's calendar events (see CalendarManager.GetEvents): today, or the
// day given as ?date=YYYY-MM-DD, from feeds fetched again with ?fresh=true
app.get('/api/calendar/today', async (req, res) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(req.query.date || '');
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : new Date();
  try {
    res.json(await CalendarManager.GetEvents(date, { fresh: req.query.fresh === 'true' }));
  } catch (error) {
    console.error('Failed to get calendar events:', error);
    res.status(502).json({ error: error.message });
  }
});

// The daily tasks under "Today": when each was done (see TasksManager)
app.get('/api/tasks', async (req, res) => {
  try {
    res.json(await TasksManager.GetTasks());
  } catch (error) {
    console.error('Failed to read tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Marks a task done now, unless it's already been done its number of times
// since ?since= (the last sunrise)
app.post('/api/tasks/:task/done', async (req, res) => {
  try {
    res.json(await TasksManager.DoTask(req.params.task, req.query.since));
  } catch (error) {
    console.error('Failed to mark a task done:', error);
    res.status(400).json({ error: error.message });
  }
});

// Clears every task, so none are done
app.post('/api/tasks/reset', async (req, res) => {
  try {
    res.json(await TasksManager.ResetTasks());
  } catch (error) {
    console.error('Failed to reset tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// The moonrises and moonsets in the next two days (see
// TimeOfDayManager.GetMoonEvents)
app.get('/api/time-of-day/moon-events', (req, res) => {
  res.json({ events: TimeOfDayManager.GetMoonEvents() });
});

// How often the sky stream sends the sky colors (ms)
const SKY_STREAM_INTERVAL = 1000;

// What the sky needs of the moon's position: its altitude, how its picture is
// turned (its north, clockwise from up) and which way its lit side faces
// (counterclockwise from up), in degrees
function moonView({ altitude, parallacticAngle, brightLimb }) {
  return { altitude, rotation: parallacticAngle, brightLimb };
}

/**
 * Clear-sky colors looking toward the sun, the color of direct sunlight by
 * height, and the moon's altitude, rotation and lit side (see moonView) and phase (0–1, 0.5
 * is full), at
 * `time`. The atmosphere is from the weather the atmosphere tables in use
 * were built from, which `atmosphere` gives, until new ones are built.
 */
async function skyAt(time) {
  // Only waits the first time, before any tables are built
  await firstWeatherCheck;
  await SkyColorManager.WhenAtmosphereReady();
  const sun = TimeOfDayManager.GetSunPosition(time);
  const conditions = { sunElevation: sun.elevation, sunDistance: sun.distance };
  return {
    time: time.toISOString(),
    sun,
    moon: {
      ...moonView(TimeOfDayManager.GetMoonPosition(time)),
      phase: latestWeather ? WeatherManager.GetMoonPhase(latestWeather.moonPhases, time) : null,
    },
    colors: SkyColorManager.CalculateSkyColors(conditions),
    sunlight: SkyColorManager.CalculateSunlight(conditions),
    atmosphere: SkyColorManager.GetAtmosphereStatus(),
  };
}

// The sky (see skyAt) for `time` (an ISO 8601 date and time) if it's given,
// or for now
app.get('/api/sky/colors', async (req, res) => {
  const time = req.query.time ? new Date(req.query.time) : new Date();
  if (Number.isNaN(time.getTime())) {
    res.status(400).json({ error: `Invalid time: ${req.query.time}` });
    return;
  }
  try {
    res.json(await skyAt(time));
  } catch (error) {
    console.error('Failed to calculate sky colors:', error);
    res.status(500).json({ error: error.message });
  }
});

// The sky (see skyAt) for now, sent every SKY_STREAM_INTERVAL as server-sent
// events for as long as the page stays connected. One long-lived connection
// instead of a request every second: on the Pi 3's Chromium 74, each request
// leaves memory behind, which adds up to the whole Pi's memory within a day.
app.get('/api/sky/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let sending = false;
  const send = async () => {
    // Skips a turn if the last one is still being worked out
    if (sending) return;
    sending = true;
    try {
      res.write(`data: ${JSON.stringify(await skyAt(new Date()))}\n\n`);
    } catch (error) {
      console.error('Failed to calculate sky colors:', error);
    } finally {
      sending = false;
    }
  };
  send();
  const timer = setInterval(send, SKY_STREAM_INTERVAL);
  req.on('close', () => clearInterval(timer));
});

// Serve the built React app
app.use(express.static(distDir));
app.get('*splat', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
