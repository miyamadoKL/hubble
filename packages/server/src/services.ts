import type Database from 'better-sqlite3';
import type { ServerConfig } from './config';
import { TrinoClient } from './trino/client';
import { MetadataSource } from './metadata/source';
import { MetadataService } from './metadata/service';
import { QueryRegistry } from './query/registry';
import { QueryService } from './query/service';
import { NotebookRepository } from './store/notebooks';
import { SavedQueryRepository } from './store/savedQueries';
import { HistoryRepository } from './store/history';
import { backfillOwners } from './db/backfill';

/** All long-lived services the HTTP layer depends on. */
export interface Services {
  config: ServerConfig;
  trino: TrinoClient;
  metadata: MetadataService;
  queries: QueryService;
  registry: QueryRegistry;
  notebooks: NotebookRepository;
  savedQueries: SavedQueryRepository;
  history: HistoryRepository;
  shutdown: () => Promise<void>;
}

export interface BuildServicesOptions {
  /** Injectable fetch for tests (fake Trino). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (deterministic backoff). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (TTL/sweep). */
  now?: () => number;
}

/** Construct the full service graph from config + an open database. */
export function buildServices(
  config: ServerConfig,
  db: Database.Database,
  options: BuildServicesOptions = {},
): Services {
  const trino = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.source,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const metadataClient = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.metadataSource,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const metadataSource = new MetadataSource(metadataClient, config.trino.metadataSource);
  const metadata = new MetadataService(
    metadataSource,
    config.metadata.ttlSeconds * 1000,
    options.now,
  );

  // Backfill empty owners (from migration 0002) with the technical principal so
  // pre-existing rows become owned by the `none`-mode user (design.md §11).
  backfillOwners(db, config.trino.user);

  const history = new HistoryRepository(db);
  const notebooks = new NotebookRepository(db);
  const savedQueries = new SavedQueryRepository(db);

  const registry = new QueryRegistry({
    client: trino,
    defaultMaxRows: config.query.maxRows,
    concurrency: config.query.concurrency,
    ttlMs: config.query.ttlMinutes * 60_000,
    defaultOverflowMode: config.query.overflowMode,
    now: options.now,
  });

  const queries = new QueryService({ registry, history });

  return {
    config,
    trino,
    metadata,
    queries,
    registry,
    notebooks,
    savedQueries,
    history,
    shutdown: () => registry.shutdown(),
  };
}
