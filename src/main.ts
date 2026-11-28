import './release.ts';
import '@fontsource-variable/inter';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './style.css';
import { emptyCheckMessage, groupChecks, handoff, requiredCheckEvidence, parsePullUrl, revisionState, type ExportRevision, type PullRevision, type ReceiptVerification, type PullRef, type PullSummary, type Review } from './review.ts';

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
}

const repository = get<HTMLSelectElement>('repository');
const form = get<HTMLFormElement>('open-form');
const input = get<HTMLInputElement>('pr-url');
const queue = get('queue');
const queueTitle = get('queue-title');
const queueMessage = get('queue-message');
const reloadQueue = get<HTMLButtonElement>('reload-queue');
const main = get('review');
const detail = get('detail');
const reviewMessage = get('review-message');
const retry = get<HTMLButtonElement>('retry');
const observed = get<HTMLTimeElement>('observed');
const exportMessage = get('export-message');
const receiptForm = get<HTMLFormElement>('verify-form');
const receiptFile = get<HTMLInputElement>('receipt-file');
const receiptResult = get('receipt-result');
const exportButton = get<HTMLButtonElement>('export');
const receiptButton = receiptForm.querySelector<HTMLButtonElement>('button')!;
const revisionNotice = get('revision-notice');
const revisionMessage = get('revision-message');

const pilots = new Map([['asshat1981ar/AutoDev', 53], ['asshat1981ar/GitHubOpsGem', 11]]);
let selected: PullRef | null = null;
let review: Review | null = null;
let queueController: AbortController | undefined;
let reviewController: AbortController | undefined;
let revisionProbe: { controller: AbortController; result: Promise<string | null> } | null = null;
let stale = false;
let exporting = false;
let verifying = false;
let exportNotice = false;

function syncReviewActions(): void {
  exportButton.disabled = stale || exporting;
  receiptButton.disabled = stale || verifying;
}

function resetRevision(): void {
  revisionProbe?.controller.abort();
  revisionProbe = null;
  stale = false;
  exporting = false;
  verifying = false;
  exportNotice = false;
  revisionNotice.hidden = true;
  revisionMessage.textContent = '';
  syncReviewActions();
}

function markStale(message: string): void {
  stale = true;
  revisionNotice.hidden = false;
  revisionMessage.textContent = message;
  get('check-title').textContent = 'GitHub checks from the saved snapshot';
  syncReviewActions();
}

function clearRevisionProbe(controller: AbortController): void {
  if (revisionProbe?.controller === controller) revisionProbe = null;
}

