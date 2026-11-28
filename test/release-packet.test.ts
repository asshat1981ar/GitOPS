import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Review } from '../src/review.ts';
import { collectReleasePacket, verifyReleasePacket } from '../server/release-packet.ts';
import { GitHubError } from '../server/github.ts';

const urls = ['https://github.com/example/auto/pull/53', 'https://github.com/example/gem/pull/11'];
const sha = 'a'.repeat(40);
const checksDigest = createHash('sha256').update(
  JSON.stringify([JSON.stringify([2, 'Tests', 'GitHub Actions', null, 'Passed', sha, null])]),
).digest('hex');
const time = '2026-11-22T22:00:00.000Z';
const revision = { sha, baseRef: 'main', contextDigest: 'c'.repeat(64) };
const review = (repository: string, number: number): Review => ({
  repository, number, ...revision, checksDigest, title: 'Pilot', state: 'Open', headRef: 'feature',
  url: `https://github.com/${repository}/pull/${number}`, intent: 'Verify the artifact',
  checks: [{ id: 2, name: 'Tests', source: 'GitHub Actions', state: 'Passed', sha, url: null }],
  evidenceSources: { checkRuns: true, commitStatuses: true }, linkedRuns: [], manual: ['Review artifact'],
  issues: [], required: null, observedAt: time, attestationId: 'd'.repeat(32), trailerAvailable: true,
});
const source = {
  review: async (repository: string, number: number) => review(repository, number),
  recheck: async () => ({ ...revision, checksDigest, checkIssues: [] }),
};
const clock = () => new Date(time);

test('records exact-head decision history before rechecking and keeps failed reads distinct', async () => {
  const events: string[] = [];
  const history = { state: 'observed', observedAt: time, decisions: [
    { id: 42, login: 'reviewer', state: 'APPROVED', submittedAt: time },
  ] } as const;
  const saved = await collectReleasePacket('Review history', urls, {
    ...source,
    reviewDecisions: async (repo, number, head) => {
      assert.equal(head, sha);
      events.push(`read ${repo}#${number}`);
      if (number === 11) throw new Error('temporary upstream failure');
      return { ...history, decisions: [...history.decisions] };
    },
    recheck: async repo => {
      events.push(`recheck ${repo}`);
      return source.recheck();
    },
  }, clock);
  assert.deepEqual(saved.packet.entries.map(entry => entry.snapshot?.reviewDecisions),
    [history, { state: 'unavailable' }]);
  assert.ok(events.indexOf('read example/auto#53') < events.indexOf('recheck example/auto'));
  assert.ok(events.indexOf('read example/gem#11') < events.indexOf('recheck example/gem'));
  assert.equal(saved.packet.coverage.humanApprovals, 'not-collected');
  assert.ok(verifyReleasePacket(saved, saved.digest));
  const { recheckReleasePacket } = await import('../server/release-packet.ts');
  const report = await recheckReleasePacket(saved, saved.digest, source.recheck, clock);
  assert.ok(!JSON.stringify(report).includes('reviewDecisions'));
  const legacy = await collectReleasePacket('Legacy', urls, source, clock);
  assert.ok(!('reviewDecisions' in legacy.packet.entries[0].snapshot!));
  const legacyReport = await recheckReleasePacket(legacy, legacy.digest, async (_repo, _number, reviewSha) => {
    assert.equal(reviewSha, undefined);
    return source.recheck();
  }, clock);
  assert.deepEqual(legacyReport.entries.map(entry => entry.reviewHistory), ['not-recorded', 'not-recorded']);
});

