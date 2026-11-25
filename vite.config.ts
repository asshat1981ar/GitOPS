import { defineConfig, type Connect } from 'vite';
import { handleGitOpsApi } from './server/api.ts';
import { GitHub } from './server/github.ts';

const client = new GitHub();

const api: Connect.NextHandleFunction = (request, response, next) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void handleGitOpsApi(request, response, url, client).then(handled => {
    if (!handled) next();
  }, next);
};

export default defineConfig({
  server: { allowedHosts: ['terminal.local'], cors: false },
  preview: { allowedHosts: ['terminal.local'], cors: false },
  plugins: [{
    name: 'gitops-github-read-api',
    configureServer(server) { server.middlewares.use(api); },
    configurePreviewServer(server) { server.middlewares.use(api); },
  }],
});