function checkRevision(snapshot: Review, forExport = false): Promise<string | null> {
  if (review !== snapshot || stale) return Promise.resolve(null);
  if (revisionProbe && !forExport) return revisionProbe.result;
  if (forExport) revisionProbe?.controller.abort();
  const controller = new AbortController();
  const params: Record<string, string> = { repository: snapshot.repository, number: String(snapshot.number) };
  if (forExport) params.evidence = 'checks';
  const result = (async () => {
    try {
      const current = await request<PullRevision | ExportRevision>('/api/revision', params, controller.signal);
      if (review !== snapshot || stale || controller.signal.aborted) return null;
      if (revisionState(snapshot, current) === 'stale') {
        const changed = current.sha !== snapshot.sha
          ? `The pull request head changed to ${current.sha.slice(0, 7)}.`
          : current.baseRef !== snapshot.baseRef
            ? `The base branch changed to ${current.baseRef}.`
            : 'The pull request details changed.';
        markStale(`${changed} This snapshot is stale. Refresh to review and export the current revision.`);
        return null;
      }
      if (forExport) {
        if (!('checksDigest' in current) || current.checksDigest === null) {
          const issues = 'checkIssues' in current ? current.checkIssues.join(' ') : '';
          throw new Error(`GitHub check evidence is unavailable.${issues ? ` ${issues}` : ''}`);
        }
        if (current.checksDigest !== snapshot.checksDigest) {
          const change = snapshot.checksDigest === null
            ? 'GitHub checks are now available for this commit.'
            : 'GitHub checks changed for this commit.';
          markStale(`${change} This snapshot is stale. Refresh before exporting.`);
          return null;
        }
        exportNotice = false;
      }
      if (!exportNotice) revisionNotice.hidden = true;
      return new Date().toISOString();
    } catch (error) {
      if (review === snapshot && !controller.signal.aborted && !stale && (forExport || !exportNotice)) {
        revisionNotice.hidden = false;
        exportNotice = forExport;
        const detail = error instanceof Error ? ` ${error.message}` : '';
        revisionMessage.textContent = forExport
          ? `The current PR revision and check evidence could not be confirmed.${detail}`
          : `The current PR revision could not be confirmed.${detail}`;
      }
      return null;
    } finally {
      clearRevisionProbe(controller);
    }
  })();
  revisionProbe = { controller, result };
  return result;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function sourceLink(text: string, href: string): HTMLAnchorElement {
  const link = create('a', text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

async function request<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${path}?${new URLSearchParams(params)}`, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Could not load GitHub data.');
  return result as T;
}

function samePull(a: PullRef | null, b: PullRef): boolean {
  return a !== null && a.repository.toLowerCase() === b.repository.toLowerCase() && a.number === b.number;
}

function syncQueueSelection(): void {
  for (const button of queue.querySelectorAll<HTMLButtonElement>('button')) {
    const active = selected !== null &&
      button.dataset.repository?.toLowerCase() === selected.repository.toLowerCase() &&
      Number(button.dataset.number) === selected.number;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

async function loadQueue(repo: string): Promise<void> {
  queueController?.abort();
  const controller = new AbortController();
  queueController = controller;
  queue.replaceChildren();
  queueTitle.textContent = 'Recent pull requests';
  queueMessage.textContent = repo ? 'Loading pull requests…' : '';
  reloadQueue.disabled = true;
  if (!repo) return;

  try {
    const entries = await request<PullSummary[]>('/api/queue', { repository: repo }, controller.signal);
    if (controller.signal.aborted) return;
    const ordered = [...entries].sort((a, b) => Number(samePull(selected, b)) - Number(samePull(selected, a)));
    for (const entry of ordered) {
      const button = create('button', undefined, 'queue-item');
      button.type = 'button';
      button.dataset.repository = entry.repository;
      button.dataset.number = String(entry.number);
      button.append(create('strong', `${entry.repository.split('/')[1]} #${entry.number}`), create('span', entry.title));
      button.addEventListener('click', () => void openPull(entry));
      queue.append(button);
    }
    syncQueueSelection();
    queueTitle.textContent = `Queue (${entries.length})`;
    queueMessage.textContent = entries.length ? '' : 'No pull requests were returned.';
    if (!selected && entries.length) void openPull(entries[0]);
  } catch (error) {
    if (!controller.signal.aborted) queueMessage.textContent = error instanceof Error ? error.message : 'Could not load the queue.';
  } finally {
    if (!controller.signal.aborted) reloadQueue.disabled = false;
  }
}

function expandable(title: string): { item: HTMLDetailsElement; summary: HTMLElement; body: HTMLDivElement } {
  const item = create('details', undefined, 'item');
  const summary = create('summary');
  summary.append(create('span', title), create('i', undefined, 'bi bi-chevron-right'));
  summary.lastElementChild?.setAttribute('aria-hidden', 'true');
  const body = create('div', undefined, 'item-body');
  item.append(summary, body);
  return { item, summary, body };
}

function updateReceiptLabel(result?: ReceiptVerification): void {
  const label = document.getElementById('receipt-evidence-label');
  if (!label) return;
  label.textContent = `ForgeCore gate receipt · ${result ? (result.valid ? 'Valid signature' : 'Invalid signature') : 'Unverified'}`;
}

