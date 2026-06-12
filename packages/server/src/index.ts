import { serve } from '@hono/node-server';
import { createApp, defaultServices } from './app';
import { loadServerConfig } from './config';
import { staticDirExists } from './http/staticRoutes';

const config = loadServerConfig();
const services = defaultServices();
const app = createApp({ services });

if (config.staticDir && !staticDirExists(config.staticDir)) {
  console.warn(
    `STATIC_DIR is set to '${config.staticDir}' but that directory was not found. ` +
      'Build the web app (pnpm --filter web build) or unset STATIC_DIR.',
  );
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`hubble server listening on http://localhost:${info.port}`);
  if (config.staticDir) {
    console.log(`serving static web app from ${config.staticDir}`);
  }
});

async function shutdown(): Promise<void> {
  await services.shutdown();
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
