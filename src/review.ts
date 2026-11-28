export interface PullRef { repository: string; number: number }
export interface PullSummary extends PullRef { title: string; state: string }
export interface Check {
  id: number;
  name: string;
  source: string;
  appId?: number;
  state: string;
  sha: string;
  url: string | null;
}
export interface Run { name: string; sha: string; state: string; url: string }
export interface Requirement { name: string; appId: number | null }
export interface PullRevision { sha: string; baseRef: string; contextDigest: string }
export interface ExportRevision extends PullRevision {
  checksDigest: string | null;
  checkIssues: string[];
}
export interface EvidenceSources { checkRuns: boolean; commitStatuses: boolean }

export function revisionState(observed: PullRevision, current: PullRevision): 'current' | 'stale' {
  return observed.sha === current.sha && observed.baseRef === current.baseRef &&
    observed.contextDigest === current.contextDigest ? 'current' : 'stale';
}
export interface ReceiptVerification {
  id: string;
  valid: boolean;
  recorded: boolean;
  trailerMatched: boolean;
  decision: string | null;
  repository: string;
  branch: string;
}
export interface Review extends PullSummary, PullRevision {
  headRef: string;
  url: string;
  intent: string;
  checks: Check[];
  evidenceSources: EvidenceSources;
  checksDigest: string | null;
  linkedRuns: Run[];
  manual: string[];
  issues: string[];
  required: Requirement[] | null;
  branchChecksStrict?: boolean | null;
  observedAt: string;
  attestationId: string | null;
  trailerAvailable: boolean;
  receiptVerification?: ReceiptVerification;
}

const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const repositoryPattern = /^[a-z0-9_.-]{1,100}$/i;

export function validRepository(repository: string): boolean {
  const [owner, name, extra] = repository.split('/');
  return extra === undefined && ownerPattern.test(owner ?? '') &&
    repositoryPattern.test(name ?? '') && name !== '.' && name !== '..';
}

export function parsePullUrl(value: string): PullRef | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password) return null;
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (!match || !validRepository(match[1])) return null;
    const number = Number(match[2]);
    return Number.isSafeInteger(number) && number > 0 ? { repository: match[1], number } : null;
  } catch {
    return null;
  }
}

export function groupChecks(checks: Check[], sha: string): Check[][] {
  const groups = new Map<string, Check[]>();
  for (const check of checks) {
    if (check.sha !== sha) continue;
    const key = JSON.stringify([check.name, check.appId ?? check.source]);
    const group = groups.get(key) ?? [];
    group.push(check);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => group.sort((a, b) => b.id - a.id));
}