function renderReview(data: Review): void {
  const title = get('title');
  title.textContent = data.title.replace(/^(?:feat|fix|docs|chore|refactor|test|ci|build|perf)(?:\([^)]*\))?!?:\s+/i, '');
  if (title.textContent) title.textContent = title.textContent[0].toUpperCase() + title.textContent.slice(1);
  const meta = get('meta');
  meta.replaceChildren(
    create('span', `${data.repository.split('/')[1]} #${data.number}`),
    create('span', data.state),
    create('span', 'Commit'),
    create('code', data.sha.slice(0, 7)),
  );
  meta.lastElementChild?.setAttribute('title', data.sha);
  observed.dateTime = data.observedAt;
  const timestamp = new Date(data.observedAt);
  observed.textContent = `Observed ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(timestamp)}`;
  observed.title = timestamp.toLocaleString();

  get('check-title').textContent = 'Current GitHub checks';
  const attention = get('attention-items');
  attention.replaceChildren();
  const manual = [...data.manual].sort((a, b) => Number(/ by CI\b/i.test(a)) - Number(/ by CI\b/i.test(b)));
  const extra = create('div', undefined, 'item-list');
  for (const [index, note] of manual.entries()) {
    const { item, body } = expandable(note);
    body.append(create('p', 'Unchecked in the pull request verification checklist.'), sourceLink('View pull request', data.url));
    (index ? extra : attention).append(item);
  }
  for (const run of data.linkedRuns.filter(run => run.sha !== data.sha)) {
    const { item, body } = expandable(`CI run on a different commit · ${run.name}`);
    body.append(create('p', `${run.state} on commit ${run.sha.slice(0, 7)}. The current head is ${data.sha.slice(0, 7)}.`), sourceLink('View workflow run', run.url));
    attention.append(item);
  }
  if (extra.childElementCount) {
    const { item, body } = expandable(`Other unchecked PR items (${extra.childElementCount})`);
    item.classList.add('minor');
    body.append(extra);
    attention.append(item);
  }
  for (const { requirement, state } of requiredCheckEvidence(data)) {
    if (state !== 'Passed') attention.append(create('p', `Required check · ${requirement.name} · ${state}`, 'item plain'));
  }
  for (const issue of data.issues) attention.append(create('p', issue, 'item plain'));
  if (data.attestationId) {
    const { item, summary, body } = expandable('ForgeCore gate receipt · Unverified');
    summary.firstElementChild?.setAttribute('id', 'receipt-evidence-label');
    body.append(create('p', `Gem-Gate trailer ${data.attestationId}. A trailer identifies a gate decision for a repository and branch.`));
    attention.append(item);
  }
  if (!attention.childElementCount) attention.append(create('p', 'No open items found in the collected evidence.', 'item plain'));

  const checks = get('checks');
  checks.replaceChildren();
  const checkNote = get('check-note');
  checkNote.textContent = data.required === null ? 'GitHub branch check requirements are unavailable.' :
    data.required.length ? `${data.required.length} required check${data.required.length === 1 ? '' : 's'} reported by GitHub.` :
      'GitHub reports no required checks for this base branch.';
  const groups = groupChecks(data.checks, data.sha);
  const moreChecks = create('div', undefined, 'item-list');
  const order = ['Failed', 'Running', 'Cancelled', 'Unknown', 'Passed', 'Neutral', 'Skipped'];
  groups.sort(([a], [b]) => order.indexOf(a.state) - order.indexOf(b.state) ||
    Number(b.name.startsWith('Rust') || b.name.startsWith('Node') || b.name === 'CodeRabbit') -
    Number(a.name.startsWith('Rust') || a.name.startsWith('Node') || a.name === 'CodeRabbit'));
  for (const [index, [latest, ...previous]] of groups.entries()) {
    const { item, summary, body } = expandable(latest.name);
    const state = create('span', latest.state, `check-state ${latest.state.toLowerCase()}`);
    summary.insertBefore(state, summary.lastElementChild);
    body.append(create('p', latest.source));
    if (latest.url) body.append(sourceLink('View latest result', latest.url));
    const matchingRun = data.linkedRuns.find(run => run.sha === latest.sha && latest.url?.startsWith(`${run.url}/job/`));
    if (matchingRun) body.append(sourceLink('View linked workflow', matchingRun.url));
    if (previous.length) {
      const history = create('ul', undefined, 'history');
      for (const check of previous) {
        const entry = create('li', `Previous result · ${check.state}`);
        if (check.url) entry.append(' · ', sourceLink('View result', check.url));
        history.append(entry);
      }
      body.append(history);
    }
    (index < 3 ? checks : moreChecks).append(item);
  }
  if (moreChecks.childElementCount) {
    const { item, body } = expandable(`More checks (${moreChecks.childElementCount})`);
    item.classList.add('minor');
    body.append(moreChecks);
    checks.append(item);
  }
  if (!checks.childElementCount) checks.append(create('p', emptyCheckMessage(data.evidenceSources), 'item plain'));

  const origin = get<HTMLAnchorElement>('origin');
  origin.href = data.url;
  origin.target = '_blank';
  origin.rel = 'noopener noreferrer';
  origin.textContent = `View ${data.repository} #${data.number} on GitHub`;
}

async function openPull(ref: PullRef): Promise<void> {
  selected = ref;
  review = null;
  resetRevision();
  reviewController?.abort();
  const controller = new AbortController();
  reviewController = controller;
  syncQueueSelection();
  detail.hidden = true;
  retry.hidden = true;
  observed.textContent = '';
  observed.removeAttribute('datetime');
  exportMessage.textContent = '';
  receiptResult.textContent = '';
  receiptForm.reset();
  get<HTMLDetailsElement>('receipt').open = false;
  reviewMessage.textContent = `Loading pull request #${ref.number}…`;
  main.setAttribute('aria-busy', 'true');

  try {
    const data = await request<Review>('/api/review', { repository: ref.repository, number: String(ref.number) }, controller.signal);
    if (controller.signal.aborted || !samePull(selected, ref)) return;
    review = data;
    renderReview(data);
    reviewMessage.textContent = '';
    detail.hidden = false;
  } catch (error) {
    if (!controller.signal.aborted) {
      reviewMessage.textContent = error instanceof Error ? error.message : 'Could not load the pull request.';
      retry.hidden = false;
    }
  } finally {
    if (!controller.signal.aborted) main.setAttribute('aria-busy', 'false');
  }
}