test('compares review IDs and states only on the recorded head', async () => {
  const { recheckReleasePacket } = await import('../server/release-packet.ts');
  const first = { id: 42, login: 'saved-login', state: 'APPROVED', submittedAt: time } as const;
  const second = { ...first, id: 44, state: 'CHANGES_REQUESTED' } as const;
  const saved = await collectReleasePacket('Review history', urls, {
    ...source,
    reviewDecisions: async () => ({ state: 'observed', observedAt: time, decisions: [first, second] }),
  }, clock);
  const original = JSON.stringify(saved);
  const matching = {
    ...revision, checksDigest, checkIssues: [],
    reviewDecisions: {
      state: 'observed' as const, observedAt: '2026-11-23T00:00:00.000Z',
      decisions: [second, { ...first, login: 'new-login', submittedAt: '2026-11-23T00:00:00.000Z' }],
    },
  };
  const cases = [
    { expected: 'unchanged', revisionResult: matching },
    { expected: 'changed', revisionResult: { ...matching, reviewDecisions: {
      ...matching.reviewDecisions, decisions: [second, { ...first, state: 'DISMISSED' as const }],
    } } },
    { expected: 'changed', revisionResult: { ...matching, reviewDecisions: { ...matching.reviewDecisions, decisions: [first] } } },
    { expected: 'different-head', revisionResult: { ...matching, sha: 'b'.repeat(40) } },
    { expected: 'unavailable', revisionResult: { ...matching, reviewDecisions: { state: 'unavailable' as const } } },
  ];
  for (const { expected, revisionResult } of cases) {
    const report = await recheckReleasePacket(saved, saved.digest, async (_repo, _number, reviewSha) => {
      assert.equal(reviewSha, sha);
      return revisionResult;
    }, clock);
    assert.deepEqual(report.entries.map(entry => entry.reviewHistory), [expected, expected]);
    assert.deepEqual(report.entries.map(entry => entry.recheck.state),
      Array(2).fill(expected === 'different-head' ? 'stale' : 'unchanged'));
    assert.doesNotMatch(JSON.stringify(report), /saved-login|new-login|reviewDecisions/);
  }
  assert.equal(JSON.stringify(saved), original);
});

test('compiles two distinct repositories in stable order and validates the recorded digest', async () => {
  const release = await collectReleasePacket('Pilot', urls, source, clock);
  const reordered = await collectReleasePacket('Pilot', [...urls].reverse(), source, clock);
  assert.deepEqual(release, reordered);
  assert.deepEqual(release.packet.entries.map(entry => [entry.repository, entry.number, entry.recheck.state]),
    [['example/auto', 53, 'unchanged'], ['example/gem', 11, 'unchanged']]);
  assert.equal(release.packet.entries[0].snapshot?.forgeCore.state, 'trailer-unverified');
  assert.deepEqual(release.packet.coverage, { artifactProvenance: 'not-collected', humanApprovals: 'not-collected' });
  assert.ok(verifyReleasePacket(JSON.parse(JSON.stringify(release)), release.digest));
  assert.ok(!verifyReleasePacket(release, 'f'.repeat(64)));
  const changed = structuredClone(release);
  changed.packet.entries[0].snapshot!.checks[0].state = 'Failed';
  assert.ok(!verifyReleasePacket(changed));
  assert.ok(!verifyReleasePacket({ ...release, packet: { ...release.packet, version: 55 } }));
});

test('reports same-head drift, partial and failed evidence without asserting readiness', async () => {
  const packet = await collectReleasePacket('Pilot', [...urls, 'https://github.com/example/third/pull/7'], {
    review: async (repo, number) => {
      if (repo.endsWith('/third')) throw new GitHubError(404, 'PR unavailable');
      return review(repo, number);
    },
    recheck: async repo => repo.endsWith('/auto')
      ? { ...revision, checksDigest: 'f'.repeat(64), checkIssues: [] }
      : { ...revision, checksDigest: null, checkIssues: ['Commit statuses unavailable.'] },
  }, clock);
  assert.deepEqual(packet.packet.entries.map(entry => entry.recheck.state), ['stale', 'unavailable', 'unavailable']);
  assert.equal(packet.packet.entries[2].snapshot, null);
  assert.match(packet.packet.entries[1].recheck.detail ?? '', /Commit statuses unavailable/);
  assert.ok(verifyReleasePacket(packet));
  assert.ok(!JSON.stringify(packet).includes('releaseReady'));
});

