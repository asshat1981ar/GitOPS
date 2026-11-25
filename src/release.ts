import { groupChecks, requiredCheckEvidence } from './review.ts';
import type { collectReleasePacket, recheckReleasePacket } from '../server/release-packet.ts';

type Packet = Awaited<ReturnType<typeof collectReleasePacket>>;
type Report = Awaited<ReturnType<typeof recheckReleasePacket>>;
type ReleaseEntry = Packet['packet']['entries'][number];
type ArtifactRecord = {
  repository: string; sourceRevision: string; artifactName: string; sha256: string;
  issuer: string; signerWorkflow: string;
};

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing release review control: ${id}`);
  return found as T;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const found = document.createElement(tag);
  found.textContent = text;
  if (className) found.className = className;
  return found;
}

const inboxView = element('inbox-workspace');
const releaseView = element('release-workspace');
const inboxButton = element<HTMLButtonElement>('show-inbox');
const releaseButton = element<HTMLButtonElement>('show-release');
const collectForm = element<HTMLFormElement>('release-collect');
const recheckForm = element<HTMLFormElement>('release-recheck');
const inputs = element('release-inputs');
const status = element('release-status');
const result = element('release-result');
const resultTitle = element('release-result-title');
const add = element<HTMLButtonElement>('add-release-pr');
const name = element<HTMLInputElement>('release-name');
const packetFile = element<HTMLInputElement>('release-file');
const expectedDigest = element<HTMLInputElement>('release-digest');
let activePacket: Packet | null = null;

function switchView(release: boolean): void {
  inboxView.hidden = release;
  releaseView.hidden = !release;
  element('observed').hidden = release;
  inboxButton.setAttribute('aria-pressed', String(!release));
  releaseButton.setAttribute('aria-pressed', String(release));
  element<HTMLAnchorElement>('skip-view').href = release ? '#release-workspace' : '#review';
  (release ? releaseView : element('review')).focus();
}

inboxButton.addEventListener('click', () => switchView(false));
releaseButton.addEventListener('click', () => switchView(true));

function updateInputs(): void {
  const rows = [...inputs.querySelectorAll('label')];
  for (const [index, label] of rows.entries()) {
    label.textContent = `GitHub PR URL ${index + 1}`;
    const remove = label.parentElement?.querySelector('button');
    if (remove) {
      remove.hidden = rows.length <= 2;
      remove.setAttribute('aria-label', `Remove PR URL ${index + 1}`);
    }
  }
  add.disabled = rows.length >= 8;
}

let fieldId = 0;
function addInput(url = ''): HTMLInputElement {
  const row = node('div', '', 'release-input');
  const label = node('label', '');
  const input = node('input', '');
  input.type = 'url';
  input.required = true;
  input.maxLength = 350;
  input.placeholder = 'https://github.com/owner/repo/pull/123';
  input.id = `release-pr-${++fieldId}`;
  input.value = url;
  label.htmlFor = input.id;
  const remove = node('button', 'Remove', 'secondary');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
    updateInputs();
    add.focus();
  });
  row.append(label, input, remove);
  inputs.append(row);
  updateInputs();
  return input;
}

addInput();
addInput();
add.addEventListener('click', () => addInput().focus());
element('load-release-pilot').addEventListener('click', () => {
  inputs.replaceChildren();
  name.value = 'AutoDev and GitHubOpsGem pilot';
  addInput('https://github.com/asshat1981ar/AutoDev/pull/53');
  addInput('https://github.com/asshat1981ar/GitHubOpsGem/pull/11');
  name.focus();
});

async function post<T>(action: string, data: unknown): Promise<T> {
  const response = await fetch(`/api/release/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Release request failed.');
  return payload as T;
}

function issueList(entry: ReleaseEntry): string[] {
  const saved = entry.snapshot;
  if (!saved) return ['PR snapshot unavailable.'];
  const gaps = Array.isArray(saved.issues) ? saved.issues.filter(issue => typeof issue === 'string') : [];
  if (!saved.checksDigest) gaps.push('Current GitHub check evidence is incomplete.');
  if (saved.branchRequirementsObserved === null) gaps.push('Branch requirements unavailable.');
  if (Array.isArray(saved.branchRequirementsObserved)) {
    const required = saved.branchRequirementsObserved.filter(item =>
      typeof item?.name === 'string' && (item.appId === null || Number.isSafeInteger(item.appId)));
    const evidenceSources = saved.evidenceSources ?? { checkRuns: false, commitStatuses: false };
    for (const { requirement, state } of requiredCheckEvidence({
      required, evidenceSources, checks: saved.checks, sha: saved.revision.sha,
    })) {
      if (['Missing', 'Unavailable', 'Conflicting results'].includes(state)) {
        gaps.push(`Required check · ${requirement.name} · ${state}`);
      }
    }
  }
  for (const [check] of groupChecks(saved.checks, saved.revision.sha)) {
    if (check.state !== 'Passed') gaps.push(`${check.name} · ${check.state}`);
  }
  if (Array.isArray(saved.manualChecklistObserved)) {
    gaps.push(...saved.manualChecklistObserved.filter(item => typeof item === 'string')
      .map(item => `Unchecked PR item · ${item}`));
  }
  if (Array.isArray(saved.linkedRunsObserved) && saved.linkedRunsObserved.some(run => run?.sha !== saved.revision.sha)) {
    gaps.push('The PR links to CI on a different commit.');
  }
  if (saved.forgeCore?.state === 'trailer-absent') gaps.push('No Gem-Gate trailer found.');
  if (saved.forgeCore?.state === 'trailer-unverified') gaps.push('Gem-Gate trailer found. Receipt verification pending.');
  if (saved.forgeCore?.state === 'trailer-unavailable') gaps.push('Gem-Gate trailer evidence is unavailable.');
  return [...new Set(gaps)];
}

