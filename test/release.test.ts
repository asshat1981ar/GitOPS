import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));

test('release archive includes the built runtime and excludes workspace material', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'gitops-pack-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await copyFile(join(workspace, 'package.json'), join(fixture, 'package.json'));
  const files = [
    'README.md', '.env', 'dist/index.html', 'dist/assets/index-hash.js',
    'dist/licenses/bootstrap-icons.txt', 'dist/licenses/inter.txt',
    'server/start.ts', 'server/api.ts', 'server/artifact-provenance.ts', 'server/production.ts', 'server/github.ts',
    'server/forgecore.ts', 'server/release-cli.ts', 'server/release-packet.ts', 'server/local.env', 'src/review.ts', 'src/main.ts',
    'vite.config.ts', 'test/release.test.ts', 'docs/workspace-notes.md',
  ];
  for (const name of files) {
    const path = join(fixture, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }

  const args = ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', join(fixture, '.npm-cache')];
  const npmCli = process.env.npm_execpath;
  const { stdout } = npmCli
    ? await exec(process.execPath, [npmCli, ...args], { cwd: fixture })
    : await exec('npm', args, { cwd: fixture });
  const [pack] = JSON.parse(stdout) as { files: { path: string }[] }[];
  assert.deepEqual(pack.files.map(file => file.path).sort(), [
    'README.md', 'dist/assets/index-hash.js', 'dist/index.html',
    'dist/licenses/bootstrap-icons.txt', 'dist/licenses/inter.txt', 'package.json',
    'server/api.ts', 'server/artifact-provenance.ts', 'server/forgecore.ts', 'server/github.ts', 'server/production.ts',
    'server/release-cli.ts', 'server/release-packet.ts',
    'server/start.ts', 'src/review.ts',
  ]);
});
