import { createHash } from 'node:crypto';
import {
  parsePullUrl, revisionState, validRepository, type Check, type ExportRevision, type PullRef, type PullRevision, type Requirement, type Review,
} from '../src/review.ts';
import { digestCurrentChecks, GitHubError, type BranchCheckPolicy, type ReleaseRevision } from './github.ts';
import { matchesGitHubArtifactScope, type ArtifactScope, type VerifiedGitHubArtifact } from './artifact-provenance.ts';
import type { PullReviewDecisions } from './pull-review-decisions.ts';

type ReleaseObservation = ExportRevision & Partial<Pick<ReleaseRevision, 'branchCheckPolicy' | 'branchCheckPolicyIssue'>>;

interface ReviewSource {
  review(repository: string, number: number): Promise<Review>;
  recheck(repository: string, number: number): Promise<ReleaseObservation>;
  reviewDecisions?(repository: string, number: number, sha: string): Promise<PullReviewDecisions>;
}

function capture(review: Review) {
  return {
    revision: { sha: review.sha, baseRef: review.baseRef, contextDigest: review.contextDigest },
    headRef: review.headRef,
    observedAt: review.observedAt,
    title: review.title,
    state: review.state,
    intent: review.intent,
    checks: review.checks,
    checksDigest: review.checksDigest,
    evidenceSources: review.evidenceSources,
    branchRequirementsObserved: review.required,
    branchChecksStrictObserved: review.branchChecksStrict ?? null,
    linkedRunsObserved: review.linkedRuns,
    manualChecklistObserved: review.manual,
    issues: review.issues,
    forgeCore: {
      state: !review.trailerAvailable ? 'trailer-unavailable'
        : review.attestationId ? 'trailer-unverified' : 'trailer-absent',
      attestationId: review.attestationId,
    },
  };
}

interface Recheck {
  state: 'unchanged' | 'stale' | 'unavailable';
  at: string | null;
  detail: string | null;
}

interface EvidenceFingerprint {
  revision: PullRevision;
  checksDigest: string | null;
}

interface BranchPolicyRecheck {
  state: 'unchanged' | 'changed' | 'unavailable';
  detail: string | null;
  added: Requirement[];
  removed: Requirement[];
  upToDate: { recorded: boolean | null; current: boolean | null } | null;
}

interface PacketEntry extends PullRef {
  url: string;
  snapshot: (ReturnType<typeof capture> & { reviewDecisions?: PullReviewDecisions }) | null;
  recheck: Recheck;
  branchPolicy?: BranchPolicyRecheck;
}

interface Packet {
  version: 1;
  name: string;
  startedAt: string;
  finishedAt: string;
  coverage: { artifactProvenance: 'not-collected' | 'verified-artifacts'; humanApprovals: 'not-collected' };
  entries: PacketEntry[];
  artifacts?: PacketArtifact[];
}

interface PacketArtifact extends VerifiedGitHubArtifact {
  verifiedAt: string;
}

const sha256 = /^[0-9a-f]{64}$/;

function digestPacket(payload: unknown): string {
  // Packet v1 sorts JSON object keys recursively and preserves array order.
  const canonical = JSON.stringify(payload, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1))
      : value);
  return createHash('sha256').update(canonical).digest('hex');
}

function releaseRefs(urls: string[]): PullRef[] {
  if (urls.length < 2) throw new Error('Enter pull requests from at least two repositories.');
  const refs = new Map<string, PullRef>();
  for (const url of urls) {
    const pull = parsePullUrl(url);
    if (!pull) throw new Error('Use an HTTPS GitHub pull request URL for every repository.');
    const repository = pull.repository.toLowerCase();
    if (refs.has(repository)) throw new Error('Select one pull request per repository.');
    refs.set(repository, { ...pull, repository });
  }
  return [...refs.keys()].sort().map(repository => refs.get(repository)!);
}

