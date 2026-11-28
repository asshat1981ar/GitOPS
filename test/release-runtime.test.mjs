import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));

test('the packed application serves the built client and API after clean extraction',
  { timeout: 120_000 }, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'gitops-release-'));
    let server;
    t.after(async () => {
      if (server?.pid && server.exitCode === null && server.signalCode === null) {
        const closed = once(server, 'exit');
        server.kill();
        await closed;
      }
      await rm(temp, { recursive: true, force: true });
    });
    const args = ['pack', '--pack-destination', temp, '--cache', join(temp, 'npm-cache')];
    const npm = process.env.npm_execpath;
    if (npm) await exec(process.execPath, [npm, ...args], { cwd: workspace });
    else await exec('npm', args, { cwd: workspace });
    const archives = (await readdir(temp)).filter(file => file.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    await exec('tar', ['-xzf', archives[0]], { cwd: temp });
    const extracted = join(temp, 'package');
    await assert.rejects(access(join(extracted, 'node_modules')), { code: 'ENOENT' });
    await assert.rejects(access(join(extracted, '.env')), { code: 'ENOENT' });
    await assert.rejects(
      exec(process.execPath, ['server/release-cli.ts'], { cwd: extracted }),
      error => error.code === 1 && /Usage: node server\/release-cli\.ts/.test(error.stderr),
    );

    server = spawn(process.execPath, ['server/start.ts'], {
      cwd: extracted,
      env: { ...process.env, GITOPS_PORT: '0', GITOPS_GITHUB_TOKEN: '',
        GITOPS_FORGECORE_TOKEN: '', GITOPS_FORGECORE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    server.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: server.stdout });
    const signal = AbortSignal.timeout(15_000);
    const [line] = await Promise.race([
      once(lines, 'line', { signal }),
      once(server, 'close', { signal }).then(([code]) => {
        throw new Error(`Extracted server exited with status ${code}. ${stderr.trim()}`);
      }),
    ]);
    lines.close();
    const address = /GitOPS is running at (http:\/\/127\.0\.0\.1:[1-9][0-9]*\/)/.exec(line)?.[1];
    assert.ok(address, line);
    const index = await fetch(address, { signal });
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /GitOPS Review Inbox/);
    const script = /src="(\/assets\/[\w-]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'The built index references a JavaScript asset');
    const asset = await fetch(new URL(script, address), { signal });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await asset.text()).length);
    const api = await fetch(new URL('/api/queue?repository=invalid', address), { signal });
    assert.equal(api.status, 400);
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.match((await api.json()).error, /GitHub repository/);
  });
