import { lstat, readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { handleGitOpsApi } from './api.ts';
import { GitHub } from './github.ts';

const types = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
]);
const contentSecurityPolicy = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

interface Asset { path: string; type: string; cache: string }

async function buildAssets(dist: string): Promise<Map<string, Asset>> {
  const index = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  if (!(await lstat(index).catch(() => null))?.isFile() ||
      !(await lstat(assets).catch(() => null))?.isDirectory()) {
    throw new Error('GitOPS browser build is missing. Run npm run build before starting GitOPS.');
  }
  const html = { path: index, type: 'text/html; charset=utf-8', cache: 'no-cache' };
  const files = new Map([['/', html], ['/index.html', html]]);
  for (const asset of await readdir(assets, { withFileTypes: true })) {
    const type = types.get(extname(asset.name));
    if (asset.isFile() && type && /^[a-z0-9_-]+\.[a-z0-9]+$/i.test(asset.name)) {
      files.set('/assets/' + asset.name, {
        path: join(assets, asset.name), type, cache: 'public, max-age=31536000, immutable',
      });
    }
  }
  return files;
}

function sendError(response: ServerResponse, status: number, error: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ error }));
}

export async function createProductionServer(dist: string, client = new GitHub()) {
  const files = await buildAssets(dist);
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => {
      sendError(response, 500, 'GitOPS could not serve the requested resource.');
    });
  });

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const address = server.address();
    const host = request.headers.host;
    if (!address || typeof address === 'string' ||
        (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`)) {
      sendError(response, 403, 'Open GitOPS using its local address.');
      return;
    }
    const target = request.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
      sendError(response, 400, 'Invalid request path.');
      return;
    }
    const origin = `http://${host}`;
    const url = new URL(target, origin);
    if (url.pathname.startsWith('/api/')) {
      const site = request.headers['sec-fetch-site'];
      if ((request.headers.origin && request.headers.origin !== origin) ||
          (site && site !== 'same-origin' && site !== 'none')) {
        sendError(response, 403, 'Open GitOPS in its own tab to use the API.');
        return;
      }
      if (!await handleGitOpsApi(request, response, url, client)) {
        sendError(response, 404, 'Unknown GitOPS API endpoint.');
      }
      return;
    }

    const file = files.get(url.pathname);
    if (!file) {
      sendError(response, 404, 'Resource not found.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendError(response, 405, 'This resource accepts GET and HEAD requests.');
      return;
    }
    const bytes = await readFile(file.path);
    response.setHeader('Content-Type', file.type);
    response.setHeader('Cache-Control', file.cache);
    response.setHeader('Content-Length', bytes.byteLength);
    response.end(request.method === 'HEAD' ? undefined : bytes);
  }
  return server;
}
