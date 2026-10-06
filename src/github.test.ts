import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSearches } from "./github.js";

const result = (url: string, updatedAt: string, isDraft = false) => ({ url, updatedAt, isDraft });

test("the searches of several authors give one list: newest first, each pull request once, no draft", () => {
  const merged = mergeSearches([
    [result("a/1", "2026-10-01T10:00:00Z"), result("a/2", "2026-10-03T10:00:00Z", true)],
    [result("a/3", "2026-10-05T10:00:00Z"), result("a/1", "2026-10-01T10:00:00Z")],
  ]);
  assert.deepEqual(merged.map((pull) => pull.url), ["a/3", "a/1"]);
});
