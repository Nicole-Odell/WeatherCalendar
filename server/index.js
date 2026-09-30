import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SkyColorManager from './SkyColorManager.js';
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

// Refreshes the weather if it's due, and rebuilds the sky's atmosphere tables
// in the background if it has changed significantly
async function checkWeather(forceRefresh = false) {
  const weather = await WeatherManager.GetCurrentWeatherData(forceRefresh);
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

app.get('/api/time-of-day/sun-times', async (req, res) => {
  try {
    res.json(await TimeOfDayManager.GetSunTimes());
  } catch (error) {
    console.error('Failed to get sun times:', error);
    res.status(502).json({ error: error.message });
  }
});

// Clear-sky colors looking toward the sun, and the color of direct sunlight by
// height. The sun's position is for `time` (an ISO 8601 date and time) if it's
// given, or for now. The atmosphere is from the weather the atmosphere tables
// in use were built from, which `atmosphere` gives, until new ones are built.
app.get('/api/sky/colors', async (req, res) => {
  const time = req.query.time ? new Date(req.query.time) : new Date();
  if (Number.isNaN(time.getTime())) {
    res.status(400).json({ error: `Invalid time: ${req.query.time}` });
    return;
  }
  try {
    // Only waits the first time, before any tables are built
    await firstWeatherCheck;
    await SkyColorManager.WhenAtmosphereReady();
    const sun = TimeOfDayManager.GetSunPosition(time);
    const conditions = { sunElevation: sun.elevation, sunDistance: sun.distance };
    const colors = SkyColorManager.CalculateSkyColors(conditions);
    const sunlight = SkyColorManager.CalculateSunlight(conditions);
    res.json({
      time: time.toISOString(),
      sun,
      colors,
      sunlight,
      atmosphere: SkyColorManager.GetAtmosphereStatus(),
    });
  } catch (error) {
    console.error('Failed to calculate sky colors:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve the built React app
app.use(express.static(distDir));
app.get('*splat', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
