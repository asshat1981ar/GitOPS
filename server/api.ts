import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectReleasePacket, recheckReleasePacket } from './release-packet.ts';
import { ForgeCore } from './forgecore.ts';
import { loadPullReviewDecisions, loadReleaseRecheck } from './pull-review-decisions.ts';
import { GitHubError, loadQueue, loadReview, loadRevision, loadExportRevision, receiptScope, type GitHub } from './github.ts';

const receiptLimit = 64 * 1024;
const releaseRequestLimit = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRequestBody(request: IncomingMessage, limit: number, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('error', reject);
    request.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length <= limit) chunks.push(chunk);
      else reject(new GitHubError(413, `The ${label} exceeds the permitted size.`));
    });
    request.on('end', () => {
      if (length > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new GitHubError(400, `The ${label} is not valid JSON.`)); }
    });
  });
}

async function handleReleaseRequest(request: IncomingMessage, client: GitHub, collect: boolean) {
  if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new GitHubError(403, 'Open GitOPS in its own tab to review a release.');
  }
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new GitHubError(415, 'Release review requests must use application/json.');
  }
  const body = await safeRequestBody(request, releaseRequestLimit, 'release request');
  if (!isRecord(body)) throw new GitHubError(400, 'Enter valid release information.');
  const recheck = (repository: string, number: number, reviewSha?: string) =>
    loadReleaseRecheck(client, repository, number, reviewSha);
  try {
    if (collect) {
      const { name, urls } = body;
      if (typeof name !== 'string' || name.length > 120 || !Array.isArray(urls) ||
          urls.length > 8 || !urls.every(url => typeof url === 'string' && url.length <= 350)) {
        throw new Error('Use a release name of at most 120 characters and up to eight GitHub PR URLs.');
      }
      return await collectReleasePacket(name, urls, {
        review: (repository, number) => loadReview(client, repository, number), recheck,
        reviewDecisions: (repository, number, sha) => loadPullReviewDecisions(client, repository, number, sha),
      });
    }
    const { packet, expectedDigest } = body;
    if (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest))) {
      throw new Error('Expected digest must be a 64-character SHA-256 value.');
    }
    if (isRecord(packet) && isRecord(packet.packet) && Array.isArray(packet.packet.entries) &&
        packet.packet.entries.length > 8) {
      throw new Error('Recheck packets with more than eight repositories using the CLI.');
    }
    return await recheckReleasePacket(packet, expectedDigest, recheck);
  } catch (error) {
    throw new GitHubError(400, error instanceof Error ? error.message : 'Release review request was invalid.');
  }
}

export async function handleGitOpsApi(
  request: IncomingMessage, response: ServerResponse, url: URL, client: GitHub,
): Promise<boolean> {
  const verification = url.pathname === '/api/verify-receipt';
  const revision = url.pathname === '/api/revision';
  const releaseCollect = url.pathname === '/api/release/collect';
  const release = releaseCollect || url.pathname === '/api/release/recheck';
  if (!verification && !revision && !release && url.pathname !== '/api/queue' && url.pathname !== '/api/review') return false;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const method = verification || release ? 'POST' : 'GET';
    if (request.method !== method) {
      response.setHeader('Allow', method);
      throw new GitHubError(405, `This endpoint accepts ${method} requests.`);
    }
    if (release) {
      response.end(JSON.stringify(await handleReleaseRequest(request, client, releaseCollect)));
      return true;
    }
    const repository = url.searchParams.get('repository') ?? '';
    if (url.pathname === '/api/queue') {
      response.end(JSON.stringify(await loadQueue(client, repository)));
      return true;
    }
    const number = Number(url.searchParams.get('number'));
    if (!Number.isSafeInteger(number) || number < 1) throw new GitHubError(400, 'Enter a valid pull request number.');
    if (revision) {
      const load = url.searchParams.get('evidence') === 'checks' ? loadExportRevision : loadRevision;
      response.end(JSON.stringify(await load(client, repository, number)));
      return true;
    }
    if (verification) {
      if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {
        throw new GitHubError(403, 'Open the review inbox to verify a receipt.');
      }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
        throw new GitHubError(415, 'The gate receipt must use application/json.');
      }
      const base = process.env.GITOPS_FORGECORE_URL?.trim();
      const token = process.env.GITOPS_FORGECORE_TOKEN?.trim();
      if (!base || !token) throw new GitHubError(503, 'No ForgeCore verifier is configured on this GitOPS server.');
      let verifier: ForgeCore;
      try { verifier = new ForgeCore(base, token); }
      catch { throw new GitHubError(503, 'The configured ForgeCore verifier URL is invalid.'); }
      const receipt = await safeRequestBody(request, receiptLimit, 'gate receipt');
      const scope = await receiptScope(client, repository, number, url.searchParams.get('head') ?? '');
      response.end(JSON.stringify(await verifier.verify(receipt, scope)));
      return true;
    }
    response.end(JSON.stringify(await loadReview(client, repository, number)));
  } catch (error) {
    response.statusCode = error instanceof GitHubError ? error.status : 502;
    response.end(JSON.stringify({
      error: error instanceof GitHubError ? error.message : verification ? 'The gate receipt could not be verified.' : 'GitHub could not be reached. Try again.',
    }));
  }
  return true;
}