function visibleProse(body: string): string {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[`~]*[ \t]*$|^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*$/gm,
    '',
  );
}

export function manualChecks(body: string): string[] {
  let verificationLevel = 0;
  const items = new Set<string>();
  for (const line of visibleProse(body).split('\n')) {
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (verificationLevel && level <= verificationLevel) verificationLevel = 0;
      if (/^(verification|test plan|validation|manual (?:checks|review)|not locally runnable)$/i.test(heading[2])) {
        verificationLevel ||= level;
      }
    }
    const task = /^\s*[-*+]\s+\[ \]\s+(.+)$/.exec(line);
    if (verificationLevel && task) items.add(task[1].trim());
  }
  return [...items];
}

export function reviewIntent(body: string): string {
  const prose = visibleProse(body).trim();
  const match = /^#{1,6}[ \t]+(?:summary|why|overview)[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]|(?![\s\S]))/im.exec(prose);
  return (match?.[1]?.trim() || prose.split(/\n\s*\n/, 1)[0]).slice(0, 1200);
}

export function requiredCheckEvidence(review: Pick<Review, 'required' | 'checks' | 'sha' | 'evidenceSources'>): { requirement: Requirement; state: string }[] {
  const latestChecks = groupChecks(review.checks, review.sha).map(([latest]) => latest);
  const coverage = review.evidenceSources.checkRuns && review.evidenceSources.commitStatuses;
  return (review.required ?? []).map(requirement => {
    const named = latestChecks.filter(check => check.name === requirement.name);
    const matching = named.filter(check => requirement.appId === null || check.appId === requirement.appId);
    const states = new Set(matching.map(check => check.state));
    const unidentifiedSource = requirement.appId !== null && named.some(check => check.appId === undefined);
    const state = states.size > 1 ? 'Conflicting results' : states.values().next().value ??
      (coverage && !unidentifiedSource ? 'Missing' : 'Unavailable');
    return { requirement, state };
  });
}

export function emptyCheckMessage(sources: EvidenceSources): string {
  return sources.checkRuns && sources.commitStatuses
    ? 'No current check results were returned.'
    : 'Current check results are incomplete because a GitHub source was unavailable.';
}

function markdown(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, '\\$&');
}

export function handoff(review: Review, revisionCheckedAt?: string): string {
  const lines = [
    `# Review handoff — ${markdown(review.repository)} #${review.number}`,
    '',
    markdown(review.title),
    '',
    `- Pull request: ${review.url}`,
    `- Observed head: \`${review.sha}\``,
    `- Observed at: ${review.observedAt}`,
    `- PR context digest: \`${review.contextDigest}\``,
    ...(revisionCheckedAt ? [`- PR revision rechecked at: ${revisionCheckedAt}`] : []),
    ...(revisionCheckedAt && review.checksDigest ? [
      `- Current GitHub checks rechecked at: ${revisionCheckedAt}`,
      `- Current GitHub checks digest: \`${review.checksDigest}\``,
    ] : []),
    `- PR state: ${markdown(review.state)}`,
    '',
    '## Intent from the pull request',
    '',
    review.intent ? markdown(review.intent) : 'No summary was provided.',
    '',
    '## Current GitHub checks',
    '',
  ];
  const groups = groupChecks(review.checks, review.sha);
  if (!groups.length) lines.push(emptyCheckMessage(review.evidenceSources));
  for (const [latest, ...previous] of groups) {
    lines.push(`- ${markdown(latest.name)} (${markdown(latest.source)}) — ${latest.state}${latest.url ? ` · ${latest.url}` : ''}`);
    for (const check of previous) lines.push(`  - Previous result: ${check.state}${check.url ? ` · ${check.url}` : ''}`);
  }
  lines.push('', '## Needs attention', '');
  for (const {requirement, state} of requiredCheckEvidence(review)) {
    if (state !== 'Passed') lines.push(`- Required check ${markdown(requirement.name)} — ${state}`);
  }
  if (review.required === null) lines.push('- GitHub branch check requirements are unavailable.');
  for (const item of review.manual) lines.push(`- PR checklist (open): ${markdown(item)}`);
  for (const run of review.linkedRuns) {
    const relation = run.sha === review.sha ? 'Current commit' : 'Different commit';
    lines.push(`- ${relation}: ${markdown(run.name)} — ${run.state} · \`${run.sha}\` · ${run.url}`);
  }
  for (const issue of review.issues) lines.push(`- ${markdown(issue)}`);
  lines.push('', '## ForgeCore gate receipt', '');
  if (review.receiptVerification) {
    const result = review.receiptVerification;
    lines.push(`- Receipt \`${result.id}\` — ${result.valid ? `Valid signature · ${result.decision}` : 'Invalid signature'}`);
    lines.push(`- Recorded in the verifier: ${result.recorded ? 'yes' : 'no'}`);
    lines.push(`- Gem-Gate trailer matched: ${result.trailerMatched ? 'yes' : 'no'}`);
    lines.push(`- Receipt scope: ${markdown(result.repository)} · ${markdown(result.branch)}`);
    lines.push('- A verified receipt establishes the signed gate decision for that scope.');
  } else lines.push(review.attestationId
    ? `Trailer ID \`${review.attestationId}\` — unverified. A gate receipt describes a repository and branch decision.`
    : review.trailerAvailable ? 'No Gem-Gate trailer was observed for the selected head.'
      : 'Gem-Gate trailer evidence is unavailable.');
  return lines.join('\n') + '\n';
}
