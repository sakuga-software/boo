import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, settingsPath } from "./settings.js";

test("the merged, closed and draft pull requests are hidden by default", () => {
  assert.deepEqual([DEFAULT_SETTINGS.hideMerged, DEFAULT_SETTINGS.hideClosed, DEFAULT_SETTINGS.hideDrafts], [true, true, true]);
});

test("a stored value replaces its default, and an invalid or unknown value is ignored", () => {
  const settings = parseSettings({ hideMerged: false, checks: "no", other: true });
  assert.equal(settings.hideMerged, false);
  assert.equal(settings.checks, true);
  assert.equal("other" in settings, false);
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings([]), DEFAULT_SETTINGS);
});

test("a missing or broken file gives the defaults, and a saved file reads back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boo-"));
  assert.deepEqual(await loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  await writeFile(join(dir, "broken.json"), "{");
  assert.deepEqual(await loadSettings(join(dir, "broken.json")), DEFAULT_SETTINGS);
  const path = join(dir, "nested", "settings.json");
  await saveSettings({ ...DEFAULT_SETTINGS, compact: true }, path);
  assert.equal((await loadSettings(path)).compact, true);
});

test("the settings file follows XDG_CONFIG_HOME", () => {
  assert.equal(settingsPath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/boo/settings.json");
});
