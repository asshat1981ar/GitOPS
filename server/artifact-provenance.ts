import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { validRepository } from '../src/review.ts';

export interface ArtifactScope {
  repository: string;
  sourceRevision: string;
}

export interface VerifiedGitHubArtifact extends ArtifactScope {
  artifactName: string;
  sha256: string;
  issuer: string;
  signerRepository: string;
  signerWorkflow: string;
}

export class ArtifactVerificationError extends Error {}

const execute = promisify(execFile);
const githubIssuer = 'https://token.actions.githubusercontent.com';
const githubPrefix = 'https://github.com/';
const provenanceType = 'https://slsa.dev/provenance/v1';
const revisionPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signerRepository(workflow: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/\.github\/workflows\/[^@\s]+@[^\s]+$/.exec(workflow);
  return match && validRepository(match[1]) ? match[1].toLowerCase() : null;
}

export function matchesGitHubArtifactScope(value: unknown, scope: ArtifactScope): value is VerifiedGitHubArtifact {
  return record(value) && value.repository === scope.repository && value.sourceRevision === scope.sourceRevision &&
    typeof value.artifactName === 'string' && value.artifactName.trim().length > 0 && value.artifactName.length <= 2048 &&
    typeof value.sha256 === 'string' && digestPattern.test(value.sha256) &&
    value.issuer === githubIssuer && value.signerRepository === scope.repository &&
    typeof value.signerWorkflow === 'string' && signerRepository(value.signerWorkflow) === scope.repository;
}

async function runGitHubCli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('gh', args, {
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: '' },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = record(error) && typeof error.stderr === 'string' ? error.stderr : '';
    if ((record(error) && (error.code === 'ENOENT' || error.killed === true)) ||
        /unknown command|unknown flag|authenticate|no valid Sigstore verifiers|Forbidden|rate limit/i.test(detail)) {
      throw new ArtifactVerificationError('GitHub CLI attestation verification is unavailable. Check gh support, access, and network connectivity.');
    }
    // GitHub CLI can print presigned bundle URLs. Keep upstream stderr out of packets and logs.
    throw new ArtifactVerificationError('GitHub CLI could not verify an attestation for the artifact and packet scope.');
  }
}

async function hashArtifact(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new ArtifactVerificationError('The artifact must be a regular local file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyGitHubArtifact(
  file: string, scope: ArtifactScope, bundle?: string, run = runGitHubCli,
): Promise<VerifiedGitHubArtifact> {
  const { repository, sourceRevision } = scope;
  if (!validRepository(repository) || repository !== repository.toLowerCase() || !revisionPattern.test(sourceRevision)) {
    throw new ArtifactVerificationError('Artifact verification requires a canonical repository and full GitHub revision.');
  }
  const path = resolve(file);
  const sha256 = await hashArtifact(path);
  const args = [
    'attestation', 'verify', path, '--hostname', 'github.com', '--repo', repository,
    '--source-digest', sourceRevision, '--signer-repo', repository, '--format', 'json',
  ];
  if (bundle) {
    const path = resolve(bundle);
    if (!(await stat(path).catch(() => null))?.isFile()) {
      throw new ArtifactVerificationError('The attestation bundle file is unavailable.');
    }
    args.push('--bundle', path);
  }

  const stdout = await run(args);
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new ArtifactVerificationError('GitHub CLI returned invalid verification JSON.');
  }
  if (!Array.isArray(output)) throw new ArtifactVerificationError('GitHub CLI returned invalid verification JSON.');

  const matches: VerifiedGitHubArtifact[] = [];
  for (const row of output) {
    if (!record(row) || !record(row.verificationResult)) continue;
    const { signature, statement } = row.verificationResult;
    if (!record(signature) || !record(signature.certificate) || !record(statement) ||
        statement.predicateType !== provenanceType || !Array.isArray(statement.subject)) continue;
    const certificate = signature.certificate;
    if (typeof certificate.sourceRepositoryURI !== 'string' ||
        !certificate.sourceRepositoryURI.startsWith(githubPrefix) ||
        certificate.sourceRepositoryURI.slice(githubPrefix.length).toLowerCase() !== repository) continue;
    for (const subject of statement.subject) {
      if (!record(subject) || !record(subject.digest) || subject.digest.sha256 !== sha256) continue;
      const evidence = {
        repository, sourceRevision: certificate.sourceRepositoryDigest,
        artifactName: subject.name, sha256, issuer: certificate.issuer,
        signerRepository: typeof certificate.buildSignerURI === 'string' ? signerRepository(certificate.buildSignerURI) : null,
        signerWorkflow: certificate.buildSignerURI,
      };
      if (matchesGitHubArtifactScope(evidence, scope)) matches.push(evidence);
    }
  }
  const [match] = matches.sort((a, b) => {
    if (a.signerWorkflow !== b.signerWorkflow) return a.signerWorkflow < b.signerWorkflow ? -1 : 1;
    return a.artifactName < b.artifactName ? -1 : Number(a.artifactName !== b.artifactName);
  });
  if (!match) throw new ArtifactVerificationError('No verified attestation matches the artifact SHA-256, GitHub issuer, and packet source revision.');
  return match;
}
