// Copies the Meteocons icons the display uses into public/icons/meteocons,
// from the official static (unanimated) versions. Run it after changing the
// icons used:
//   node scripts/importMeteocons.mjs
//
// - fill/: full color, for the weather codes in src/weatherCodes.json (and
//   the icon for unknown codes)
// - white/: the one-color (monochrome) style made white, for every other icon
//
// Meteocons by Bas Milius, MIT license (see public/icons/meteocons/LICENSE).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Meteocons' own CDN; svg-static has the icons without animation
const VERSION = '3.0.0-next.10';
const SOURCE = `https://cdn.meteocons.com/${VERSION}/svg-static`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'icons', 'meteocons');

// The icon shown for weather codes that aren't in weatherCodes.json
const UNKNOWN_ICON = 'not-available';
// Other icons used by the display (see the icons in src/App.jsx): in full
// color, and one-color (drawn white, and recolored on the page as needed)
const OTHER_FILL_ICONS = [
  ...Array.from({ length: 11 }, (_, i) => `uv-index-${i + 1}`),
  'uv-index-11-plus',
  ...['grass', 'tree', 'weed'].flatMap((type) =>
    ['low', 'moderate', 'high', 'very-high'].map((level) => `pollen-${type}-${level}`),
  ),
];
const WHITE_ICONS = ['smoke-particles', 'fahrenheit', 'starry-night'];

const weatherCodes = JSON.parse(await fs.readFile(path.join(root, 'src', 'weatherCodes.json'), 'utf8'));
const fillIcons = new Set([UNKNOWN_ICON, ...OTHER_FILL_ICONS]);
for (const { icon, nightIcon } of weatherCodes) {
  if (icon) fillIcons.add(icon);
  if (nightIcon) fillIcons.add(nightIcon);
}

// Makes the parts drawn in the text color (currentColor, which is black in an
// <img>) or black white, leaving masks (where black and white mean hidden and
// shown) as they are
function inWhite(svg) {
  return svg
    .split(/(<mask\b[\s\S]*?<\/mask>)/)
    .map((part) =>
      part.startsWith('<mask')
        ? part
        : part.replace(/(fill|stroke)="(currentColor|black|#000|#000000)"/gi, '$1="white"'),
    )
    .join('');
}

async function importIcons(style, names, folder, transform = (svg) => svg) {
  await fs.mkdir(path.join(output, folder), { recursive: true });
  for (const name of names) {
    const response = await fetch(`${SOURCE}/${style}/${name}.svg`);
    if (!response.ok) throw new Error(`${style}/${name}.svg: ${response.status}`);
    const svg = transform(await response.text());
    await fs.writeFile(path.join(output, folder, `${name}.svg`), svg);
  }
  console.log(`${folder}: ${names.length} icons`);
}

await importIcons('fill', [...fillIcons], 'fill');
await importIcons('monochrome', WHITE_ICONS, 'white', inWhite);
