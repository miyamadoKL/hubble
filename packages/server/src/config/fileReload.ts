/**
 * 設定ファイルの mtime ポーリングと SIGHUP によるホットリロード基盤。
 */
import { statSync } from 'node:fs';

export interface WatchedFile {
  path: string;
  reload: () => void | Promise<void>;
}

export interface FileReloadOptions {
  intervalSeconds: number;
  statImpl?: (path: string) => { mtimeMs: number } | null;
  log?: (message: string) => void;
  logError?: (message: string, err: unknown) => void;
}

/** ファイル監視の更新、即時 reload、停止と drain を操作するハンドル。 */
export interface FileReloadHandle {
  stop: () => Promise<void>;
  triggerReload: () => void;
  updateFiles: (files: WatchedFile[]) => void;
}

const defaultStat = (path: string): { mtimeMs: number } | null => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

export function startFileReload(
  files: WatchedFile[],
  options: FileReloadOptions,
): FileReloadHandle {
  const stat = options.statImpl ?? defaultStat;
  const log = options.log ?? (() => {});
  const logError = options.logError ?? (() => {});
  let watchedFiles = files;
  const lastMtime = new Map<string, number>();
  const missingWarned = new Set<string>();
  for (const file of files) {
    const st = stat(file.path);
    if (st) lastMtime.set(file.path, st.mtimeMs);
  }

  let reloadPromise: Promise<void> | undefined;
  let stopped = false;
  const runReload = (): void => {
    if (stopped || reloadPromise) return;
    const currentReload = Promise.resolve()
      .then(async () => {
        const reloads = new Set(watchedFiles.map((f) => f.reload));
        await Promise.all([...reloads].map((reload) => Promise.resolve(reload())));
      })
      .catch((err: unknown) => {
        logError('config reload failed', err);
      })
      .finally(() => {
        if (reloadPromise === currentReload) reloadPromise = undefined;
      });
    reloadPromise = currentReload;
  };

  const poll = (): void => {
    if (stopped) return;
    let changed = false;
    for (const file of watchedFiles) {
      const st = stat(file.path);
      const prev = lastMtime.get(file.path);
      if (!st) {
        if (prev !== undefined) {
          lastMtime.delete(file.path);
          if (!missingWarned.has(file.path)) {
            missingWarned.add(file.path);
            log(`config file '${file.path}' is missing; keeping current config`);
          }
        }
        continue;
      }
      if (missingWarned.has(file.path)) {
        missingWarned.delete(file.path);
      }
      if (prev === undefined) {
        lastMtime.set(file.path, st.mtimeMs);
        changed = true;
        continue;
      }
      if (st.mtimeMs !== prev) {
        lastMtime.set(file.path, st.mtimeMs);
        changed = true;
      }
    }
    if (changed) {
      log('config file change detected, reloading');
      runReload();
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.intervalSeconds > 0) {
    timer = setInterval(poll, options.intervalSeconds * 1000);
    timer.unref?.();
  }

  const onSighup = (): void => {
    log('SIGHUP received, reloading config');
    runReload();
  };
  process.on('SIGHUP', onSighup);

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (timer) clearInterval(timer);
    process.off('SIGHUP', onSighup);
    stopPromise = reloadPromise ?? Promise.resolve();
    return stopPromise;
  };

  return {
    stop,
    triggerReload: runReload,
    updateFiles: (nextFiles) => {
      if (stopped) return;
      watchedFiles = nextFiles;
      const nextPaths = new Set(nextFiles.map((file) => file.path));
      for (const path of lastMtime.keys()) {
        if (!nextPaths.has(path)) lastMtime.delete(path);
      }
      for (const path of missingWarned) {
        if (!nextPaths.has(path)) missingWarned.delete(path);
      }
      for (const file of nextFiles) {
        if (lastMtime.has(file.path)) continue;
        const st = stat(file.path);
        if (st) lastMtime.set(file.path, st.mtimeMs);
      }
    },
  };
}

export function parseReloadIntervalSeconds(env: Record<string, string | undefined>): number {
  const raw = env.CONFIG_RELOAD_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}
