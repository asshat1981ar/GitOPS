import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProductionServer } from './production.ts';

try {
  const configuredPort = process.env.GITOPS_PORT ?? '4173';
  const port = Number(configuredPort);
  if (!/^\d+$/.test(configuredPort) || port < 0 || port > 65535) {
    throw new Error('GITOPS_PORT must be an integer from 0 to 65535.');
  }
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const server = await createProductionServer(dist);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('GitOPS could not determine its local port.');
  console.log(`GitOPS is running at http://127.0.0.1:${address.port}/`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'GitOPS could not start.');
  process.exitCode = 1;
}