function timestamp(label: string, value: unknown): HTMLParagraphElement | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const paragraph = node('p', label + ' ');
  const time = node('time', date.toLocaleString());
  time.dateTime = value;
  paragraph.append(time);
  return paragraph;
}

function renderReviewHistory(entry: ReleaseEntry): HTMLElement {
  const section = node('section', '');
  section.append(node('h3', 'GitHub PR review history'));
  const history = entry.snapshot?.reviewDecisions;
  if (!history) {
    section.append(node('p', 'This packet did not collect GitHub PR review history.'));
  } else if (history.state === 'unavailable') {
    section.append(node('p', 'GitHub PR review history was unavailable during collection.'));
  } else {
    const observed = timestamp('Recorded during collection', history.observedAt);
    if (observed) section.append(observed);
    if (!history.decisions.length) section.append(node('p', 'No submitted decisions for the recorded commit.'));
    const labels = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', DISMISSED: 'Dismissed' };
    const list = node('ul', '');
    for (const decision of history.decisions) {
      const item = node('li', '');
      const link = node('a', `${labels[decision.state]} · ${decision.login ?? 'Unknown reviewer'}`);
      link.href = `${entry.url}#pullrequestreview-${decision.id}`;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      item.append(link);
      const submitted = timestamp('Submitted', decision.submittedAt);
      if (submitted) item.append(submitted);
      list.append(item);
    }
    if (list.childElementCount) section.append(list);
  }
  return section;
}

function renderEntry(entry: ReleaseEntry, checked?: Report['entries'][number]): HTMLElement {
  const row = node('details', '', 'item release-repository');
  const report = checked?.recheck ?? entry.recheck;
  const label = report.state === 'unchanged' ? (checked ? 'Checks match packet' : 'Unchanged during capture')
    : report.state === 'stale' ? 'Changed evidence' : 'Evidence unavailable';
  const summary = node('summary', '');
  const badges = node('span', '', 'release-state-set');
  badges.append(node('span', label, `release-state ${report.state}`));
  const policy = checked?.branchPolicy ?? entry.branchPolicy;
  if (policy) {
    const label = policy.state === 'changed' ? 'Policy changed'
      : policy.state === 'unavailable' ? 'Policy unavailable' : 'Policy matches';
    badges.append(node('span', label, `release-state ${policy.state}`));
  }
  summary.append(node('span', `${entry.repository} #${entry.number}`), badges);
  const content = node('div', '', 'item-body');
  const link = node('a', 'View pull request on GitHub');
  link.href = entry.url;
  link.rel = 'noopener noreferrer';
  link.target = '_blank';
  if (entry.snapshot) {
    if (typeof entry.snapshot.title === 'string') content.append(node('p', entry.snapshot.title));
    const revision = node('p', 'Recorded commit ');
    revision.append(node('code', entry.snapshot.revision.sha));
    content.append(revision);
    const observed = timestamp('Observed', entry.snapshot.observedAt);
    if (observed) content.append(observed);
  }
  if (checked?.current && checked.current.sha !== entry.snapshot?.revision.sha) {
    const current = node('p', 'Current commit ');
    current.append(node('code', checked.current.sha));
    content.append(current);
  }
  const checkedAt = timestamp(checked ? 'Rechecked' : 'Rechecked during capture', report.at);
  if (checkedAt) content.append(checkedAt);
  if (report.detail) content.append(node('p', report.detail));
  if (policy?.detail) content.append(node('p', policy.detail));
  if (policy?.state === 'changed') {
    const changes = node('ul', '');
    for (const [verb, items] of [['Added', policy.added], ['Removed', policy.removed]] as const) {
      for (const item of items) {
        const provider = item.appId === null ? 'any provider' : `GitHub App ${item.appId}`;
        changes.append(node('li', `${verb} required check · ${item.name} · ${provider}`));
      }
    }
    const strict = policy.upToDate;
    if (strict && strict.recorded !== null && strict.current !== null && strict.recorded !== strict.current) {
      changes.append(node('li', strict.current ? 'Base branch must now be up to date.' : 'Base branch no longer needs to be up to date.'));
    }
    if (changes.childElementCount) content.append(changes);
  }
  const gaps = issueList(entry);
  if (gaps.length) {
    const list = node('ul', '');
    list.append(...gaps.map(gap => node('li', gap)));
    content.append(list);
  }
  if (entry.snapshot) content.append(renderReviewHistory(entry));
  content.append(link);
  row.append(summary, content);
  return row;
}

