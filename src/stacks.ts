export interface StackItem {
  key: string;
  repo: string;
  /** The head branch of the pull request. Unknown until the tool reads the pull request. */
  branch?: string | undefined;
  /** True if the head branch is in a fork. A fork branch is not a branch of `repo`. */
  fork?: boolean | undefined;
  /** The branch that the pull request merges into. */
  base?: string | undefined;
}

export interface Placement {
  key: string;
  /** 0 for a pull request on no other listed pull request. */
  depth: number;
  /** The key of the listed pull request that this one merges into. */
  parent?: string;
  /** The tree lines before the icon on the first line of the row. */
  lead: string;
  /** The tree lines before the icon on the other lines of the row. */
  trail: string;
  /** The count of pull requests in the stack of this one. 1 if it is alone. */
  size: number;
  /** The place in a stack with no fork: 1 is the bottom. Undefined if the stack forks. */
  position?: number;
}

const BRANCH = '├─ ';
const LAST_BRANCH = '└─ ';
const PIPE = '│  ';
const BLANK = '   ';

/**
 * Puts each pull request after the pull request that it merges into, as a tree. A pull request
 * merges into another if their repository is the same and its base is the head branch of the other.
 * The roots keep their order, and so do the children of one parent. The result has all the items.
 */
export function placeStacks(items: readonly StackItem[]): Placement[] {
  const byBranch = new Map<string, StackItem>();
  for (const item of items) {
    const id = item.branch && !item.fork && `${item.repo}:${item.branch}`;
    if (id && !byBranch.has(id)) byBranch.set(id, item);
  }
  const parentOf = (item: StackItem) => {
    const parent = item.base ? byBranch.get(`${item.repo}:${item.base}`) : undefined;
    return parent && parent !== item ? parent : undefined;
  };
  const children = new Map<string, StackItem[]>();
  for (const item of items) {
    const parent = parentOf(item);
    if (parent) children.set(parent.key, [...(children.get(parent.key) ?? []), item]);
  }

  const placed: Placement[] = [];
  const seen = new Set<string>();

  function size(item: StackItem, visiting = new Set<string>()): number {
    visiting.add(item.key);
    const below = (children.get(item.key) ?? []).filter((child) => !visiting.has(child.key));
    return 1 + below.reduce((total, child) => total + size(child, visiting), 0);
  }

  function forks(item: StackItem, visiting = new Set<string>()): boolean {
    visiting.add(item.key);
    const below = (children.get(item.key) ?? []).filter((child) => !visiting.has(child.key));
    return below.length > 1 || below.some((child) => forks(child, visiting));
  }

  function visit(
    item: StackItem,
    depth: number,
    lines: string,
    last: boolean,
    stack: { size: number; linear: boolean },
  ) {
    seen.add(item.key);
    const below = (children.get(item.key) ?? []).filter((child) => !seen.has(child.key));
    const parent = depth > 0 ? parentOf(item) : undefined;
    placed.push({
      key: item.key,
      depth,
      ...(parent && { parent: parent.key }),
      lead: depth > 0 ? lines + (last ? LAST_BRANCH : BRANCH) : '',
      trail: (depth > 0 ? lines + (last ? BLANK : PIPE) : '') + (below.length > 0 ? PIPE : BLANK),
      size: stack.size,
      ...(stack.linear && { position: depth + 1 }),
    });
    const next = depth > 0 ? lines + (last ? BLANK : PIPE) : '';
    below.forEach((child, index) => {
      if (!seen.has(child.key)) visit(child, depth + 1, next, index === below.length - 1, stack);
    });
  }

  const start = (item: StackItem) => visit(item, 0, '', true, { size: size(item), linear: !forks(item) });
  for (const item of items) if (!parentOf(item)) start(item);
  // Two pull requests that merge into each other have no root. They start a tree each.
  for (const item of items) if (!seen.has(item.key)) start(item);
  return placed;
}
