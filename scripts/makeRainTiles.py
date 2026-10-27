#!/usr/bin/env python3
"""
Makes the frames of falling rain the display shows (see precipitation.js):
public/rain/rain-<level>.webp for light, moderate and heavy rain, each a
still WebP with soft transparency holding its frames one above the other.

Each frame is a tile the screen's full width and half its height, at half
the screen's resolution (as the precipitation canvas is drawn); the canvas
stretches it to its width and repeats it down. The frames loop every
LOOP_SECONDS, FRAME_MS apart. To loop without a jump, every streak falls a
whole number of tile heights each loop, so streaks fall straight down
(leaning, but not drifting across).

(They're frames in one still image, not an animated one, as the Pi 3's
browser redraws a whole screen-sized animated image for each of its frames,
which it can only do a few times a second; the canvas just copies frames.)

Run it again after changing the settings below:
  python3 scripts/makeRainTiles.py
"""
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'public' / 'rain'

# The tile: pixels at half the 1080 × 1920 screen's resolution
SCALE = 0.5
WIDTH = round(1080 * SCALE)
HEIGHT = round(960 * SCALE)
# Drawn this many times larger, then scaled down, for smooth streaks
SUPERSAMPLE = 4
FRAME_MS = 100
LOOP_SECONDS = 2
COLOR = (220, 230, 245)

# Far to near (screen pixels, counts for the whole screen): streaks
# `length` px long and `width` px wide, leaning `slant` px across per px
# down, each falling `tiles` tile heights a loop (at 2 s, 4 is about 960
# screen px/s)
LAYERS = [
    {'count': 220, 'length': 22, 'width': 1, 'tiles': 4, 'slant': 0.08, 'opacity': 0.35},
    {'count': 120, 'length': 36, 'width': 1.5, 'tiles': 5, 'slant': 0.08, 'opacity': 0.45},
    {'count': 50, 'length': 56, 'width': 2, 'tiles': 8, 'slant': 0.08, 'opacity': 0.55},
]
# The levels made, by their intensity (0–100: the share of each layer's
# streaks shown, and their opacity, from 40% to full)
LEVELS = {'light': 33, 'moderate': 66, 'heavy': 100}


def make(name, intensity, seed=1):
    share = intensity / 100
    frames = round(LOOP_SECONDS * 1000 / FRAME_MS)
    size = (WIDTH * SUPERSAMPLE, HEIGHT * SUPERSAMPLE)
    # (the tile is half the screen's height, so it has half the streaks)
    rng = random.Random(seed)
    streaks = []
    for layer in LAYERS:
        shown = round(layer['count'] / 2 * share)
        alpha = round(255 * layer['opacity'] * (0.4 + 0.6 * share))
        for _ in range(shown):
            # (each a little faster or slower, as on the canvas, by falling
            # one tile height more or less each loop)
            tiles = layer['tiles'] + rng.choice([-1, 0, 0, 1])
            length = layer['length'] * SCALE * (tiles / layer['tiles'])
            streaks.append(
                {
                    'x': rng.uniform(0, WIDTH),
                    'y': rng.uniform(0, HEIGHT),
                    'fall': tiles * HEIGHT,
                    'length': length,
                    'width': layer['width'] * SCALE,
                    'slant': layer['slant'],
                    'alpha': alpha,
                }
            )

    images = []
    for frame in range(frames):
        progress = frame / frames
        big = Image.new('RGBA', size, COLOR + (0,))
        # One layer per opacity, so overlapping streaks don't add up oddly
        for alpha in sorted({s['alpha'] for s in streaks}):
            layer = Image.new('L', size, 0)
            draw = ImageDraw.Draw(layer)
            for s in (s for s in streaks if s['alpha'] == alpha):
                y = (s['y'] + s['fall'] * progress) % HEIGHT
                # (drawn again a tile above and below, and across, so streaks
                # crossing the tile's edges carry on in the next tile)
                for dy in (-HEIGHT, 0, HEIGHT):
                    for dx in (-WIDTH, 0, WIDTH):
                        x0, y0 = s['x'] + dx, y + dy
                        x1, y1 = x0 - s['slant'] * s['length'], y0 + s['length']
                        if max(y0, y1) < 0 or min(y0, y1) > HEIGHT or max(x0, x1) < 0 or min(x0, x1) > WIDTH:
                            continue
                        draw.line(
                            [(x0 * SUPERSAMPLE, y0 * SUPERSAMPLE), (x1 * SUPERSAMPLE, y1 * SUPERSAMPLE)],
                            fill=alpha,
                            width=max(1, round(s['width'] * SUPERSAMPLE)),
                        )
            big.putalpha(ImageChops.lighter(big.getchannel('A'), layer))
        images.append(big.resize((WIDTH, HEIGHT), Image.Resampling.BOX))

    sheet = Image.new('RGBA', (WIDTH, HEIGHT * frames), COLOR + (0,))
    for frame, image in enumerate(images):
        sheet.paste(image, (0, HEIGHT * frame))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / f'rain-{name}.webp'
    sheet.save(path, lossless=False, quality=80, alpha_quality=90, method=6)
    print(f'{path.relative_to(ROOT)}: {path.stat().st_size // 1024} KB, {frames} frames')


if __name__ == '__main__':
    for name, intensity in LEVELS.items():
        make(name, intensity)
