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

// Start the in-process query scheduler (Query Scheduling feature). This performs
// crash recovery (aborting orphaned runs) and, unless SCHEDULER_ENABLED=false,
// starts the tick loop. The API is live regardless of the scheduler state.
await services.scheduler.start();
if (config.scheduler.enabled) {
  console.log(`hubble scheduler enabled (tick every ${config.scheduler.tickSeconds}s)`);
} else {
  console.log('hubble scheduler disabled (SCHEDULER_ENABLED=false)');
}

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