test('validates all input repositories before querying a source', async () => {
  const noReads = {
    review: async (): Promise<never> => { throw new Error('unexpected upstream read'); },
    recheck: async (): Promise<never> => { throw new Error('unexpected upstream read'); },
  };
  await assert.rejects(collectReleasePacket('Pilot', [urls[0]], noReads), /at least two/i);
  await assert.rejects(collectReleasePacket('Pilot', [urls[0], 'https://github.com/EXAMPLE/AUTO/pull/54'], noReads), /one pull request per repository/i);
  await assert.rejects(collectReleasePacket('Pilot', [urls[0], 'https://outside.example/ex/a/pull/1'], noReads), /GitHub pull request URL/i);
});

test('rechecks a saved packet against independent observations and distinguishes source failures', async () => {
  const { recheckReleasePacket } = await import('../server/release-packet.ts');
  const saved = await collectReleasePacket('Pilot', [...urls, 'https://github.com/example/no-snapshot/pull/1'], {
    ...source,
    review: async (repository, number) => {
      if (repository.endsWith('/no-snapshot')) throw new GitHubError(404, 'Unavailable.');
      return source.review(repository, number);
    },
  }, clock);
  const reads: string[] = [];
  const result = await recheckReleasePacket(saved, saved.digest, async (repo, number) => {
    reads.push(`${repo}#${number}`);
    return repo.endsWith('/auto')
      ? { ...revision, checksDigest: 'f'.repeat(64), checkIssues: [] }
      : { ...revision, checksDigest: null, checkIssues: ['GitHub statuses unavailable.'] };
  }, clock);
  assert.deepEqual(reads, ['example/auto#53', 'example/gem#11']);
  assert.equal(result.packetDigest, saved.digest);
  assert.deepEqual(result.entries.map(entry => entry.recheck.state), ['stale', 'unavailable', 'unavailable']);
  assert.equal(result.entries[0].captureState, 'unchanged');
  assert.equal(result.entries[0].current?.sha, sha);
  assert.match(result.entries[1].recheck.detail ?? '', /statuses unavailable/);
  assert.equal(result.entries[2].recheck.at, null);
});

