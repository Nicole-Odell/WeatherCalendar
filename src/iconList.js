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
const pollenIcons = ['grass', 'tree', 'weed'].flatMap((type) =>
  ['low', 'moderate', 'high', 'very-high'].map((level) => `pollen-${type}-${level}`),
);
const uvIcons = [...Array.from({ length: 11 }, (_, i) => `uv-index-${i + 1}`), 'uv-index-11-plus'];

/**
 * Every icon the display uses: its name, style ('fill' or 'white'), size in
 * em of the text beside it (as the display draws it), and what it's used for
 */
export const ICONS = [
  ...weatherIcons.map((name) => ({ name, style: 'fill', size: 2, use: 'Weather' })),
  { name: 'smoke-particles', style: 'white', size: 1.5, use: 'Air quality' },
  ...uvIcons.map((name) => ({ name, style: 'fill', size: 1.5, use: 'UV index' })),
  ...pollenIcons.map((name) => ({ name, style: 'fill', size: 1.5, use: 'Pollen' })),
  { name: 'fahrenheit', style: 'white', size: 1.8, use: 'Temperature' },
  { name: 'starry-night', style: 'white', size: 1.5, use: 'Bedtime button' },
];