function attemptFailed(error: unknown, at: string | null, fallback: string): Recheck {
  return {
    state: error instanceof GitHubError && error.status === 409 ? 'stale' : 'unavailable',
    at,
    detail: error instanceof GitHubError ? error.message : fallback,
  };
}

function compareEvidence(saved: EvidenceFingerprint, current: ExportRevision, at: string): Recheck {
  if (revisionState(saved.revision, current) === 'stale' ||
      (saved.checksDigest && current.checksDigest && saved.checksDigest !== current.checksDigest)) {
    return { state: 'stale', at, detail: 'The PR revision or current checks differ from the recorded observation.' };
  }
  if (!saved.checksDigest || !current.checksDigest) {
    return { state: 'unavailable', at,
      detail: current.checkIssues.join(' ') || 'The recorded or current check evidence is incomplete.' };
  }
  return { state: 'unchanged', at, detail: null };
}

function policyUnavailable(detail: string): BranchPolicyRecheck {
  return { state: 'unavailable', detail, added: [], removed: [], upToDate: null };
}

function comparePolicy(
  baseRef: string, recorded: BranchCheckPolicy | null, current: ReleaseObservation,
): BranchPolicyRecheck {
  if (baseRef !== current.baseRef) return policyUnavailable('The pull request base branch changed.');
  if (!recorded) return policyUnavailable('Required-check policy was unavailable in the saved snapshot.');
  if (!current.branchCheckPolicy) {
    return policyUnavailable(current.branchCheckPolicyIssue ?? 'Current required-check policy is unavailable.');
  }
  const requirementKey = (item: Requirement) => JSON.stringify([item.name, item.appId]);
  const before = new Map(recorded.requirements.map(item => [requirementKey(item), item]));
  const after = new Map(current.branchCheckPolicy.requirements.map(item => [requirementKey(item), item]));
  const added = [...after.keys()].sort().filter(key => !before.has(key)).map(key => after.get(key)!);
  const removed = [...before.keys()].sort().filter(key => !after.has(key)).map(key => before.get(key)!);
  const upToDate = {
    recorded: recorded.requireUpToDate, current: current.branchCheckPolicy.requireUpToDate,
  };
  const strictKnown = upToDate.recorded !== null && upToDate.current !== null;
  if (added.length || removed.length || (strictKnown && upToDate.recorded !== upToDate.current)) {
    return { state: 'changed', detail: 'Required-check policy differs from the saved snapshot.', added, removed, upToDate };
  }
  return {
    state: strictKnown ? 'unchanged' : 'unavailable',
    detail: strictKnown ? null : 'Required check names and providers matched. The up-to-date requirement was unavailable.',
    added, removed, upToDate,
  };
}

function observedPolicy(requirements: Requirement[] | null, strict?: boolean | null): BranchCheckPolicy | null {
  return requirements === null ? null : {
    requirements, requireUpToDate: strict ?? (requirements.length ? null : false),
  };
}

