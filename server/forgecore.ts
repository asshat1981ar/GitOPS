import { GitHubError } from './github.ts';
import type { ReceiptVerification } from '../src/review.ts';

interface Scope {
  repository: string;
  headRef: string;
  attestationId: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class ForgeCore {
  endpoint: URL;
  token: string;
  fetcher: typeof fetch;

  constructor(baseUrl: string, token: string, fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error('ForgeCore requires an HTTPS URL or a loopback HTTP URL.');
    }
    url.pathname = url.pathname.replace(/\/$/, '') + '/api/v1/gate/verify';
    this.endpoint = url;
    this.token = token;
    this.fetcher = fetcher;
  }

  async verify(input: unknown, scope: Scope): Promise<ReceiptVerification> {
    const receipt = object(input);
    const id = receipt.attestation_id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) ||
        !['PASS', 'WARN', 'BLOCK'].includes(String(receipt.decision))) {
      throw new GitHubError(400, 'Upload a ForgeCore gate receipt in JSON format.');
    }
    if (typeof receipt.repository !== 'string' || receipt.repository.toLowerCase() !== scope.repository.toLowerCase() ||
        receipt.target_ref !== scope.headRef) {
      throw new GitHubError(422, 'The receipt repository or branch does not match the pull request head.');
    }
    if (scope.attestationId && scope.attestationId !== id) {
      throw new GitHubError(422, 'The receipt ID does not match the Gem-Gate commit trailer.');
    }
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(receipt),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new GitHubError(502, 'ForgeCore could not be reached.');
    }
    if (response.status === 422 || response.status === 400) {
      throw new GitHubError(422, 'ForgeCore could not parse the gate receipt.');
    }
    if (!response.ok) throw new GitHubError(502, `ForgeCore verification is unavailable (HTTP ${response.status}).`);
    const verified = object(await response.json().catch(() => null));
    if (typeof verified.valid !== 'boolean' || typeof verified.recorded !== 'boolean' ||
        verified.attestation_id !== id || (verified.recorded && !verified.valid)) {
      throw new GitHubError(502, 'ForgeCore returned an unexpected verification result.');
    }
    return {
      id, valid: verified.valid, recorded: verified.recorded,
      trailerMatched: scope.attestationId === id,
      decision: verified.valid ? String(receipt.decision) : null,
      repository: scope.repository, branch: scope.headRef,
    };
  }
}
