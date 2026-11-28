import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePullUrl, groupChecks, manualChecks, handoff, type Review } from '../src/review.ts';
import { GitHub, repositoryPath } from '../server/github.ts';

const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const passing = { id: 1, name: 'Tests', source: 'GitHub Actions', state: 'Passed', sha, url: null };
const base: Review = {
  repository: 'owner/repo', number: 4, title: 'Feature', state: 'Open', sha,
  headRef: 'feature', baseRef: 'main', contextDigest: 'e'.repeat(64), url: 'https://github.com/owner/repo/pull/4', intent: 'Add the feature',
  checks: [passing], checksDigest: 'c'.repeat(64), evidenceSources: { checkRuns: true, commitStatuses: true }, linkedRuns: [], manual: [], issues: [], required: null, observedAt: '2026-11-22T10:00:00Z', attestationId: null, trailerAvailable: true,
};

test('only accepts canonical GitHub pull request locations', () => {
  assert.deepEqual(parsePullUrl('https://github.com/owner/repo/pull/42?x=7'), { repository: 'owner/repo', number: 42 });
  for (const url of ['https://github.com.evil.test/owner/repo/pull/42', 'https://user@github.com/owner/repo/pull/42', 'https://github.com/owner/repo/pull/0', 'https://github.com/owner/repo/pull/9007199254740992', 'file:///owner/repo/pull/42']) {
    assert.equal(parsePullUrl(url), null);
  }
  assert.throws(() => repositoryPath('owner/..'));
});

test('groups reruns by provider and check while retaining only the selected commit', () => {
  const groups = groupChecks([
    passing,
    { ...passing, id: 2, state: 'Running' },
    { ...passing, id: 3, sha: oldSha },
    { ...passing, id: 4, source: 'Another app' },
  ], sha);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(check => check.id), [2, 1]);
  assert.deepEqual(groups[1].map(check => check.id), [4]);
});

test('extracts unchecked items only from verification sections outside comments and code', () => {
  const body = '## Plan\n- [ ] Build it\n## Verification\n- [ ] Run media smoke test\n<!--\n- [ ] hidden\n-->\n```md\n- [ ] code\n```\n- [x] Build\n### Evidence\n- [ ] Check artifact\n## Other\n- [ ] unrelated';
  assert.deepEqual(manualChecks(body), ['Run media smoke test', 'Check artifact']);
});

test('handoff records current, stale and unavailable evidence without claiming approval', () => {
  const output = handoff({ ...base, manual: ['Manual smoke test'], issues: ['GitHub statuses unavailable'],
    required: [{ name: 'Integration', appId: null }],
    attestationId: 'c'.repeat(32), linkedRuns: [{ sha: oldSha, name: 'Earlier CI', url: 'https://github.com/owner/repo/actions/runs/12', state: 'Passed' }],
  });
  assert.match(output, new RegExp(sha));
  assert.match(output, /Manual smoke test/);
  assert.match(output, /Different commit/);
  assert.match(output, /Integration.*Missing/);
  assert.match(output, /statuses unavailable/);
  assert.match(output, /unverified/i);
  assert.doesNotMatch(output, /ready to merge/i);
});

test('GitHub pagination preserves page order and uses a fixed HTTPS origin', async () => {
  const seen: string[] = [];
  const client = new GitHub(async input => {
    const url = new URL(String(input));
    seen.push(url.toString());
    const page = url.searchParams.get('page');
    return Response.json(page === '1' ? ['first'] : ['second'], { headers: page === '1'
      ? { link: '<https://other.example/anything>; rel="next"' } : {} });
  });
  assert.deepEqual(await client.pages<string>('/repos/owner/repo/pulls', 'state=all'), ['first', 'second']);
  assert.ok(seen.every(url => url.startsWith('https://api.github.com/repos/')));
  await assert.rejects(client.get('//evil.example/data'));
});

test('ForgeCore alone determines signature validity, with PR branch scope checked locally', async () => {
  const { ForgeCore } = await import('../server/forgecore.ts');
  const id = 'c'.repeat(32);
  let requests = 0;
  const client = new ForgeCore('http://127.0.0.1:8091', 'test-token', async (input, init) => {
    requests += 1;
    assert.equal(String(input), 'http://127.0.0.1:8091/api/v1/gate/verify');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
    return Response.json({ valid: true, recorded: false, attestation_id: id });
  });
  const pr = { repository: 'owner/repo', headRef: 'feature', attestationId: id };
  const receipt = { attestation_id: id, repository: 'OWNER/Repo', target_ref: 'feature', decision: 'PASS' };
  const verified = await client.verify(receipt, pr);
  assert.deepEqual(verified, { id, valid: true, recorded: false, trailerMatched: true, decision: 'PASS', repository: 'owner/repo', branch: 'feature' });
  await assert.rejects(client.verify({ ...receipt, target_ref: 'main' }, pr), /branch/);
  await assert.rejects(client.verify({ ...receipt, attestation_id: 'd'.repeat(32) }, pr), /trailer/);
  assert.equal(requests, 1);
  const report = handoff({ ...base, receiptVerification: verified });
  assert.match(report, /Receipt scope: owner\/repo · feature/);
  assert.match(report, /Gem-Gate trailer matched: yes/);
});

