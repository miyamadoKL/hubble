import { serve } from '@hono/node-server';
import { createApp, defaultServices } from './app';
import { loadServerConfig } from './config';
import { staticDirExists } from './http/staticRoutes';

const config = loadServerConfig();

// Report the selected persistence backend (DATABASE_URL vs DB_PATH) once at
// startup, without leaking credentials embedded in a connection string.
if (config.database.kind === 'postgres') {
  console.log('hubble persistence backend: postgres (DATABASE_URL)');
} else {
  console.log(`hubble persistence backend: sqlite (${config.database.path})`);
}

const services = await defaultServices();
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
