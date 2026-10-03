// Copies the Meteocons icons the display uses into public/icons/meteocons,
// without their animation. Run it after changing the icons used:
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

const VERSION = '0.1.0';
const SOURCE = `https://cdn.jsdelivr.net/npm/@meteocons/svg@${VERSION}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'icons', 'meteocons');

// The icon shown for weather codes that aren't in weatherCodes.json
const UNKNOWN_ICON = 'not-available';
// One-color icons used by the display (see the icons in src/App.jsx). Some
// icons, like smoke-particles and wind, are drawn by their animation and are
// empty or broken without it.
const WHITE_ICONS = ['smoke', 'pollen-flower'];

const weatherCodes = JSON.parse(await fs.readFile(path.join(root, 'src', 'weatherCodes.json'), 'utf8'));
const fillIcons = new Set([UNKNOWN_ICON]);
for (const { icon, nightIcon } of weatherCodes) {
  if (icon) fillIcons.add(icon);
  if (nightIcon) fillIcons.add(nightIcon);
}

const ANIMATION_TAGS = /^<\/?(animate|animateTransform|animateMotion|set)\b/;

/**
 * Removes SMIL animation, leaving each part where it rests. Many parts (rain
 * drops, snowflakes, particles) are invisible at rest and only fade in while
 * animating, so any part with an opacity animation is made fully visible.
 */
function withoutAnimation(svg) {
  const tags = [...svg.matchAll(/<[^>]+>/g)];
  const parents = [];
  const fadingParts = new Set();
  for (const { 0: tag, index } of tags) {
    if (tag.startsWith('</')) parents.pop();
    else if (/^<animate\b/.test(tag) && /attributeName="opacity"/.test(tag)) fadingParts.add(parents.at(-1));
    if (!tag.startsWith('</') && !tag.endsWith('/>') && !tag.startsWith('<?')) parents.push(index);
  }
  let result = '';
  let last = 0;
  for (const { 0: tag, index } of tags) {
    result += svg.slice(last, index);
    last = index + tag.length;
    if (ANIMATION_TAGS.test(tag)) continue;
    result += fadingParts.has(index) ? tag.replace(/\sopacity="[^"]*"/, '') : tag;
  }
  return result + svg.slice(last);
}

// Makes the parts drawn in black white, leaving masks (where black and white
// mean hidden and shown) as they are
function inWhite(svg) {
  return svg
    .split(/(<mask\b[\s\S]*?<\/mask>)/)
    .map((part) =>
      part.startsWith('<mask')
        ? part
        : part.replace(/(fill|stroke)="black"/g, '$1="white"').replace(/(fill|stroke)="#000(000)?"/gi, '$1="white"'),
    )
    .join('');
}

async function importIcons(style, names, folder, transform = (svg) => svg) {
  await fs.mkdir(path.join(output, folder), { recursive: true });
  for (const name of names) {
    const response = await fetch(`${SOURCE}/${style}/${name}.svg`);
    if (!response.ok) throw new Error(`${style}/${name}.svg: ${response.status}`);
    const svg = transform(withoutAnimation(await response.text()));
    await fs.writeFile(path.join(output, folder, `${name}.svg`), svg);
  }
  console.log(`${folder}: ${names.length} icons`);
}

await importIcons('fill', [...fillIcons], 'fill');
await importIcons('monochrome', WHITE_ICONS, 'white', inWhite);
