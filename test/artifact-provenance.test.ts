import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactVerificationError, verifyGitHubArtifact } from '../server/artifact-provenance.ts';

const sourceRevision = 'a'.repeat(40);
const repository = 'example/repo';
const issuer = 'https://token.actions.githubusercontent.com';
const signerWorkflow = 'https://github.com/example/repo/.github/workflows/release.yml@refs/heads/main';
const body = 'real artifact test bytes';
const sha256 = createHash('sha256').update(body).digest('hex');
const scope = { repository, sourceRevision };
const provenance = () => ({
  verificationResult: {
    signature: { certificate: {
      issuer, sourceRepositoryURI: 'https://github.com/example/repo',
      sourceRepositoryDigest: sourceRevision, buildSignerURI: signerWorkflow,
    } },
    statement: { predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ name: 'build.tar.gz', digest: { sha256 } }] },
  },
});

test('verifies the local artifact with GitHub CLI and consumes the verified certificate and subject', async t => {
  const work = await mkdtemp(join(tmpdir(), 'gitops-artifact-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const artifact = join(work, 'local name.tgz');
  const bundle = join(work, 'release.jsonl');
  await writeFile(artifact, body);
  await writeFile(bundle, '{}');

  const result = await verifyGitHubArtifact(artifact, scope, bundle, async args => {
    assert.deepEqual(args, [
      'attestation', 'verify', artifact, '--hostname', 'github.com', '--repo', repository,
      '--source-digest', sourceRevision, '--signer-repo', repository, '--format', 'json',
      '--bundle', bundle,
    ]);
    return JSON.stringify([provenance()]);
  });

  assert.deepEqual(result, {
    repository, sourceRevision, artifactName: 'build.tar.gz', sha256, issuer, signerRepository: repository,
    signerWorkflow,
  });
  await writeFile(artifact, body + ' changed');
  await assert.rejects(verifyGitHubArtifact(artifact, scope, bundle, async () => JSON.stringify([provenance()])),
    /No verified attestation matches the artifact SHA-256/);
});

test('rejects malformed, unscoped, and non-GitHub provenance without trusting predicate claims', async t => {
  const work = await mkdtemp(join(tmpdir(), 'gitops-artifact-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const artifact = join(work, 'local.tgz');
  await writeFile(artifact, body);

  for (const field of ['issuer', 'sourceRepositoryURI', 'sourceRepositoryDigest', 'buildSignerURI'] as const) {
    const result = provenance();
    result.verificationResult.signature.certificate[field] = 'https://outside.example/unrelated';
    await assert.rejects(verifyGitHubArtifact(artifact, scope, undefined, async () => JSON.stringify([result])),
      /No verified attestation matches/);
  }
  await assert.rejects(verifyGitHubArtifact(artifact, scope, undefined, async () => '{'),
    /invalid verification JSON/);
  await assert.rejects(verifyGitHubArtifact(artifact, scope, join(work, 'missing.jsonl'), async () => {
    throw new Error('unexpected verifier call');
  }), /bundle file is unavailable/);
  await assert.rejects(verifyGitHubArtifact(artifact, scope, undefined, async () => {
    throw new ArtifactVerificationError('GitHub CLI attestation verification is unavailable.');
  }), /verification is unavailable/);
});