test('ForgeCore rejects malformed responses and insecure remote origins', async () => {
  const { ForgeCore } = await import('../server/forgecore.ts');
  const id = 'c'.repeat(32);
  assert.throws(() => new ForgeCore('http://example.test', 'test-token'), /HTTPS/);
  const client = new ForgeCore('https://example.test', 'test-token', async () =>
    Response.json({ valid: 'true', recorded: true, attestation_id: id }));
  await assert.rejects(client.verify(
    { attestation_id: id, repository: 'owner/repo', target_ref: 'branch', decision: 'PASS' },
    { repository: 'owner/repo', headRef: 'branch', attestationId: null },
  ), /unexpected/);
});

test('a head or base change invalidates a review snapshot', async () => {
  const { revisionState } = await import('../src/review.ts');
  const snapshot = { sha, baseRef: 'main', contextDigest: 'e'.repeat(64) };
  assert.equal(revisionState(snapshot, { ...snapshot }), 'current');
  assert.equal(revisionState(snapshot, { ...snapshot, sha: oldSha }), 'stale');
  assert.equal(revisionState(snapshot, { ...snapshot, baseRef: 'release' }), 'stale');
});

test('required check evidence distinguishes partial coverage, missing, and latest failure', async () => {
  const { requiredCheckEvidence } = await import('../src/review.ts');
  const required = [{ name: 'Integration', appId: null }, { name: 'Tests', appId: null }];
  const checks = [passing, { ...passing, id: 2, state: 'Failed' }];
  assert.deepEqual(requiredCheckEvidence({ ...base, required, checks }).map(item => item.state), ['Missing', 'Failed']);
  const partial: Review = { ...base, required, checks, evidenceSources: { checkRuns: true, commitStatuses: false } };
  assert.deepEqual(requiredCheckEvidence(partial).map(item => item.state), ['Unavailable', 'Failed']);
  assert.doesNotMatch(handoff(partial), /Integration.*Missing/);
});

test('checks scoped to a GitHub App cannot be inferred from an unidentified matching status', async () => {
  const { requiredCheckEvidence } = await import('../src/review.ts');
  const required = [{ name: 'Tests', appId: 12 }];
  const evidence = requiredCheckEvidence({ ...base, required, checks: [{ ...passing, source: 'GitHub status' }] });
  assert.equal(evidence[0].state, 'Unavailable');
});

test('PR checks use the head repository for receipts and reject conflicting trailers', async () => {
  const { receiptScope, loadRevision } = await import('../server/github.ts');
  const id = 'c'.repeat(32);
  const conflicting = 'd'.repeat(32);
  let message = `Change\n\nGem-Gate: ${id}`;
  const client = new GitHub(async input => {
    const path = new URL(String(input)).pathname;
    assert.ok(path.startsWith('/repos/owner/repo/'));
    if (path.endsWith('/pulls/4')) {
      return Response.json({ head: { sha, ref: 'feature', repo: { full_name: 'fork/repo' } }, base: { ref: 'main' } });
    }
    assert.ok(path.endsWith(`/commits/${sha}`));
    return Response.json({ commit: { message } });
  });
  const revision = await loadRevision(client, 'owner/repo', 4);
  assert.equal(revision.sha, sha);
  assert.equal(revision.baseRef, 'main');
  assert.match(revision.contextDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await receiptScope(client, 'owner/repo', 4, sha), { repository: 'fork/repo', headRef: 'feature', attestationId: id });
  await assert.rejects(receiptScope(client, 'owner/repo', 4, oldSha), /head changed/);
  message += `\nGem-Gate: ${conflicting}`;
  await assert.rejects(receiptScope(client, 'owner/repo', 4, sha), /ambiguous/);
});

test('review collection reports unavailable statuses and rejects changed verification prose', async () => {
  const { loadReview } = await import('../server/github.ts');
  let reads = 0;
  let editDuringCollection = false;
  const client = new GitHub(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/pulls/4')) {
      reads++;
      return Response.json({
        number: 4, title: 'Feature', state: 'open', draft: false,
        body: editDuringCollection && reads % 2 === 0 ? '## Summary\nChanged intent' : '## Summary\nOriginal intent',
        head: { sha, ref: 'feature' }, base: { ref: 'main' },
      });
    }
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    if (path.endsWith('/statuses')) return Response.json({ message: 'Unavailable' }, { status: 503 });
    if (path.endsWith('/rules/branches/main')) return Response.json([{
      type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Integration' }] },
    }]);
    if (path.endsWith('/branches/main')) return Response.json({ protected: false });
    assert.ok(path.endsWith(`/commits/${sha}`));
    return Response.json({ commit: { message: 'Feature' } });
  });
  const review = await loadReview(client, 'owner/repo', 4);
  assert.deepEqual(review.evidenceSources, { checkRuns: true, commitStatuses: false });
  assert.match(handoff(review), /Required check Integration — Unavailable/);
  assert.match(handoff(review), /GitHub commit statuses unavailable/);

  editDuringCollection = true;
  await assert.rejects(loadReview(client, 'owner/repo', 4), /changed while loading/);
});

