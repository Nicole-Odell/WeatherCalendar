// Copies the Fluent UI System Icons the display uses into public/icons/fluent,
// from Iconify's API, which serves each icon as its own SVG. Run it after
// changing the icons used:
//   node scripts/importFluent.mjs
//
// - color/: Fluent's full-color icons (the fluent-color set)
// - white/: Fluent's one-color icons (the fluent set) made white, recolored
//   on the page as needed
//
// Fluent UI System Icons by Microsoft, MIT license (see
// public/icons/fluent/LICENSE).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://api.iconify.design';
const LICENSE_URL = 'https://raw.githubusercontent.com/microsoft/fluentui-system-icons/main/LICENSE';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'icons', 'fluent');
// Iconify limits how fast it's asked, so icons are fetched this far apart (ms)
const REQUEST_GAP = 150;

// The icons used by the display (see the icons in src/App.jsx and
// src/iconList.js), by their Fluent names
const COLOR_ICONS = [];
const WHITE_ICONS = [
  // The corner buttons: Settings and Back, and show or hide everything
  'settings-24-regular',
  'arrow-left-24-regular',
  'eye-24-regular',
  'eye-off-24-regular',
  // The arrows either side of the Today title, which change the calendar's day
  'chevron-left-24-regular',
  'chevron-right-24-regular',
  // The calendar's refresh button
  'arrow-clockwise-24-regular',
];

// Gives the icon its size from its viewBox (Iconify sizes it 1em, which an
// <img> doesn't need)
function withViewBoxSize(svg) {
  const viewBox = svg.match(/viewBox="([\d.\s-]+)"/);
  if (!viewBox) return svg;
  const [, , width, height] = viewBox[1].trim().split(/\s+/);
  return svg.replace(/\swidth="1em"/, ` width="${width}"`).replace(/\sheight="1em"/, ` height="${height}"`);
}

// Makes the parts drawn in the text color (currentColor, which is black in an
// <img>) or black white
function inWhite(svg) {
  return svg.replace(/(fill|stroke)="(currentColor|black|#000|#000000)"/gi, '$1="white"');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importIcons(set, names, folder, transform = (svg) => svg) {
  await fs.mkdir(path.join(output, folder), { recursive: true });
  for (const name of names) {
    const response = await fetch(`${SOURCE}/${set}/${name}.svg`);
    if (!response.ok) throw new Error(`${set}/${name}.svg: ${response.status}`);
    const svg = transform(withViewBoxSize(await response.text()));
    await fs.writeFile(path.join(output, folder, `${name}.svg`), svg);
    await wait(REQUEST_GAP);
  }
  console.log(`${folder}: ${names.length} icons`);
}

await importIcons('fluent-color', COLOR_ICONS, 'color');
await importIcons('fluent', WHITE_ICONS, 'white', inWhite);

const license = await fetch(LICENSE_URL);
if (!license.ok) throw new Error(`LICENSE: ${license.status}`);
await fs.writeFile(path.join(output, 'LICENSE'), await license.text());