export async function collectReleasePacket(
  name: string, urls: string[], source: ReviewSource, now = () => new Date(),
): Promise<{ packet: Packet; digest: string }> {
  if (!name.trim()) throw new Error('Enter a release name.');
  const refs = releaseRefs(urls);
  const startedAt = now().toISOString();
  const observed = await Promise.allSettled(refs.map(ref => source.review(ref.repository, ref.number)));
  const entries = await Promise.all(refs.map(async (ref, index): Promise<PacketEntry> => {
    const url = `https://github.com/${ref.repository}/pull/${ref.number}`;
    const result = observed[index];
    if (result.status === 'rejected') {
      return { ...ref, url, snapshot: null, recheck: attemptFailed(result.reason, null, 'PR snapshot unavailable.') };
    }
    const snapshot: NonNullable<PacketEntry['snapshot']> = capture(result.value);
    if (source.reviewDecisions) {
      try {
        snapshot.reviewDecisions = await source.reviewDecisions(ref.repository, ref.number, snapshot.revision.sha);
      } catch {
        snapshot.reviewDecisions = { state: 'unavailable' };
      }
    }
    let recheck: Recheck;
    let branchPolicy: BranchPolicyRecheck;
    try {
      const current = await source.recheck(ref.repository, ref.number);
      recheck = compareEvidence(snapshot, current, now().toISOString());
      branchPolicy = comparePolicy(snapshot.revision.baseRef,
        observedPolicy(snapshot.branchRequirementsObserved, snapshot.branchChecksStrictObserved), current);
    } catch (error) {
      recheck = attemptFailed(error, now().toISOString(), 'PR or check recheck unavailable.');
      branchPolicy = policyUnavailable('Required-check policy could not be rechecked for this revision.');
    }
    return { ...ref, url, snapshot, recheck, branchPolicy };
  }));
  const packet: Packet = {
    version: 1,
    name: name.trim(),
    startedAt,
    finishedAt: now().toISOString(),
    coverage: { artifactProvenance: 'not-collected', humanApprovals: 'not-collected' },
    entries,
  };
  return { packet, digest: digestPacket(packet) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function verifiedEnvelope(value: unknown, expected?: string) {
  if (!record(value) || Object.keys(value).length !== 2 || !record(value.packet) ||
      value.packet.version !== 1 || !Array.isArray(value.packet.entries) || value.packet.entries.length < 2 ||
      typeof value.digest !== 'string' || !sha256.test(value.digest) ||
      (expected !== undefined && value.digest !== expected) || digestPacket(value.packet) !== value.digest) return null;
  const packet = value.packet;
  const entries: unknown[] = value.packet.entries;
  if (!artifactAttachmentsMatch(packet, entries)) return null;
  return { packet, entries, digest: value.digest };
}

function artifactTarget(entries: unknown[], repository: string): ArtifactScope | null {
  const matched = entries.filter(entry => record(entry) && entry.repository === repository);
  if (matched.length !== 1) return null;
  const [entry] = matched;
  if (!record(entry) || typeof entry.url !== 'string') return null;
  const target = parsePullUrl(entry.url);
  if (!target || target.repository !== repository || target.number !== entry.number ||
      entry.url !== `https://github.com/${repository}/pull/${target.number}`) return null;
  const evidence = recordedEvidence(entry.snapshot);
  return evidence ? { repository, sourceRevision: evidence.revision.sha } : null;
}

function artifactAttachmentsMatch(packet: Record<string, unknown>, entries: unknown[]): boolean {
  const { artifacts, coverage } = packet;
  if (artifacts === undefined) return !record(coverage) || coverage.artifactProvenance !== 'verified-artifacts';
  if (!Array.isArray(artifacts) || !artifacts.length || !record(coverage) ||
      coverage.artifactProvenance !== 'verified-artifacts') return false;
  const seen = new Set<string>();
  try {
    for (const artifact of artifacts) {
      if (!record(artifact) || typeof artifact.repository !== 'string' || !validRepository(artifact.repository) ||
          artifact.repository !== artifact.repository.toLowerCase() || typeof artifact.verifiedAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(artifact.verifiedAt) ||
          !Number.isFinite(Date.parse(artifact.verifiedAt))) return false;
      const scope = artifactTarget(entries, artifact.repository);
      if (!scope || !matchesGitHubArtifactScope(artifact, scope)) return false;
      const key = `${artifact.repository}:${artifact.sha256}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
  } catch {
    return false;
  }
  return true;
}

export async function attachReleaseArtifact(
  value: unknown, repository: string, expectedDigest: string | undefined,
  verify: (scope: ArtifactScope) => Promise<VerifiedGitHubArtifact>, now = () => new Date(),
) {
  const envelope = verifiedEnvelope(value, expectedDigest);
  if (!envelope) throw new Error('Packet digest or version check failed.');
  if (!validRepository(repository)) throw new Error('Use a GitHub repository in OWNER/REPO form.');
  const scope = artifactTarget(envelope.entries, repository.toLowerCase());
  if (!scope) throw new Error('The repository or a recorded PR revision is not in the packet.');
  const verified = await verify(scope);
  if (!matchesGitHubArtifactScope(verified, scope)) {
    throw new Error('The verified artifact does not match the recorded repository and source revision.');
  }
  const { repository: source, sourceRevision, artifactName, sha256, issuer, signerRepository, signerWorkflow } = verified;
  const current = Array.isArray(envelope.packet.artifacts) ? envelope.packet.artifacts as PacketArtifact[] : [];
  if (current.some(artifact => artifact.repository === source && artifact.sha256 === sha256)) {
    throw new Error('This artifact is already attached to the packet.');
  }
  const artifacts = [...current, {
    repository: source, sourceRevision, artifactName, sha256, issuer, signerRepository, signerWorkflow,
    verifiedAt: now().toISOString(),
  }];
  artifacts.sort((a, b) => {
    if (a.repository !== b.repository) return a.repository < b.repository ? -1 : 1;
    return a.sha256 < b.sha256 ? -1 : Number(a.sha256 !== b.sha256);
  });
  const packet = {
    ...envelope.packet,
    coverage: { artifactProvenance: 'verified-artifacts', humanApprovals: 'not-collected' },
    artifacts,
  };
  return { packet, digest: digestPacket(packet) };
}

export async function verifyRecordedReleaseArtifact(
  value: unknown, repository: string, expectedDigest: string | undefined,
  verify: (scope: ArtifactScope) => Promise<VerifiedGitHubArtifact>,
): Promise<VerifiedGitHubArtifact> {
  const envelope = verifiedEnvelope(value, expectedDigest);
  if (!envelope) throw new Error('Packet digest or version check failed.');
  if (!validRepository(repository)) throw new Error('Use a GitHub repository in OWNER/REPO form.');
  const scope = artifactTarget(envelope.entries, repository.toLowerCase());
  const recorded = (Array.isArray(envelope.packet.artifacts) ? envelope.packet.artifacts as PacketArtifact[] : [])
    .filter(artifact => artifact.repository === repository.toLowerCase());
  if (!scope || !recorded.length) throw new Error('No artifact is recorded for this repository in the packet.');
  const verified = await verify(scope);
  if (!matchesGitHubArtifactScope(verified, scope) || !recorded.some(artifact =>
    artifact.sha256 === verified.sha256 && artifact.artifactName === verified.artifactName &&
    artifact.issuer === verified.issuer && artifact.signerWorkflow === verified.signerWorkflow)) {
    throw new Error('The verified artifact or issuer does not match the recorded provenance.');
  }
  return verified;
}

export function verifyReleasePacket(value: unknown, expected?: string): boolean {
  return verifiedEnvelope(value, expected) !== null;
}

function validCheck(value: unknown, sha: string): value is Check {
  return record(value) && Number.isSafeInteger(value.id) && value.sha === sha &&
    typeof value.name === 'string' && typeof value.source === 'string' && typeof value.state === 'string' &&
    (value.appId === undefined || Number.isSafeInteger(value.appId)) &&
    (value.url === null || typeof value.url === 'string');
}

function validReviewHistory(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === 'unavailable') return true;
  if (value.state !== 'observed' || typeof value.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.decisions)) return false;
  const seen = new Set<number>();
  for (const item of value.decisions) {
    if (!record(item) || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 1 ||
        seen.has(item.id) || (item.login !== null && (typeof item.login !== 'string' || !item.login)) ||
        (item.state !== 'APPROVED' && item.state !== 'CHANGES_REQUESTED' && item.state !== 'DISMISSED') ||
        typeof item.submittedAt !== 'string' || !Number.isFinite(Date.parse(item.submittedAt))) return false;
    seen.add(item.id);
  }
  return true;
}

function recordedEvidence(snapshot: unknown): (EvidenceFingerprint & { policy: BranchCheckPolicy | null }) | null {
  if (snapshot === null) return null;
  if (!record(snapshot) || !record(snapshot.revision)) {
    throw new Error('Packet contains an invalid PR snapshot.');
  }
  const { sha, baseRef, contextDigest } = snapshot.revision;
  const { checks, checksDigest } = snapshot;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) ||
      typeof baseRef !== 'string' || !baseRef ||
      typeof contextDigest !== 'string' || !sha256.test(contextDigest) ||
      !Array.isArray(checks) || !checks.every(check => validCheck(check, sha))) {
    throw new Error('Packet contains an invalid PR revision or check observation.');
  }
  if (checksDigest !== null && (typeof checksDigest !== 'string' ||
      !sha256.test(checksDigest) || digestCurrentChecks(checks) !== checksDigest)) {
    throw new Error('Recorded check digest does not match the recorded check observations.');
  }
  if (snapshot.reviewDecisions !== undefined && !validReviewHistory(snapshot.reviewDecisions)) {
    throw new Error('Packet contains invalid GitHub PR review history.');
  }
  const requirements = snapshot.branchRequirementsObserved;
  const strict = snapshot.branchChecksStrictObserved;
  if ((requirements != null && (!Array.isArray(requirements) || !requirements.every(item =>
    record(item) && typeof item.name === 'string' && item.name.length > 0 &&
    (item.appId === null || (typeof item.appId === 'number' && Number.isSafeInteger(item.appId) && item.appId > 0))))) ||
      (strict != null && typeof strict !== 'boolean')) {
    throw new Error('Packet contains invalid required-check policy.');
  }
  return { revision: { sha, baseRef, contextDigest }, checksDigest, policy: observedPolicy(requirements ?? null, strict) };
}

export async function recheckReleasePacket(
  value: unknown, expectedDigest: string | undefined,
  recheck: ReviewSource['recheck'], now = () => new Date(),
) {
  const envelope = verifiedEnvelope(value, expectedDigest);
  if (!envelope) throw new Error('Packet digest or version check failed.');
  const seen = new Set<string>();
  const targets = envelope.entries.map(entry => {
    if (!record(entry) || typeof entry.url !== 'string') throw new Error('Packet contains an invalid PR target.');
    const target = parsePullUrl(entry.url);
    if (!target || target.repository !== entry.repository ||
        target.repository !== target.repository.toLowerCase() || target.number !== entry.number ||
        entry.url !== `https://github.com/${target.repository}/pull/${target.number}` ||
        seen.has(target.repository)) throw new Error('Packet contains an invalid or duplicate PR target.');
    seen.add(target.repository);
    const captureState = record(entry.recheck) ? entry.recheck.state : null;
    if (captureState !== 'unchanged' && captureState !== 'stale' && captureState !== 'unavailable') {
      throw new Error('Packet contains an invalid capture recheck result.');
    }
    return { ...target, url: entry.url, captureState, recorded: recordedEvidence(entry.snapshot) };
  });
  const startedAt = now().toISOString();
  const entries = await Promise.all(targets.map(async entry => {
    if (!entry.recorded) {
      return { ...entry, current: null, branchPolicy: policyUnavailable('No PR snapshot was recorded.'),
        recheck: { state: 'unavailable', at: null, detail: 'No PR snapshot was recorded.' } as Recheck };
    }
    try {
      const current = await recheck(entry.repository, entry.number);
      return { ...entry, current, recheck: compareEvidence(entry.recorded, current, now().toISOString()),
        branchPolicy: comparePolicy(entry.recorded.revision.baseRef, entry.recorded.policy, current) };
    } catch (error) {
      return { ...entry, current: null, recheck: attemptFailed(error, now().toISOString(), 'PR or check recheck unavailable.'),
        branchPolicy: policyUnavailable('Required-check policy could not be rechecked for this revision.') };
    }
  }));
  return { packetDigest: envelope.digest, startedAt, finishedAt: now().toISOString(), entries };
}