test('a description edit invalidates a handoff even when the head and base stay the same', async () => {
  const { loadRevision } = await import('../server/github.ts');
  const { revisionState } = await import('../src/review.ts');
  const pull = {
    title: 'Feature', state: 'open', draft: false, body: '## Verification\n- [ ] Run smoke test',
    head: { sha, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' },
    updated_at: '2026-11-22T12:00:00Z',
  };
  const client = new GitHub(async () => Response.json(pull));
  const before = await loadRevision(client, 'owner/repo', 4);

  pull.updated_at = '2026-11-22T12:01:00Z';
  assert.equal(revisionState(before, await loadRevision(client, 'owner/repo', 4)), 'current');

  pull.body = '## Verification\n- [x] Run smoke test';
  const after = await loadRevision(client, 'owner/repo', 4);
  assert.equal(after.sha, before.sha);
  assert.equal(after.baseRef, before.baseRef);
  assert.equal(revisionState(before, after), 'stale');
});

test('export recheck detects check changes and reruns on the same PR head', async () => {
  const { loadExportRevision, loadReview } = await import('../server/github.ts');
  const pull = {
    title: 'Feature', state: 'open', draft: false, body: '',
    head: { sha, ref: 'feature' }, base: { ref: 'main' },
  };
  const tests = { id: 1, name: 'Tests', head_sha: sha, status: 'completed', conclusion: 'success', html_url: null };
  const lint = { ...tests, id: 2, name: 'Lint' };
  let runs = [tests, lint];
  let statusesUnavailable = false;
  let headChangedDuringCheck = false;
  const client = new GitHub(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/pulls/4')) return Response.json(pull);
    if (path.endsWith('/check-runs')) {
      if (headChangedDuringCheck) pull.head = { ...pull.head, sha: oldSha };
      return Response.json({ check_runs: runs });
    }
    if (path.endsWith('/statuses')) return statusesUnavailable
      ? Response.json({}, { status: 503 }) : Response.json([]);
    if (path.endsWith('/rules/branches/main')) return Response.json([]);
    if (path.endsWith('/branches/main')) return Response.json({ protected: false });
    assert.ok(path.endsWith(`/commits/${sha}`));
    return Response.json({ commit: { message: 'Feature' } });
  });
  const observed = await loadReview(client, 'owner/repo', 4);
  assert.match(observed.checksDigest ?? '', /^[0-9a-f]{64}$/);
  runs = [lint, tests];
  assert.equal((await loadExportRevision(client, 'owner/repo', 4)).checksDigest, observed.checksDigest);
  runs = [lint, { ...tests, conclusion: 'failure' }];
  assert.notEqual((await loadExportRevision(client, 'owner/repo', 4)).checksDigest, observed.checksDigest);
  runs = [lint, tests, { ...tests, id: 3 }];
  assert.notEqual((await loadExportRevision(client, 'owner/repo', 4)).checksDigest, observed.checksDigest);
  statusesUnavailable = true;
  const partial = await loadExportRevision(client, 'owner/repo', 4);
  assert.equal(partial.checksDigest, null);
  assert.match(partial.checkIssues.join(' '), /commit statuses unavailable/);
  headChangedDuringCheck = true;
  await assert.rejects(loadExportRevision(client, 'owner/repo', 4), /changed while checking/);
});

test('release recheck reads paginated branch rules independently of current check results', async () => {
  const { loadReleaseRevision } = await import('../server/github.ts');
  const rulesPath = '/repos/owner/repo/rules/branches/main';
  const revision = { sha, ref: 'feature' };
  let failPolicy = false;
  let policyReads = 0;
  const client = new GitHub(async input => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/pulls/4')) return Response.json({ title: 'Feature', state: 'open', head: revision, base: { ref: 'main' } });
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    if (path.endsWith('/statuses')) return Response.json([]);
    if (path.endsWith('/branches/main') && path !== rulesPath) return Response.json({ protected: false });
    assert.equal(path, rulesPath);
    policyReads++;
    if (failPolicy) return Response.json({}, { status: 403 });
    if (url.searchParams.get('page') === '1') return Response.json([], { headers: { link: '<https://api.github.com>; rel="next"' } });
    return Response.json([{ type: 'required_status_checks', parameters: {
      required_status_checks: [{ context: 'Integration', integration_id: 10 }], strict_required_status_checks_policy: true,
    } }]);
  });
  const available = await loadReleaseRevision(client, 'owner/repo', 4);
  assert.equal(policyReads, 2);
  assert.deepEqual(available.branchCheckPolicy, {
    requirements: [{ name: 'Integration', appId: 10 }], requireUpToDate: true,
  });
  failPolicy = true;
  const partial = await loadReleaseRevision(client, 'owner/repo', 4);
  assert.equal(partial.branchCheckPolicy, null);
  assert.match(partial.branchCheckPolicyIssue ?? '', /requirements unavailable/);
  assert.equal(partial.checksDigest, available.checksDigest);
});
