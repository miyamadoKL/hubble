/**
 * 設定ファイルの mtime ポーリングと SIGHUP によるホットリロード基盤。
 */
import { statSync } from 'node:fs';

export interface WatchedFile {
  path: string;
  reload: () => void | Promise<void>;
}

export interface FileReloadOptions {
  /** mtime ポーリング間隔（秒）。0 以下ならポーリングを行わず SIGHUP のみで reload する。 */
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

/**
 * 設定ファイル群を mtime ポーリングと SIGHUP の両方で監視し、変更検知時に
 * 対応する reload コールバックを実行するハンドルを構築する。
 * @param files 監視対象ファイルの初期集合。
 * @param options ポーリング間隔や stat/log の差し替え（テスト用）を含むオプション。
 * @returns 監視対象の更新、即時 reload、停止を行うハンドル。
 */
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
  // 実行中の reload がある間に来た追加のトリガー（別ファイルの mtime 変化や
  // SIGHUP の重複、triggerReload() の再呼び出し）は pendingRerun フラグに
  // 合流（コアレス）させる。poll() は runReload() を呼ぶ前に lastMtime を
  // 更新するため、進行中の reload 完了前に検出された変更はすでに「既知」の
  // mtime として記録されているが、その変更を反映した reload はまだ実行されて
  // いない。そこで進行中の reload が完了した時点で pendingRerun が立って
  // いれば、フラグを下ろしてから runReload() を呼び直し、取りこぼした変更を
  // 1 回の追加 reload にまとめて反映する。連続で何度トリガーされても、
  // 合流する追加実行は最大 1 回である。stopped の場合は従来どおり何もしない。
  let pendingRerun = false;
  const runReload = (): void => {
    if (stopped) return;
    if (reloadPromise) {
      pendingRerun = true;
      return;
    }
    const currentReload = Promise.resolve()
      .then(async () => {
        // 複数の監視対象パスが同じ reload コールバックを共有し得るため、
        // Set で重複を除いてから実行する（例: datasources.yaml と rbac.yaml の
        // 両方が同じ reloadConfig を指す）。
        const reloads = new Set(watchedFiles.map((f) => f.reload));
        await Promise.all([...reloads].map((reload) => Promise.resolve(reload())));
      })
      .catch((err: unknown) => {
        logError('config reload failed', err);
      })
      .finally(() => {
        if (reloadPromise === currentReload) reloadPromise = undefined;
        if (pendingRerun && !stopped) {
          pendingRerun = false;
          runReload();
        }
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

/** `CONFIG_RELOAD_INTERVAL_SECONDS` を解決する。未設定/不正値/負値は既定の 30 秒とする。 */
export function parseReloadIntervalSeconds(env: Record<string, string | undefined>): number {
  const raw = env.CONFIG_RELOAD_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}
