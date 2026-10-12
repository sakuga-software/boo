import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parentFinder, placeStacks, type StackItem } from './stacks.js';

const item = (key: string, branch?: string, base = 'main', repo = 'web'): StackItem => ({ key, repo, branch, base });

test('a pull request on the default branch stays a root, in its place', () => {
  const placed = placeStacks([item('web#2', 'b'), item('web#1', 'a')]);
  assert.deepEqual(
    placed.map(({ key, depth, lead, size }) => ({ key, depth, lead, size })),
    [
      { key: 'web#2', depth: 0, lead: '', size: 1 },
      { key: 'web#1', depth: 0, lead: '', size: 1 },
    ],
  );
});

test('a chain shows under its bottom pull request, with its place in the stack', () => {
  const placed = placeStacks([
    item('web#3', 'c', 'b'),
    item('web#9', 'z'),
    item('web#2', 'b', 'a'),
    item('web#1', 'a'),
  ]);
  assert.deepEqual(
    placed.map(({ key, parent, depth, lead, trail, size, position }) => ({
      key,
      parent,
      depth,
      lead,
      trail,
      size,
      position,
    })),
    [
      { key: 'web#9', parent: undefined, depth: 0, lead: '', trail: '   ', size: 1, position: 1 },
      { key: 'web#1', parent: undefined, depth: 0, lead: '', trail: '│  ', size: 3, position: 1 },
      { key: 'web#2', parent: 'web#1', depth: 1, lead: '└─ ', trail: '   │  ', size: 3, position: 2 },
      { key: 'web#3', parent: 'web#2', depth: 2, lead: '   └─ ', trail: '         ', size: 3, position: 3 },
    ],
  );
});

test('a fork draws a branch for each child and gives no place in the stack', () => {
  const placed = placeStacks([
    item('web#1', 'a'),
    item('web#2', 'b', 'a'),
    item('web#3', 'c', 'a'),
    item('web#4', 'd', 'b'),
  ]);
  assert.deepEqual(
    placed.map(({ key, lead, trail, size, position }) => ({ key, lead, trail, size, position })),
    [
      { key: 'web#1', lead: '', trail: '│  ', size: 4, position: undefined },
      { key: 'web#2', lead: '├─ ', trail: '│  │  ', size: 4, position: undefined },
      { key: 'web#4', lead: '│  └─ ', trail: '│        ', size: 4, position: undefined },
      { key: 'web#3', lead: '└─ ', trail: '      ', size: 4, position: undefined },
    ],
  );
});

test('the same branch name in two repositories makes no stack', () => {
  const placed = placeStacks([item('web#1', 'a'), item('api#2', 'b', 'a', 'api')]);
  assert.deepEqual(
    placed.map(({ key, depth }) => ({ key, depth })),
    [
      { key: 'web#1', depth: 0 },
      { key: 'api#2', depth: 0 },
    ],
  );
});

test('a pull request from a fork is not the parent of a pull request on the same branch name', () => {
  const placed = placeStacks([{ ...item('web#1', 'feat'), fork: true }, item('web#2', 'b', 'feat')]);
  assert.deepEqual(
    placed.map(({ key, depth }) => ({ key, depth })),
    [
      { key: 'web#1', depth: 0 },
      { key: 'web#2', depth: 0 },
    ],
  );
});

test('a pull request on the default branch is on no pull request whose head is the default branch', () => {
  const release = { ...item('web#1', 'main', 'release'), defaultBranch: 'main' };
  const feature = { ...item('web#2', 'b', 'main'), defaultBranch: 'main' };
  assert.equal(parentFinder([release, feature])(feature), undefined);
  assert.deepEqual(
    placeStacks([release, feature]).map(({ key, depth }) => ({ key, depth })),
    [
      { key: 'web#1', depth: 0 },
      { key: 'web#2', depth: 0 },
    ],
  );
});

test('the parent of a pull request follows the rule of the tree', () => {
  const items = [
    { ...item('web#1', 'feat'), fork: true },
    item('web#3', 'a'),
    item('web#2', 'b', 'a'),
    item('web#4', 'c', 'feat'),
  ];
  const parentOf = parentFinder(items);
  assert.equal(parentOf(items[2]!)?.key, 'web#3');
  assert.equal(parentOf(items[3]!), undefined);
  assert.equal(parentOf(items[1]!), undefined);
});

test('a pull request on a branch that no listed pull request has, or not read yet, stays a root', () => {
  const placed = placeStacks([item('web#2', 'b', 'gone'), { key: 'web#3', repo: 'web' }, item('web#1', 'a')]);
  assert.deepEqual(
    placed.map(({ key, depth }) => ({ key, depth })),
    [
      { key: 'web#2', depth: 0 },
      { key: 'web#3', depth: 0 },
      { key: 'web#1', depth: 0 },
    ],
  );
});

test('two pull requests that merge into each other each appear once', () => {
  const placed = placeStacks([item('web#1', 'a', 'b'), item('web#2', 'b', 'a')]);
  assert.deepEqual(placed.map(({ key }) => key).toSorted(), ['web#1', 'web#2']);
  assert.equal(placed[0]!.depth, 0);
  assert.equal(placed[1]!.depth, 1);
});
