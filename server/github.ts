import { createHash } from 'node:crypto';
import type { PullReviewDecisions } from './pull-review-decisions.ts';
import { manualChecks, reviewIntent, validRepository, revisionState, type Check, type ExportRevision, type PullRevision, type PullSummary, type Requirement, type Review, type Run } from '../src/review.ts';

const shaPattern = /^[a-f0-9]{40}$/;
const pageLimit = 10;

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function repositoryPath(repository: string): string {
  if (!validRepository(repository)) throw new GitHubError(400, 'Enter a GitHub repository as owner/name.');
  return '/repos/' + repository.split('/').map(encodeURIComponent).join('/');
}

export class GitHub {
  fetcher: typeof fetch;
  token?: string;
  constructor(fetcher: typeof fetch = fetch, token = process.env.GITOPS_GITHUB_TOKEN?.trim()) {
    this.fetcher = fetcher;
    this.token = token;
  }

  async request<T>(path: string): Promise<{ value: T; more: boolean }> {
    if (!path.startsWith('/repos/') || path.includes('\\')) throw new Error('Invalid GitHub API path.');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/')) throw new Error('Invalid GitHub API origin.');
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitOPS-Review-Inbox',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
        throw new GitHubError(429, 'GitHub rate limit reached. Wait and retry, or configure a GitHub token.');
      }
      if (response.status === 404) throw new GitHubError(404, 'GitHub could not find this resource or it is private.');
      throw new GitHubError(502, `GitHub returned HTTP ${response.status}.`);
    }
    return { value: await response.json() as T, more: /;\s*rel="next"/i.test(response.headers.get('link') ?? '') };
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).value;
  }

  async pages<T>(path: string, query = '', key?: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= pageLimit; page++) {
      const params = new URLSearchParams(query);
      params.set('per_page', '100');
      params.set('page', String(page));
      const { value, more } = await this.request<T[] | Record<string, T[]>>(`${path}?${params}`);
      const items = key && !Array.isArray(value) ? value[key] : value;
      if (!Array.isArray(items)) throw new Error('GitHub returned an unexpected list.');
      result.push(...items);
      if (!more) return result;
    }
    throw new GitHubError(502, 'The check history exceeded the supported GitHub page limit.');
  }
}

interface Pull {
  number: number; title: string; state: string; draft: boolean; merged?: boolean; merged_at?: string | null;
  body: string | null; head: { sha: string; ref: string; repo?: { full_name: string } | null }; base: { ref: string };
}
interface CheckRun {
  id: number; name: string; head_sha: string; html_url: string | null; status: string; conclusion: string | null;
  app?: { id: number; name: string };
}
interface CommitStatus { id: number; context: string; state: string; target_url: string | null }
interface WorkflowRun { id: number; name: string; head_sha: string; status: string; conclusion: string | null }
interface Rule {
  type: string;
  parameters?: {
    required_status_checks?: { context: string; integration_id?: number }[];
    strict_required_status_checks_policy?: boolean;
  };
}
interface Branch { protected: boolean; protection?: { required_status_checks?: { enforcement_level?: string; strict?: boolean; contexts?: string[]; checks?: { context: string; app_id: number | null }[] } } }

function pullState(pull: Pull): string {
  if (pull.merged || pull.merged_at) return 'Merged';
  if (pull.state === 'closed') return 'Closed';
  return pull.draft ? 'Draft' : 'Open';
}

export async function loadQueue(client: GitHub, repository: string): Promise<PullSummary[]> {
  const path = repositoryPath(repository);
  const pulls = await client.get<Pull[]>(`${path}/pulls?state=all&sort=updated&direction=desc&per_page=20`);
  return pulls.map(pull => ({ repository, number: pull.number, title: pull.title, state: pullState(pull) }));
}