function renderPacket(packet: Packet, report?: Report): void {
  activePacket = packet;
  resultTitle.textContent = typeof packet.packet.name === 'string' ? packet.packet.name : 'Release packet';
  element('release-result-context').textContent = report
    ? 'Live comparison of GitHub PR revisions, checks, and required-check policy.'
    : 'GitHub PR revisions, checks, and required-check policy rechecked during capture.';
  element('release-result-digest').textContent = packet.digest;
  const coverage = element('release-coverage');
  coverage.replaceChildren();
  const artifacts = (packet.packet as { artifacts?: ArtifactRecord[] }).artifacts;
  if (Array.isArray(artifacts) && artifacts.length) {
    const list = node('ul', '');
    for (const artifact of artifacts) {
      if (!artifact || ![artifact.artifactName, artifact.repository, artifact.issuer, artifact.signerWorkflow,
        artifact.sourceRevision, artifact.sha256].every(value => typeof value === 'string')) continue;
      const item = node('li', `${artifact.artifactName} · ${artifact.repository}`);
      item.append(node('p', `${artifact.issuer} · ${artifact.signerWorkflow}`),
        node('p', `Source commit ${artifact.sourceRevision}`),
        node('code', artifact.sha256));
      const recorded = timestamp('Verification recorded', (artifact as ArtifactRecord & { verifiedAt?: string }).verifiedAt);
      if (recorded) item.append(recorded);
      list.append(item);
    }
    coverage.append(node('h3', 'Artifact provenance in packet'),
      node('p', 'Verify the artifact bytes and issuer with the CLI.', 'muted'), list);
  } else {
    coverage.append(node('p', 'Artifact provenance uncollected.', 'muted'));
  }
  coverage.append(node('p', 'Release approval authority uncollected.', 'muted'));
  element('release-repositories').replaceChildren(...packet.packet.entries.map((entry, index) =>
    renderEntry(entry, report?.entries[index])));
  result.hidden = false;
  resultTitle.focus();
}

async function run(form: HTMLFormElement, hint: string, operation: () => Promise<void>): Promise<void> {
  if (collectForm.getAttribute('aria-busy') === 'true' || recheckForm.getAttribute('aria-busy') === 'true') return;
  form.setAttribute('aria-busy', 'true');
  const buttons = [collectForm, recheckForm].map(panel => panel.querySelector<HTMLButtonElement>('button[type=submit]')!);
  for (const button of buttons) button.disabled = true;
  status.textContent = hint;
  result.hidden = true;
  activePacket = null;
  try {
    await operation();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Release review failed.';
  } finally {
    form.setAttribute('aria-busy', 'false');
    for (const button of buttons) button.disabled = false;
  }
}

collectForm.addEventListener('submit', event => {
  event.preventDefault();
  const urls = [...inputs.querySelectorAll('input')].map(input => input.value.trim());
  void run(collectForm, 'Collecting GitHub evidence…', async () => {
    const packet = await post<Packet>('collect', { name: name.value.trim(), urls });
    const attention = packet.packet.entries.filter(entry => entry.recheck.state !== 'unchanged' || entry.branchPolicy?.state !== 'unchanged').length;
    status.textContent = attention ? `Packet collected. ${attention} repository rechecks need attention.` : 'Packet collected.';
    renderPacket(packet);
  });
});

recheckForm.addEventListener('submit', event => {
  event.preventDefault();
  const file = packetFile.files?.[0];
  if (!file) return;
  void run(recheckForm, 'Rechecking GitHub evidence…', async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error('Use a release packet under 2 MB.');
    let packet: Packet;
    try { packet = JSON.parse(await file.text()) as Packet; }
    catch { throw new Error('Choose a valid release packet JSON file.'); }
    const digest = expectedDigest.value.trim().toLowerCase();
    const report = await post<Report>('recheck', { packet, expectedDigest: digest || undefined });
    const matches = report.entries.filter(entry => entry.recheck.state === 'unchanged').length;
    const policies = report.entries.filter(entry => entry.branchPolicy?.state === 'unchanged').length;
    status.textContent = `PR revisions and checks matched for ${matches} of ${report.entries.length} repositories. Required-check policy matched for ${policies} of ${report.entries.length} repositories.`;
    renderPacket(packet, report);
  });
});

element('download-release').addEventListener('click', () => {
  if (!activePacket) return;
  const file = new Blob([JSON.stringify(activePacket, null, 2) + '\n'], { type: 'application/json' });
  const href = URL.createObjectURL(file);
  const link = node('a', '');
  link.href = href;
  link.download = 'gitops-release-packet.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
  status.textContent = 'Release packet downloaded.';
});
