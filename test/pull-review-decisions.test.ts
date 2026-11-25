import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../server/github.ts';
import { loadPullReviewDecisions } from '../server/pull-review-decisions.ts';

const sha = 'a'.repeat(40);
const olderSha = 'b'.repeat(40);
const submittedAt = '2026-11-23T08:00:00Z';
const approval = {
  id: 4, state: 'APPROVED', user: { login: 'reviewer' }, commit_id: sha, submitted_at: submittedAt,
  body: 'Do not copy private review commentary.', author_association: 'MEMBER',
};
const nextPage = { link: '<https://api.github.com/repos/owner/repo/pulls/7/reviews?page=2>; rel="next"' };

test('collects submitted decision history for the exact GitHub head across pages', async () => {
  const paths: string[] = [];
  const github = new GitHub(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.method ?? 'GET', 'GET');
    paths.push(url.pathname + url.search);
    if (url.searchParams.get('page') === '1') {
      return Response.json([
        { ...approval, id: 1, commit_id: olderSha },
        { ...approval, id: 2, state: 'COMMENTED' },
        { ...approval, id: 3, state: 'PENDING', submitted_at: undefined },
        approval,
      ], { headers: nextPage });
    }
    return Response.json([
      { ...approval, id: 5, state: 'CHANGES_REQUESTED' },
      { ...approval, id: 6, state: 'DISMISSED', user: null },
      { ...approval, id: 7, commit_id: null },
    ]);
  });
  const result = await loadPullReviewDecisions(github, 'owner/repo', 7, sha);
  assert.equal(result.state, 'observed');
  assert.equal(result.observedAt, new Date(result.observedAt).toISOString());
  assert.deepEqual(result.decisions, [
    { id: 4, login: 'reviewer', state: 'APPROVED', submittedAt: '2026-11-23T08:00:00.000Z' },
    { id: 5, login: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-23T08:00:00.000Z' },
    { id: 6, login: null, state: 'DISMISSED', submittedAt: '2026-11-23T08:00:00.000Z' },
  ]);
  assert.deepEqual(paths, [
    '/repos/owner/repo/pulls/7/reviews?per_page=100&page=1',
    '/repos/owner/repo/pulls/7/reviews?per_page=100&page=2',
  ]);
});

test('distinguishes a successful empty observation from a failed or malformed observation', async () => {
  const empty = await loadPullReviewDecisions(new GitHub(async () => Response.json([])), 'owner/repo', 7, sha);
  assert.equal(empty.state, 'observed');
  assert.deepEqual(empty.decisions, []);

  const review = { ...approval, id: 5 };
  const invalid = [null, { ...review, commit_id: undefined }, { ...review, id: 0 },
    { ...review, submitted_at: 'yesterday' }, { ...review, submitted_at: '2026-02-30T08:00:00Z' },
    { ...review, submitted_at: '2026-11-23T24:00:00Z' }, { ...review, state: 'UNRECOGNIZED' },
    { ...review, user: {} }, { ...review, user: 'reviewer' }];
  for (const row of invalid) {
    const github = new GitHub(async () => Response.json([approval, row]));
    assert.deepEqual(await loadPullReviewDecisions(github, 'owner/repo', 7, sha), { state: 'unavailable' });
  }
  const partial = new GitHub(async input => new URL(String(input)).searchParams.get('page') === '1'
    ? Response.json([approval], { headers: nextPage })
    : Response.json({ message: 'Forbidden' }, { status: 403 }));
  assert.deepEqual(await loadPullReviewDecisions(partial, 'owner/repo', 7, sha), { state: 'unavailable' });

  const overlappingPages = new GitHub(async input => Response.json([approval], {
    headers: new URL(String(input)).searchParams.get('page') === '1' ? nextPage : undefined,
  }));
  assert.deepEqual(await loadPullReviewDecisions(overlappingPages, 'owner/repo', 7, sha), { state: 'unavailable' });
});