function status(statusName: string, conclusion?: string | null): string {
  const value = conclusion ?? statusName;
  if (value === 'success') return 'Passed';
  if (['failure', 'error', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(value)) return 'Failed';
  if (['pending', 'queued', 'requested', 'waiting', 'in_progress'].includes(value)) return 'Running';
  if (value === 'skipped') return 'Skipped';
  if (value === 'neutral') return 'Neutral';
  if (value === 'cancelled') return 'Cancelled';
  return 'Unknown';
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function linkedRunIds(body: string, repository: string): string[] {
  const runs = new Set<string>();
  for (const match of body.matchAll(/https:\/\/github\.com\/([a-z\d_.-]+\/[a-z\d_.-]+)\/actions\/runs\/(\d+)\b/gi)) {
    if (match[1].toLowerCase() === repository.toLowerCase()) runs.add(match[2]);
  }
  return [...runs];
}

export interface BranchCheckPolicy {
  requirements: Requirement[];
  requireUpToDate: boolean | null;
}

export interface ReleaseRevision extends ExportRevision {
  branchCheckPolicy: BranchCheckPolicy | null;
  branchCheckPolicyIssue: string | null;
  reviewDecisions?: PullReviewDecisions;
}

interface ScopedReviewRead {
  sha: string;
  load(): Promise<PullReviewDecisions>;
}

async function branchRequirements(client: GitHub, repo: string, ref: string): Promise<BranchCheckPolicy> {
  const branch = encodeURIComponent(ref);
  const [rules, info] = await Promise.all([
    client.pages<Rule>(`${repo}/rules/branches/${branch}`),
    client.get<Branch>(`${repo}/branches/${branch}`),
  ]);
  const requirements: Requirement[] = [];
  const strict: (boolean | undefined)[] = [];
  for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) throw new Error('GitHub omitted required checks for a ruleset.');
    for (const check of checks) {
      requirements.push({ name: check.context, appId: check.integration_id && check.integration_id > 0 ? check.integration_id : null });
    }
    if (checks.length) strict.push(rule.parameters?.strict_required_status_checks_policy);
  }
  // Some tokens can read rulesets without seeing classic protection fields.
  // Avoid treating that partial result as the complete effective requirement set.
  const classic = info.protection?.required_status_checks;
  if (!classic && info.protected) throw new Error('GitHub did not expose requirements for the protected branch.');
  if (classic && classic.enforcement_level !== 'off') {
    for (const name of classic.contexts ?? []) {
      if (!(classic.checks ?? []).some(check => check.context === name)) requirements.push({ name, appId: null });
    }
    for (const item of classic.checks ?? []) {
      requirements.push({ name: item.context, appId: item.app_id && item.app_id > 0 ? item.app_id : null });
    }
    if (classic.contexts?.length || classic.checks?.length) strict.push(classic.strict);
  }
  return {
    requirements: [...new Map(requirements.map(item => [JSON.stringify([item.name, item.appId]), item])).values()],
    requireUpToDate: strict.includes(true) ? true : strict.includes(undefined) ? null : false,
  };
}

function gemTrailer(message: string): string | null {
  const trailerBlock = message.trimEnd().split(/\r?\n[ \t]*\r?\n/).at(-1) ?? '';
  const entries = [...trailerBlock.matchAll(/^Gem-Gate:[ \t]*(.*)$/gim)];
  if (!entries.length) return null;
  const id = entries[0][1].trim().toLowerCase();
  if (entries.length !== 1 || !/^[a-f0-9]{32}$/.test(id)) {
    throw new GitHubError(422, 'The commit has an ambiguous or invalid Gem-Gate trailer.');
  }
  return id;
}

function pullRevision(pull: Pull): PullRevision {
  const sha = pull.head?.sha;
  const baseRef = pull.base?.ref;
  if (!shaPattern.test(sha) || typeof baseRef !== 'string' || !baseRef) {
    throw new GitHubError(502, 'GitHub returned an invalid pull request revision.');
  }
  // Use the inputs displayed or exported by GitOPS. General activity timestamps
  // can change for unrelated events such as comments.
  const contextDigest = createHash('sha256').update(JSON.stringify([
    pull.title, pull.body ?? '', pullState(pull), pull.head.ref, pull.head.repo?.full_name ?? null,
  ])).digest('hex');
  return { sha, baseRef, contextDigest };
}

export async function loadRevision(client: GitHub, repository: string, number: number): Promise<PullRevision> {
  return pullRevision(await client.get<Pull>(`${repositoryPath(repository)}/pulls/${number}`));
}

export async function receiptScope(client: GitHub, repository: string, number: number, expectedSha: string) {
  if (!shaPattern.test(expectedSha)) throw new GitHubError(400, 'Enter a valid pull request head SHA.');
  const repo = repositoryPath(repository);
  const pull = await client.get<Pull>(`${repo}/pulls/${number}`);
  if (pullRevision(pull).sha !== expectedSha) throw new GitHubError(409, 'The pull request head changed. Refresh before verifying.');
  if (!pull.head.repo?.full_name) throw new GitHubError(422, 'GitHub did not expose the pull request head repository.');
  const details = await client.get<{ commit: { message: string } }>(`${repo}/commits/${expectedSha}`);
  return { repository: pull.head.repo.full_name, headRef: pull.head.ref, attestationId: gemTrailer(details.commit.message) };
}

async function collect<T>(promise: Promise<T>, label: string, fallback: T) {
  try {
    return { value: await promise, issue: null };
  } catch (error) {
    const detail = error instanceof GitHubError ? ` ${error.message}` : '';
    return { value: fallback, issue: `${label} unavailable.${detail}` };
  }
}

export function digestCurrentChecks(checks: ReadonlyArray<Check>): string {
  return createHash('sha256').update(JSON.stringify(
    checks.map(check => JSON.stringify([
      check.id, check.name, check.source, check.appId ?? null, check.state, check.sha, check.url,
    ])).sort(),
  )).digest('hex');
}

