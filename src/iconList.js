import weatherCodes from './weatherCodes.json';

// The icon shown for weather codes that aren't in weatherCodes.json
export const UNKNOWN_ICON = 'not-available';

// Meteocons icons, without animation (see scripts/importMeteocons.mjs): full
// color, and one-color made white
export const iconUrl = (name, style = 'fill') => `/icons/meteocons/${style === 'fill' ? 'fill' : 'white'}/${name}.svg`;

// The classes for an icon: .icon (spacing, see index.css) and its own class
// with its spacing adjustment (see icons.css)
export const iconClass = (name) => `icon icon-${name}`;

const weatherIcons = [
  ...new Set([...weatherCodes.flatMap(({ icon, nightIcon }) => [icon, nightIcon]), UNKNOWN_ICON].filter(Boolean)),
];
// Clear nights' icons: the moon's phase while it's up, else stars (see
// App.jsx's clearNightIcon), in the order of MOON_PHASE_NAMES there
export const MOON_PHASE_ICONS = [
  'new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous', 'full', 'waning-gibbous', 'last-quarter', 'waning-crescent',
].map((phase) => `moon-${phase}`);
const pollenIcons = ['grass', 'tree', 'weed'].flatMap((type) =>
  ['low', 'moderate', 'high', 'very-high'].map((level) => `pollen-${type}-${level}`),
);
// The precipitation icons for the forecast (see forecastWindow.js)
const PRECIPITATION_ICONS = ['raindrop', 'raindrops', 'snowflake'];
const uvIcons = [...Array.from({ length: 11 }, (_, i) => `uv-index-${i + 1}`), 'uv-index-11-plus'];

/**
 * Every icon the display uses: its name, style ('fill' or 'white'), size in
 * em of the text beside it (as the display draws it), and what it's used for
 */
export const ICONS = [
  ...weatherIcons.map((name) => ({ name, style: 'fill', size: 2, use: 'Weather' })),
  ...[...MOON_PHASE_ICONS, 'starry-night'].map((name) => ({ name, style: 'fill', size: 2, use: 'Clear night' })),
  ...['barometer-low', 'barometer-moderate', 'barometer-high', 'barometer-very-high', 'barometer-extreme'].map(
    (name) => ({ name, style: 'white', size: 1.35, use: 'Air quality' }),
  ),
  ...uvIcons.map((name) => ({ name, style: 'fill', size: 1.5, use: 'UV index' })),
  ...pollenIcons.map((name) => ({ name, style: 'fill', size: 1.5, use: 'Pollen' })),
  { name: 'fahrenheit', style: 'white', size: 1.8, use: 'Temperature' },
  { name: 'sunrise', style: 'white', size: 2, use: 'Sunrise and sunset' },
  { name: 'sunset', style: 'white', size: 2, use: 'Sunrise and sunset' },
  { name: 'moonrise', style: 'white', size: 1.5, use: 'Moonrise and moonset' },
  { name: 'moonset', style: 'white', size: 1.5, use: 'Moonrise and moonset' },
  // (those also used for weather codes are listed there; their forecast-size
  // margins are in index.css)
  ...PRECIPITATION_ICONS.filter((name) => !weatherIcons.includes(name)).map((name) => ({
    name,
    style: 'fill',
    size: 1.5,
    use: 'Forecast',
  })),
  { name: 'smoke-particles', style: 'white', size: 1.875, use: 'Humidity and wind' },
  ...Array.from({ length: 13 }, (_, force) => ({
    name: `wind-beaufort-${force}`,
    style: 'fill',
    size: 1.5,
    use: 'Humidity and wind',
  })),
  { name: 'bedtime-mode', style: 'white', size: 1.5, use: 'Bedtime button' },
];
