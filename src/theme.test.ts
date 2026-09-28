import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "ink";
import { createElement } from "react";
import { Ghost, Header, HEADER_LINES, type Mood } from "./app.js";
import { backgroundFromColorFgBg, backgroundFromReply, detectBackground, GHOST_PALETTES, isBackgroundReply } from "./theme.js";

const hex = (color: string) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
const luminance = (color: string) => {
  const [red, green, blue] = hex(color).map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};
const DARK = "#1E1E2E";
const LIGHT = "#F4F4F5";

test("the reply of the terminal gives the background", () => {
  assert.equal(backgroundFromReply("\u001B]11;rgb:1e1e/1e1e/2e2e\u0007"), "dark");
  assert.equal(backgroundFromReply("\u001B]11;rgb:ffff/ffff/ffff\u001B\\"), "light");
  assert.equal(backgroundFromReply("\u001B]11;rgb:f4/f4/f5\u0007"), "light");
  assert.equal(backgroundFromReply(""), "unknown");
});

test("COLORFGBG gives the background from its last number", () => {
  assert.equal(backgroundFromColorFgBg("15;0"), "dark");
  assert.equal(backgroundFromColorFgBg("0;15"), "light");
  assert.equal(backgroundFromColorFgBg("0;default;7"), "light");
  assert.equal(backgroundFromColorFgBg(undefined), "unknown");
});

test("a late reply of the terminal is not a key press", () => {
  assert.ok(isBackgroundReply("\u001B]11;rgb:1e1e/1e1e/2e2e\u0007"));
  assert.ok(isBackgroundReply("]11;rgb:1e1e/1e1e/2e2e"));
  assert.ok(isBackgroundReply("2e2e/2e2e\u0007"));
  assert.ok(isBackgroundReply("2e\u0007"));
  for (const key of ["r", "a", "f", "b", "q", "j"]) assert.ok(!isBackgroundReply(key), key);
});

test("a reply cut by the timeout does not go back to stdin as keys", async () => {
  const { stdin, unshifted } = fakeStdin(["j", "\u001B]11;rgb:1e1e/1e"]);
  assert.equal(await detectBackground(stdin, { write: () => {} }, {}, 20), "unknown");
  assert.deepEqual(unshifted, ["j"]);
});

function fakeStdin(chunks: string[], delayMs = 1) {
  const pending = [...chunks];
  const unshifted: string[] = [];
  let listener: (() => void) | undefined;
  const stdin = {
    isTTY: true,
    setRawMode: () => {},
    on: (_: "readable", next: () => void) => {
      listener = next;
      if (pending.length > 0) setTimeout(() => listener?.(), delayMs);
    },
    off: () => {
      listener = undefined;
    },
    read: () => pending.shift() ?? null,
    unshift: (chunk: string) => unshifted.push(chunk),
  };
  return { stdin, unshifted };
}

test("a terminal with no reply falls back on COLORFGBG after the timeout", async () => {
  const { stdin } = fakeStdin([]);
  assert.equal(await detectBackground(stdin, { write: () => {} }, { COLORFGBG: "0;15" }, 10), "light");
});

test("the reply wins over COLORFGBG, and the keys typed during the wait go back to stdin", async () => {
  const { stdin, unshifted } = fakeStdin(["j", "\u001B]11;rgb:0000/0000/0000\u0007", "k"]);
  assert.equal(await detectBackground(stdin, { write: () => {} }, { COLORFGBG: "0;15" }, 100), "dark");
  assert.deepEqual(unshifted, ["jk"]);
});

test("the keys typed during a wait with no reply go back to stdin", async () => {
  const { stdin, unshifted } = fakeStdin(["q"]);
  assert.equal(await detectBackground(stdin, { write: () => {} }, {}, 20), "unknown");
  assert.deepEqual(unshifted, ["q"]);
});

test("each palette reads on its background, and the neutral one on both", () => {
  for (const color of Object.values(GHOST_PALETTES.dark)) assert.ok(contrast(color, DARK) >= 4.4, `${color} on dark`);
  for (const color of Object.values(GHOST_PALETTES.light)) assert.ok(contrast(color, LIGHT) >= 4.4, `${color} on light`);
  for (const color of Object.values(GHOST_PALETTES.unknown)) {
    assert.ok(contrast(color, DARK) >= 3.5 && contrast(color, LIGHT) >= 3.5, `${color} on both`);
  }
});

test("each mood draws its face on a ghost of HEADER_LINES lines", () => {
  const faces: Record<Mood, string> = { checking: "ò v ó", sleeping: "- ᴗ -", done: "^ v ^", failed: "x ~ x" };
  for (const [mood, face] of Object.entries(faces) as [Mood, string][]) {
    const lines = renderToString(createElement(Ghost, { mood })).split("\n");
    assert.equal(lines.length, HEADER_LINES, mood);
    assert.match(lines[0]!, /wWw/);
    assert.ok(lines[2]!.includes(face), `${mood}: ${lines[2]}`);
  }
});

test("the header is as tall as HEADER_LINES, the text beside the head", () => {
  const options = { org: "acme", author: "@me", watch: true, dryRun: false, interactive: true };
  const output = renderToString(createElement(Header, { options, mood: "checking", now: new Date(), nextCheckAt: new Date(Date.now() + 5_000) }));
  const lines = output.split("\n");
  assert.equal(lines.length, HEADER_LINES);
  assert.match(lines[1]!, /boo · open pull requests/);
  assert.match(lines[3]!, /next check in/);
});