async function currentChecks(client: GitHub, repo: string, sha: string) {
  const commit = `${repo}/commits/${sha}`;
  const [runs, statuses] = await Promise.all([
    collect(client.pages<CheckRun>(`${commit}/check-runs`, 'filter=all', 'check_runs'), 'GitHub check runs', []),
    collect(client.pages<CommitStatus>(`${commit}/statuses`), 'GitHub commit statuses', []),
  ]);
  const checks: Check[] = [
    ...runs.value.filter(run => run.head_sha === sha).map(run => ({
      id: run.id, name: run.name, source: run.app?.name ?? 'GitHub checks', appId: run.app?.id,
      state: status(run.status, run.conclusion), sha, url: httpsUrl(run.html_url),
    })),
    ...statuses.value.map(item => ({
      id: item.id, name: item.context, source: 'GitHub status', state: status(item.state),
      sha, url: httpsUrl(item.target_url),
    })),
  ];
  const checkIssues = [runs.issue, statuses.issue].filter((issue): issue is string => issue !== null);
  const checksDigest = checkIssues.length ? null : digestCurrentChecks(checks);
  return { checks, checksDigest, checkIssues, evidenceSources: { checkRuns: runs.issue === null, commitStatuses: statuses.issue === null } };
}

async function loadEvidenceRevision(
  client: GitHub, repository: string, number: number, includePolicy: boolean, reviews?: ScopedReviewRead,
): Promise<ReleaseRevision> {
  const revision = await loadRevision(client, repository, number);
  const repo = repositoryPath(repository);
  const [{ checksDigest, checkIssues }, policy, reviewHistory] = await Promise.all([
    currentChecks(client, repo, revision.sha),
    includePolicy ? collect<BranchCheckPolicy | null>(
      branchRequirements(client, repo, revision.baseRef), 'GitHub branch check requirements', null,
    ) : Promise.resolve({ value: null, issue: null }),
    reviews?.sha === revision.sha
      ? collect<PullReviewDecisions>(reviews.load(), 'GitHub PR reviews', { state: 'unavailable' })
      : undefined,
  ]);
  if (revisionState(revision, await loadRevision(client, repository, number)) === 'stale') {
    throw new GitHubError(409, 'The pull request changed while checking evidence. Refresh the review and try again.');
  }
  return { ...revision, checksDigest, checkIssues, branchCheckPolicy: policy.value,
    branchCheckPolicyIssue: policy.issue, reviewDecisions: reviewHistory?.value };
}

export async function loadExportRevision(client: GitHub, repository: string, number: number): Promise<ExportRevision> {
  const { sha, baseRef, contextDigest, checksDigest, checkIssues } = await loadEvidenceRevision(client, repository, number, false);
  return { sha, baseRef, contextDigest, checksDigest, checkIssues };
}

export function loadReleaseRevision(
  client: GitHub, repository: string, number: number, reviews?: ScopedReviewRead,
): Promise<ReleaseRevision> {
  return loadEvidenceRevision(client, repository, number, true, reviews);
}

export async function loadReview(client: GitHub, repository: string, number: number): Promise<Review> {
  const repo = repositoryPath(repository);
  const pullUrl = `${repo}/pulls/${number}`;
  const pull = await client.get<Pull>(pullUrl);
  const revision = pullRevision(pull);
  const { sha } = revision;
  const commit = `${repo}/commits/${sha}`;
  const body = pull.body ?? '';
  const runIds = linkedRunIds(body, repository);
  const [current, required, details, ...linked] = await Promise.all([
    currentChecks(client, repo, sha),
    collect<BranchCheckPolicy | null>(branchRequirements(client, repo, pull.base.ref), 'GitHub branch check requirements', null),
    collect(client.get<{ commit: { message: string } }>(commit), 'Head commit message', null),
    ...runIds.slice(0, 8).map(id => collect(client.get<WorkflowRun>(`${repo}/actions/runs/${id}`), `Linked workflow run ${id}`, null)),
  ]);
  const latest = await client.get<Pull>(pullUrl);
  if (revisionState(revision, pullRevision(latest)) === 'stale') {
    throw new GitHubError(409, 'The pull request changed while loading. Refresh to review the new revision.');
  }

  const linkedRuns: Run[] = [];
  for (const { value: run } of linked) {
    if (run && shaPattern.test(run.head_sha)) {
      linkedRuns.push({ name: run.name, sha: run.head_sha, state: status(run.status, run.conclusion),
        url: `https://github.com/${repository}/actions/runs/${run.id}` });
    }
  }
  const issues = [
    ...current.checkIssues,
    ...[required, details, ...linked].flatMap(item => item.issue ? [item.issue] : []),
  ];
  if (runIds.length > 8) issues.push('Only the first eight linked workflow runs were checked.');
  let attestationId: string | null = null;
  let trailerAvailable = details.value !== null;
  try {
    if (details.value) attestationId = gemTrailer(details.value.commit.message);
  } catch (error) {
    trailerAvailable = false;
    issues.push(error instanceof GitHubError ? error.message : 'Gem-Gate trailer evidence is unavailable.');
  }
  return {
    repository, number, title: latest.title, state: pullState(latest), ...revision, headRef: pull.head.ref,
    url: `https://github.com/${repository}/pull/${number}`, intent: reviewIntent(body), checks: current.checks, checksDigest: current.checksDigest, linkedRuns,
    manual: manualChecks(body), issues, trailerAvailable,
    evidenceSources: current.evidenceSources, required: required.value?.requirements ?? null, branchChecksStrict: required.value?.requireUpToDate ?? null, observedAt: new Date().toISOString(), attestationId,
  };
}
