import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitHub } from '../server/github.ts';

test('built local server serves assets and the existing same-origin API', async t => {
  const { createProductionServer } = await import('../server/production.ts');
  const dist = await mkdtemp(join(tmpdir(), 'gitops-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<script src="/assets/test-A1b2.js" type="module"></script>');
  await writeFile(join(dist, 'assets/test-A1b2.js'), 'export const example = 1;');
  const upstream = new GitHub(async input => {
    assert.equal(new URL(String(input)).origin, 'https://api.github.com');
    return Response.json([{ number: 4, title: 'Feature', state: 'open', draft: false }]);
  }, '');
  const server = await createProductionServer(dist, upstream);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.match(await index.text(), /test-A1b2/);
  const asset = await fetch(base + '/assets/test-A1b2.js', { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await asset.text(), '');

  const queue = await fetch(base + '/api/queue?repository=owner%2Frepo');
  assert.equal(queue.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await queue.json(), [{ repository: 'owner/repo', number: 4, title: 'Feature', state: 'Open' }]);
  const invalid = await fetch(base + '/api/unknown');
  assert.equal(invalid.status, 404);
  assert.equal(typeof (await invalid.json()).error, 'string');
  const crossOrigin = await fetch(base + '/api/queue?repository=owner%2Frepo', {
    headers: { Origin: 'https://outside.example', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossOrigin.status, 403);

  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base, { headers: { Host: 'outside.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(base + '/README.md')).status, 404);
});

test('built local server fails early when the browser build is missing', async t => {
  const { createProductionServer } = await import('../server/production.ts');
  const dist = await mkdtemp(join(tmpdir(), 'gitops-buildless-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await assert.rejects(createProductionServer(dist), /npm run build/);
});

test('the browser release API assembles a packet and rejects invalid input before remote reads', async t => {
  const { createProductionServer } = await import('../server/production.ts');
  const dist = await mkdtemp(join(tmpdir(), 'gitops-release-ui-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<title>GitOPS</title>');
  const sha = 'a'.repeat(40);
  let requests = 0;
  let reviewReads = 0;
  const client = new GitHub(async input => {
    requests++;
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/reviews')) reviewReads++;
    if (path.endsWith('/pulls/1/reviews')) return Response.json([
      { id: 42, state: 'APPROVED', commit_id: sha, submitted_at: '2026-11-22T22:00:00Z', user: { login: 'reviewer' } },
    ]);
    if (path.endsWith('/pulls/2/reviews')) return Response.json([]);
    if (/\/pulls\/\d+$/.test(path)) {
      return Response.json({
        title: 'Check release', state: 'open', draft: false, body: '',
        head: { sha, ref: 'feature' }, base: { ref: 'main' },
      });
    }
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
    if (path.endsWith('/statuses') || path.endsWith('/rules/branches/main')) return Response.json([]);
    if (path.endsWith('/branches/main')) return Response.json({ protected: false });
    assert.ok(path.endsWith(`/commits/${sha}`));
    return Response.json({ commit: { message: 'Feature' } });
  }, '');
  const server = await createProductionServer(dist, client);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;
  const headers = { 'Content-Type': 'application/json' };
  const urls = ['https://github.com/example/auto/pull/1', 'https://github.com/example/gem/pull/2'];
  const send = (path: string, body: unknown) => fetch(origin + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  const wrongMethod = await fetch(origin + '/api/release/collect');
  assert.equal(wrongMethod.status, 405);
  const duplicate = await send('/api/release/collect', { name: 'Pilot', urls: [urls[0], urls[0]] });
  assert.equal(duplicate.status, 400);
  const invalid = await send('/api/release/recheck', { packet: {} });
  assert.equal(invalid.status, 400);
  assert.equal(requests, 0);

  const collected = await send('/api/release/collect', { name: 'Pilot', urls });
  assert.equal(collected.status, 200);
  const packet = await collected.json();
  assert.equal(packet.packet.entries.length, 2);
  assert.deepEqual(packet.packet.entries[0].snapshot.reviewDecisions.decisions, [
    { id: 42, state: 'APPROVED', login: 'reviewer', submittedAt: '2026-11-22T22:00:00.000Z' },
  ]);
  assert.deepEqual(packet.packet.entries[1].snapshot.reviewDecisions.decisions, []);
  assert.equal(reviewReads, 2);
  const checked = await send('/api/release/recheck', { packet, expectedDigest: packet.digest });
  assert.equal(checked.status, 200);
  assert.equal(reviewReads, 2);
  assert.deepEqual((await checked.json()).entries.map((entry: { recheck: { state: string } }) => entry.recheck.state),
    ['unchanged', 'unchanged']);
});
