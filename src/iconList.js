import weatherCodes from './weatherCodes.json';

// The icon shown for weather codes that aren't in weatherCodes.json
export const UNKNOWN_ICON = 'not-available';

// An icon's file, by its set:
// - 'meteocons': Meteocons, without animation (see
//   scripts/importMeteocons.mjs), in style 'fill' (full color) or 'white'
//   (one-color made white)
// - 'fluent': Fluent UI System Icons (see scripts/importFluent.mjs), in style
//   'color' (full color) or 'white' (one-color made white)
// - 'custom': icons made for the display, kept in public/icons/custom (not
//   imported, so edit them there), each in full color
export const iconUrl = (name, style = 'fill', set = 'meteocons') => {
  if (set === 'custom') return `/icons/custom/${name}.svg`;
  if (set === 'fluent') return `/icons/fluent/${style === 'white' ? 'white' : 'color'}/${name}.svg`;
  return `/icons/meteocons/${style === 'fill' ? 'fill' : 'white'}/${name}.svg`;
};

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

// Fluent icons on the corner buttons (see scripts/importFluent.mjs)
export const SETTINGS_ICON = 'settings-24-regular';
export const BACK_ICON = 'arrow-left-24-regular';
export const SHOW_SKY_ICON = 'eye-24-regular';
export const SHOW_ALL_ICON = 'eye-off-24-regular';
// The arrows either side of the Today title (see TodayTasks in App.jsx)
export const DAY_BACK_ICON = 'chevron-left-24-regular';
export const DAY_ON_ICON = 'chevron-right-24-regular';
// The calendar's refresh button
export const REFRESH_ICON = 'arrow-clockwise-24-regular';

// Icons for today's tasks (see TodayTasks in App.jsx): custom icons, drawn
// empty while not done and filled once done
export const CUSTOM_TASK_ICONS = {
  stretch: 'excersise-empty',
  stretchDone: 'excersise-filled',
  sleep: 'bed-empty',
  sleepDone: 'bed-filled',
  leave: 'leave-house-empty',
  leaveDone: 'leave-house-filled',
  water: 'water-cup-empty',
  waterDone: 'water-cup-full',
  work: 'work-empty',
  workDone: 'work-filled',
};

/**
 * Every icon the display uses: its name, set ('meteocons' unless given, see
 * iconUrl), style, size in em of the text beside it (as the display draws
 * it), and what it's used for
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
  ...Object.values(CUSTOM_TASK_ICONS).map((name) => ({ name, set: 'custom', style: 'color', size: 2.25, use: 'Today' })),
  ...[DAY_BACK_ICON, DAY_ON_ICON].map((name) => ({ name, set: 'fluent', style: 'white', size: 1, use: 'Today' })),
  { name: REFRESH_ICON, set: 'fluent', style: 'white', size: 0.93, use: 'Today' },
  ...[SETTINGS_ICON, BACK_ICON, SHOW_SKY_ICON, SHOW_ALL_ICON].map((name) => ({
    name,
    set: 'fluent',
    style: 'white',
    size: 1,
    use: 'Corner buttons',
  })),
];
