import type { Hono } from 'hono';
import { openMemoryDatabase } from '../db';
import { loadServerConfig, type ServerConfig } from '../config';
import { buildServices, type Services } from '../services';
import { createApp } from '../app';
import type { AuthVariables, RemoteAddressFn } from '../auth/middleware';
import type { FakeScenario } from './fakeTrino';
import { FakeTrino } from './fakeTrino';

export interface TestContext {
  app: Hono<{ Variables: AuthVariables }>;
  services: Services;
  fake: FakeTrino;
}

/**
 * Build a fully-wired app backed by an in-memory SQLite db and a fake Trino.
 * Backoff sleeps resolve immediately so tests run fast.
 */
export async function createTestContext(
  options: {
    scenarios?: FakeScenario[];
    configOverrides?: Partial<ServerConfig>;
    env?: Record<string, string | undefined>;
    /** Override backoff sleep (e.g. to record requested delays). Defaults to a no-op. */
    sleepImpl?: (ms: number) => Promise<void>;
    /** Override the peer address the auth middleware sees (proxy-mode tests). */
    remoteAddress?: RemoteAddressFn;
    /** Start the in-process scheduler tick loop (default: false, API only). */
    startScheduler?: boolean;
  } = {},
): Promise<TestContext> {
  const fake = new FakeTrino(options.scenarios ?? []);
  const baseConfig = loadServerConfig(options.env ?? {});
  const config: ServerConfig = {
    ...baseConfig,
    ...options.configOverrides,
    trino: { ...baseConfig.trino, baseUrl: 'http://trino.test', ...options.configOverrides?.trino },
    query: { ...baseConfig.query, ...options.configOverrides?.query },
    metadata: { ...baseConfig.metadata, ...options.configOverrides?.metadata },
    defaults: { ...baseConfig.defaults, ...options.configOverrides?.defaults },
    guard: { ...baseConfig.guard, ...options.configOverrides?.guard },
    scheduler: {
      ...baseConfig.scheduler,
      // Default: tick loop off so route/CRUD tests are deterministic.
      enabled: options.startScheduler ?? false,
      ...options.configOverrides?.scheduler,
    },
  };

  const db = await openMemoryDatabase();
  const services = await buildServices(config, db, {
    fetchImpl: fake.fetch,
    sleepImpl: options.sleepImpl ?? (() => Promise.resolve()),
    schedulerSleep: () => Promise.resolve(),
  });
  await services.scheduler.start();
  const app = createApp({ services, remoteAddress: options.remoteAddress });
  return { app, services, fake };
}

/** Poll until a query reaches a terminal state (test convenience). */
export async function waitForTerminal(services: Services, queryId: string): Promise<void> {
  const exec = services.registry.get(queryId);
  if (!exec) return;
  await exec.settled;
}