function selectRepository(repo: string): void {
  form.hidden = Boolean(repo);
  selected = null;
  review = null;
  resetRevision();
  reviewController?.abort();
  detail.hidden = true;
  retry.hidden = true;
  observed.textContent = '';
  observed.removeAttribute('datetime');
  main.setAttribute('aria-busy', 'false');
  reviewMessage.textContent = repo ? 'Choose a pull request from the queue.' : 'Enter a GitHub pull request URL to start a review.';
  void loadQueue(repo);
  const pilot = pilots.get(repo);
  if (pilot) void openPull({ repository: repo, number: pilot });
}

repository.addEventListener('change', () => selectRepository(repository.value));
form.addEventListener('submit', event => {
  event.preventDefault();
  const ref = parsePullUrl(input.value);
  const message = get('open-message');
  if (!ref) {
    message.textContent = 'Enter a valid github.com pull request URL.';
    return;
  }
  message.textContent = '';
  void openPull(ref);
  void loadQueue(ref.repository);
});
reloadQueue.addEventListener('click', () => {
  const repo = repository.value || selected?.repository;
  if (repo) void loadQueue(repo);
});
for (const id of ['refresh', 'refresh-revision', 'retry']) get(id).addEventListener('click', () => {
  if (selected) void openPull(selected);
});
exportButton.addEventListener('click', async () => {
  const snapshot = review;
  if (!snapshot || stale || exporting) return;
  exporting = true;
  syncReviewActions();
  exportMessage.textContent = 'Checking the PR revision and GitHub checks…';
  try {
    const checkedAt = await checkRevision(snapshot, true);
    if (review !== snapshot) return;
    if (!checkedAt) {
      exportMessage.textContent = stale ? 'Refresh the review before exporting.' : 'Export paused. Try again when GitHub is reachable.';
      return;
    }
    const blob = new Blob([handoff(snapshot, checkedAt)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const download = create('a');
    download.href = url;
    download.download = `gitops-${snapshot.repository.replace('/', '-')}-pr-${snapshot.number}-${snapshot.sha.slice(0, 7)}.md`;
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    exportMessage.textContent = 'Handoff exported.';
  } finally {
    if (review === snapshot) {
      exporting = false;
      syncReviewActions();
    }
  }
});

receiptForm.addEventListener('submit', async event => {
  event.preventDefault();
  const snapshot = review;
  const file = receiptFile.files?.[0];
  if (!snapshot || !file || stale || verifying) return;
  if (file.size > 64 * 1024) {
    receiptResult.textContent = 'The gate receipt exceeds 64 KB.';
    return;
  }
  verifying = true;
  syncReviewActions();
  receiptResult.textContent = 'Verifying receipt with ForgeCore…';
  delete snapshot.receiptVerification;
  updateReceiptLabel();
  try {
    const params = new URLSearchParams({ repository: snapshot.repository, number: String(snapshot.number), head: snapshot.sha });
    const response = await fetch(`/api/verify-receipt?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file,
    });
    const result = await response.json();
    if (review !== snapshot) return;
    if (response.status === 409) {
      markStale('The pull request changed. This snapshot is stale. Refresh before verifying a receipt.');
    }
    if (!response.ok) throw new Error(result.error);
    if (stale) return;
    const verification = result as ReceiptVerification;
    snapshot.receiptVerification = verification;
    updateReceiptLabel(verification);
    receiptResult.textContent = verification.valid
      ? `Valid signature · Decision ${verification.decision} · ${verification.recorded ? 'Recorded by ForgeCore' : 'Not recorded by this verifier'} · ${verification.trailerMatched ? 'Gem-Gate trailer matched' : 'No matching commit trailer'}. Receipt scope: ${verification.repository} · ${verification.branch}.`
      : 'Invalid signature. ForgeCore did not validate this receipt.';
  } catch (error) {
    if (review === snapshot) receiptResult.textContent = error instanceof Error ? error.message : 'Could not verify the receipt.';
  } finally {
    if (review === snapshot) {
      verifying = false;
      syncReviewActions();
    }
  }
});

function watchRevision(): void {
  if (review && !exporting && !document.hidden && !get('inbox-workspace').hidden) {
    void checkRevision(review);
  }
}

document.addEventListener('visibilitychange', watchRevision);
window.setInterval(watchRevision, 120_000);
selectRepository(repository.value);
