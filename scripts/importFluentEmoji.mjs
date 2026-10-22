// Copies Microsoft's Fluent Emoji, in their Color style, into emoji/ (which
// git ignores, as it's about 176 MB), for the display to show in place of
// the emoji in text from calendars and tasks (see EmojiText in App.jsx), so
// they look the same on every screen. The server serves them (see
// server/index.js). Run it again to update them:
//   node scripts/importFluentEmoji.mjs [path to a clone of fluentui-emoji]
// Without a path, it fetches just what it needs from GitHub (the metadata
// and Color pictures, not the large 3D ones).
//
// Each picture is saved as emoji/<code points>.svg: the emoji's Unicode code
// points in hex, joined by "-", leaving out variation selector 16 (fe0f),
// which some text has and some doesn't. emoji/index.json lists them all.
//
// Fluent Emoji by Microsoft, MIT license (copied to emoji/LICENSE).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'emoji');
const REPOSITORY = 'https://github.com/microsoft/fluentui-emoji.git';
// The folders for each skin tone, in the order of metadata.json's unicodeSkintones
const SKIN_TONE_FOLDERS = ['Default', 'Light', 'Medium-Light', 'Medium', 'Medium-Dark', 'Dark'];

// A picture's file name from its code points ("1f486 200d 2640 fe0f")
const fileName = (unicode) =>
  `${unicode
    .trim()
    .split(/\s+/)
    .filter((point) => point.toLowerCase() !== 'fe0f')
    .join('-')
    .toLowerCase()}.svg`;

let source = process.argv[2];
if (!source) {
  source = await fs.mkdtemp(path.join(os.tmpdir(), 'fluentui-emoji-'));
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'inherit' });
  git('clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', REPOSITORY, '.');
  git('sparse-checkout', 'set', '--no-cone', '/LICENSE', '/assets/*/metadata.json', '/assets/*/Color/*', '/assets/*/*/Color/*');
}

const assets = path.join(source, 'assets');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const saved = [];
for (const name of await fs.readdir(assets)) {
  const folder = path.join(assets, name);
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8'));
  } catch {
    continue;
  }
  // (one picture, or one per skin tone)
  const versions = metadata.unicodeSkintones
    ? metadata.unicodeSkintones.map((unicode, i) => [unicode, path.join(folder, SKIN_TONE_FOLDERS[i], 'Color')])
    : [[metadata.unicode, path.join(folder, 'Color')]];
  for (const [unicode, colorFolder] of versions) {
    let files;
    try {
      files = (await fs.readdir(colorFolder)).filter((file) => file.endsWith('.svg'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const file = fileName(unicode);
    await fs.copyFile(path.join(colorFolder, files[0]), path.join(output, file));
    saved.push(file.replace(/\.svg$/, ''));
  }
}
await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(saved.sort()));
await fs.copyFile(path.join(source, 'LICENSE'), path.join(output, 'LICENSE')).catch(() => {});
console.log(`emoji/: ${saved.length} pictures`);
