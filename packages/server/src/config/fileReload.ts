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

export interface FileReloadHandle {
  stop: () => void;
  triggerReload: () => void;
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
  const lastMtime = new Map<string, number>();
  const missingWarned = new Set<string>();
  for (const file of files) {
    const st = stat(file.path);
    if (st) lastMtime.set(file.path, st.mtimeMs);
  }

  let reloading = false;
  const runReload = (): void => {
    if (reloading) return;
    reloading = true;
    void (async () => {
      try {
        await Promise.all(files.map((f) => Promise.resolve(f.reload())));
      } catch (err) {
        logError('config reload failed', err);
      } finally {
        reloading = false;
      }
    })();
  };

  const poll = (): void => {
    let changed = false;
    for (const file of files) {
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

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      process.off('SIGHUP', onSighup);
    },
    triggerReload: runReload,
  };
}

export function parseReloadIntervalSeconds(env: Record<string, string | undefined>): number {
  const raw = env.CONFIG_RELOAD_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}
