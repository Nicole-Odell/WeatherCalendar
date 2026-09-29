import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SkyColorManager from './SkyColorManager.js';
import * as TimeOfDayManager from './TimeOfDayManager.js';
import * as WeatherManager from './WeatherManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3001;

const app = express();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/weather/current', async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === 'true';
    res.json(await WeatherManager.GetCurrentWeatherData(forceRefresh));
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

// Clear-sky colors looking toward the sun, using the current weather. The sun's
// position is for `time` (an ISO 8601 date and time) if it's given, or for now.
app.get('/api/sky/colors', async (req, res) => {
  const time = req.query.time ? new Date(req.query.time) : new Date();
  if (Number.isNaN(time.getTime())) {
    res.status(400).json({ error: `Invalid time: ${req.query.time}` });
    return;
  }
  try {
    const sun = TimeOfDayManager.GetSunPosition(time);
    const { current } = await WeatherManager.GetCurrentWeatherData();
    const colors = SkyColorManager.CalculateSkyColors({
      sunElevation: sun.elevation,
      sunDistance: sun.distance,
      surfacePressure: current.surface_pressure,
      temperature: current.temperature_2m,
      aerosolOpticalDepth: current.aerosol_optical_depth,
    });
    res.json({ time: time.toISOString(), sun, colors });
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
