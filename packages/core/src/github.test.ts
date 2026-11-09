import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryOf, readPullRequestWith, type Graphql, type Variables } from './github.js';

const pr = {
  repo: 'sakuga-software/boo',
  number: 7,
  title: 'A change',
  url: 'https://github.com/sakuga-software/boo/pull/7',
};
const user = (login: string) => ({ login, __typename: 'User' });
const comment = (id: number) => ({
  databaseId: id,
  author: user('Mheaus'),
  body: `comment ${id}`,
  createdAt: '2026-11-09T10:00:00Z',
  updatedAt: '2026-11-09T10:00:00Z',
});
const context = (name: string) => ({ __typename: 'StatusContext', context: name, state: 'SUCCESS' });

const firstPage = {
  title: 'A change',
  state: 'OPEN',
  isDraft: false,
  merged: false,
  mergeStateStatus: 'CLEAN',
  headRefOid: 'head',
  headRefName: 'feature',
  baseRefName: 'main',
  isCrossRepository: false,
  author: user('Mheaus'),
  reviewRequests: { nodes: [] },
  reviews: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
  comments: { pageInfo: { hasPreviousPage: true, startCursor: 'c2' }, nodes: [comment(3)] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: true, endCursor: 'x1' }, nodes: [context('lint')] },
          },
        },
      },
    ],
  },
};

/** A transport that answers the first query, then one page of older comments and one page of newer checks. */
function fakeGraphql(): { graphql: Graphql; calls: Variables[] } {
  const calls: Variables[] = [];
  const graphql: Graphql = async (query, variables) => {
    calls.push(variables);
    if (!('cursor' in variables)) return { repository: { pullRequest: firstPage } };
    if (variables.cursor === 'c2')
      return {
        repository: {
          pullRequest: { page: { pageInfo: { hasPreviousPage: false }, nodes: [comment(1), comment(2)] } },
        },
      };
    assert.match(query, /contexts\(first: 100, after: \$cursor\)/);
    return {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: { statusCheckRollup: { page: { pageInfo: { hasNextPage: false }, nodes: [context('test')] } } },
              },
            ],
          },
        },
      },
    };
  };
  return { graphql, calls };
}

test('a read through the transport reads the older comments and the newer checks of each page', async () => {
  const { graphql, calls } = fakeGraphql();
  const { snapshot, node } = await readPullRequestWith(graphql, pr, {});
  assert.deepEqual(
    snapshot.comments.map((item) => item.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    snapshot.checks.map((check) => check.name),
    ['lint', 'test'],
  );
  assert.equal(snapshot.status, 'open');
  assert.equal(node.headRefOid, 'head');
  assert.deepEqual(calls[0], { owner: 'sakuga-software', name: 'boo', number: 7 });
  assert.equal(calls.length, 3);
});

test('a pull request that the transport does not give is not readable', async () => {
  await assert.rejects(
    readPullRequestWith(async () => ({ repository: { pullRequest: null } }), pr, {}),
    /sakuga-software\/boo#7 is not readable/,
  );
});

test('a transport that gives the same cursor twice stops the read', async () => {
  const graphql: Graphql = async (_query, variables) =>
    'cursor' in variables
      ? {
          repository: {
            pullRequest: { page: { pageInfo: { hasPreviousPage: true, startCursor: 'c2' }, nodes: [comment(1)] } },
          },
        }
      : {
          repository: { pullRequest: { ...firstPage, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } },
        };
  await assert.rejects(readPullRequestWith(graphql, pr, {}), /the same page cursor twice/);
});

test('the query asks for the threads and the files only when a read needs them', () => {
  assert.doesNotMatch(queryOf({}), /reviewThreads|files\(first/);
  assert.match(queryOf({ threads: true, files: true }), /reviewThreads\(first: 100\)[\s\S]*files\(first: 100\)/);
});
