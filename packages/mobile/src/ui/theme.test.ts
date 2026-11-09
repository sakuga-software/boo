import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PALETTES } from './theme';
import { formatAgo, formatTime } from './time';

const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

test('each tone and the text give 4.5:1 or more on the background and on the surface of their scheme', () => {
  for (const [scheme, palette] of Object.entries(PALETTES))
    for (const [name, color] of Object.entries({ ...palette.tones, text: palette.text, muted: palette.muted }))
      for (const ground of [palette.background, palette.surface])
        assert.ok(contrast(color, ground) >= 4.5, `${scheme} ${name} ${color} on ${ground}`);
});

test('the times read as in the terminal', () => {
  assert.equal(formatTime(new Date(2026, 10, 9, 9, 5)), '09:05');
  const now = new Date(2026, 10, 9, 12, 0);
  const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  assert.deepEqual(
    [0, 12, 90, 60 * 30, -5].map((minutes) => formatAgo(now, before(minutes))),
    ['just now', '12 min ago', '2 h ago', '1 d ago', 'just now'],
  );
});