test('rejects mutated observations or targets before sending a GitHub request', async () => {
  const { recheckReleasePacket } = await import('../server/release-packet.ts');
  const saved = await collectReleasePacket('Pilot', urls, source, clock);
  const audit = async (): Promise<never> => { throw new Error('unexpected GitHub read'); };
  await assert.rejects(recheckReleasePacket(saved, 'f'.repeat(64), audit, clock), /digest/);

  function seal(value: typeof saved) {
    const canonical = JSON.stringify(value.packet, (_key, child) =>
      child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
    value.digest = createHash('sha256').update(canonical).digest('hex');
    return value;
  }
  const changed = structuredClone(saved);
  changed.packet.entries[0].snapshot!.checks[0].state = 'Failed';
  assert.ok(verifyReleasePacket(seal(changed)));
  await assert.rejects(recheckReleasePacket(changed, undefined, audit, clock), /check digest/i);
  const alternate = structuredClone(saved);
  alternate.packet.entries[0].url = 'https://outside.example/auto/pull/53';
  await assert.rejects(recheckReleasePacket(seal(alternate), undefined, audit, clock), /PR target/i);
  const malformedHistory = structuredClone(saved);
  malformedHistory.packet.entries[0].snapshot!.reviewDecisions = {
    state: 'observed', observedAt: time,
    decisions: [{ id: -1, login: 'reviewer', state: 'APPROVED', submittedAt: time }],
  };
  await assert.rejects(recheckReleasePacket(seal(malformedHistory), undefined, audit, clock), /invalid GitHub PR review history/i);
});

test('attaches artifact provenance only within a recorded repository revision and retains old packet verification', async () => {
  const { attachReleaseArtifact, recheckReleasePacket, verifyRecordedReleaseArtifact } = await import('../server/release-packet.ts');
  const saved = await collectReleasePacket('Pilot', urls, source, clock);
  const evidence = {
    repository: 'example/auto', sourceRevision: sha, artifactName: 'build.tgz',
    sha256: 'e'.repeat(64), issuer: 'https://token.actions.githubusercontent.com',
    signerRepository: 'example/auto',
    signerWorkflow: 'https://github.com/example/auto/.github/workflows/release.yml@refs/heads/main',
  };
  const attached = await attachReleaseArtifact(saved, 'EXAMPLE/Auto', saved.digest, async (scope) => {
    assert.deepEqual(scope, { repository: evidence.repository, sourceRevision: sha });
    return evidence;
  }, clock);
  assert.deepEqual(attached.packet.artifacts, [{ ...evidence, verifiedAt: time }]);
  assert.deepEqual(await verifyRecordedReleaseArtifact(attached, 'example/auto', attached.digest, async () => evidence), evidence);
  await assert.rejects(verifyRecordedReleaseArtifact(attached, 'example/auto', attached.digest,
    async () => ({ ...evidence, sha256: 'f'.repeat(64) })), /does not match/);
  await assert.rejects(verifyRecordedReleaseArtifact(saved, 'example/auto', saved.digest,
    async () => { throw new Error('unexpected verifier call'); }), /No artifact is recorded/);
  assert.deepEqual(attached.packet.coverage, { artifactProvenance: 'verified-artifacts', humanApprovals: 'not-collected' });
  assert.notEqual(attached.digest, saved.digest);
  assert.ok(verifyReleasePacket(saved, saved.digest));
  assert.ok(verifyReleasePacket(attached, attached.digest));
  assert.ok(!verifyReleasePacket(attached, saved.digest));
  assert.equal((await recheckReleasePacket(attached, attached.digest, source.recheck, clock)).packetDigest, attached.digest);
  await assert.rejects(attachReleaseArtifact(attached, evidence.repository, undefined, async () => evidence, clock), /already attached/);
  await assert.rejects(attachReleaseArtifact(saved, 'example/outside', undefined, async () => {
    throw new Error('unexpected verifier call');
  }, clock), /not in the packet/);
  await assert.rejects(attachReleaseArtifact(saved, evidence.repository, undefined,
    async () => ({ ...evidence, sourceRevision: 'b'.repeat(40) }), clock), /does not match/);
});

test('rechecks required-check policy separately from the PR and check results', async () => {
  const { recheckReleasePacket } = await import('../server/release-packet.ts');
  const requirements = [{ name: 'Integration', appId: 5 }, { name: 'Build', appId: null }];
  const saved = await collectReleasePacket('Policy pilot', urls, {
    ...source,
    review: async (repository, number) => ({
      ...review(repository, number), required: requirements, branchChecksStrict: false,
    }),
  }, clock);
  const report = await recheckReleasePacket(saved, saved.digest, async repo => ({
    ...revision, checksDigest, checkIssues: [],
    branchCheckPolicy: repo.endsWith('/auto') ? {
      requirements: [{ name: 'Build', appId: null }, { name: 'Integration', appId: 10 }], requireUpToDate: true,
    } : null,
    branchCheckPolicyIssue: repo.endsWith('/gem') ? 'GitHub branch policy is unavailable.' : null,
  }), clock);
  assert.deepEqual(report.entries.map(entry => entry.recheck.state), ['unchanged', 'unchanged']);
  assert.deepEqual(report.entries.map(entry => entry.branchPolicy.state), ['changed', 'unavailable']);
  assert.deepEqual(report.entries[0].branchPolicy.added, [{ name: 'Integration', appId: 10 }]);
  assert.deepEqual(report.entries[0].branchPolicy.removed, [{ name: 'Integration', appId: 5 }]);
  assert.deepEqual(report.entries[0].branchPolicy.upToDate, { recorded: false, current: true });
  assert.match(report.entries[1].branchPolicy.detail ?? '', /unavailable/);

  const matches = await recheckReleasePacket(saved, saved.digest, async () => ({
    ...revision, checksDigest, checkIssues: [],
    branchCheckPolicy: { requirements: [...requirements].reverse(), requireUpToDate: false },
    branchCheckPolicyIssue: null,
  }), clock);
  assert.deepEqual(matches.entries.map(entry => entry.branchPolicy.state), ['unchanged', 'unchanged']);
});
