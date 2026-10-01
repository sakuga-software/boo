import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, actionForKey, BOT_BAR_WIDTH, COPILOT, moveSelection, refusal, requestText, reselect } from "./actions.js";

test("only merge uses m, the last byte of a mouse report, and it always asks for a confirmation", () => {
  const onM = ACTIONS.filter((action) => action.key.toLowerCase() === "m");
  assert.deepEqual(onM.map((action) => action.label), ["merge"]);
  assert.equal(onM[0]!.merge, true);
});

test("each key maps to one action", () => {
  assert.equal(new Set(ACTIONS.map((action) => action.key)).size, ACTIONS.length);
  assert.equal(actionForKey("a")?.request?.command, "approve");
  assert.equal(actionForKey("x"), undefined);
});

test("a bot with a mention gets a bare command, and Copilot gets a review request", () => {
  assert.equal(requestText(actionForKey("f")!.request!), "@coderabbitai full review");
  assert.equal(requestText(actionForKey("g")!.request!), "@greptileai review");
  assert.equal(requestText(actionForKey("c")!.request!), "review request to Copilot");
  assert.equal(COPILOT.mention, undefined);
});

test("a terminal of 90 columns shows the bot set without its labels", () => {
  assert.ok(90 - 2 < BOT_BAR_WIDTH);
});

test("the keys that the list, the prompt and the panel use are free", () => {
  const taken = ["j", "k", "q", "h", ",", " ", "y", "n"];
  assert.deepEqual(ACTIONS.filter((action) => taken.includes(action.key)), []);
});

test("open stays available on a merged pull request, a command does not", () => {
  const open = actionForKey("o")!;
  const approve = actionForKey("a")!;
  assert.equal(refusal(open, { left: true, dryRun: false }), null);
  assert.match(refusal(approve, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(approve, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(approve, { left: false, dryRun: false }), null);
});

test("a bot command needs the bot on the pull request, open, merge and Copilot do not", () => {
  const target = { left: false, dryRun: false, reviewers: [{ login: "greptile-apps[bot]" }] };
  assert.match(refusal(actionForKey("r")!, target)!, /CodeRabbit does not review/);
  assert.equal(refusal(actionForKey("g")!, target), null);
  assert.equal(refusal(actionForKey("c")!, target), null);
  assert.equal(refusal(actionForKey("o")!, target), null);
  assert.equal(refusal(actionForKey("m")!, target), null);
});

test("PR-Agent takes a slash command, on a pull request where an install of it posted a review", () => {
  assert.equal(requestText(actionForKey("p")!.request!), "/review");
  assert.equal(requestText(actionForKey("i")!.request!), "/improve");
  const target = { left: false, dryRun: false, reviewers: [{ login: "sakuga-review[bot]", prAgent: true }] };
  assert.equal(refusal(actionForKey("p")!, target), null);
  assert.match(refusal(actionForKey("i")!, { ...target, reviewers: [{ login: "sakuga-review[bot]" }] })!, /PR-Agent does not review/);
});

test("a bot command waits for no reviewer list before the first fetch", () => {
  assert.equal(refusal(actionForKey("g")!, { left: false, dryRun: false }), null);
});

test("the selection follows the key and stops at the ends", () => {
  const keys = ["a#1", "a#2", "a#3"];
  assert.equal(moveSelection(keys, undefined, 1), "a#1");
  assert.equal(moveSelection(keys, "a#2", 1), "a#3");
  assert.equal(moveSelection(keys, "a#3", 1), "a#3");
  assert.equal(moveSelection(keys, "a#1", -1), "a#1");
  assert.equal(moveSelection(["a#0", ...keys], "a#2", 1), "a#3");
  assert.equal(moveSelection([], "a#1", 1), undefined);
});

test("a visible selection stays", () => {
  assert.equal(reselect(["a", "b", "c"], ["a", "c"], "c"), "c");
});

test("a hidden selection goes to the next visible row", () => {
  assert.equal(reselect(["a", "b", "c", "d"], ["a", "d"], "b"), "d");
});

test("a hidden selection at the end goes to the previous visible row", () => {
  assert.equal(reselect(["a", "b", "c"], ["a"], "c"), "a");
});

test("no visible row gives no selection", () => {
  assert.equal(reselect(["a"], [], "a"), undefined);
  assert.equal(reselect(["a", "b"], ["b"], undefined), "b");
});

test("merge is refused on a pull request that is no longer open, and in a dry run", () => {
  const merge = actionForKey("m")!;
  assert.match(refusal(merge, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(merge, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(merge, { left: false, dryRun: false }), null);
});
