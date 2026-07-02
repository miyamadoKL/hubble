/**
 * `MetadataService`（packages/server/src/metadata/service.ts）の
 * TTL + stale-while-revalidate キャッシュ挙動を検証するテストスイート。
 * 実際の Trino には接続せず、呼び出し回数を数える `FakeSource` を
 * `MetadataSource` の代わりに注入し、時刻も `clock` オブジェクトで
 * 制御することで TTL 境界を決定的にテストする。
 */
import { describe, it, expect } from 'vitest';
import type { Catalog } from '@hubble/contracts';
import { MetadataService } from './service';
import type { MetadataSource } from './source';

/** A counting fake source with controllable results. */
// 呼び出し回数を記録し、結果や失敗を自由に差し替えられる `MetadataSource` の
// フェイク実装。テストごとに fetchCatalogs/fetchSchemas の呼ばれた回数を
// 検証することでキャッシュがヒットしたか実際に fetch したかを確認する。
class FakeSource {
  catalogCalls = 0;
  schemaCalls = 0;
  catalogs: Catalog[] = [{ name: 'tpch' }];
  /** 次の fetchCatalogs 呼び出しを1回だけ失敗させるフラグ。 */
  failNext = false;

  fetchCatalogs(): Promise<Catalog[]> {
    this.catalogCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(this.catalogs);
  }
  fetchSchemas(): Promise<{ name: string }[]> {
    this.schemaCalls += 1;
    return Promise.resolve([{ name: 's1' }]);
  }
}

// FakeSource と可変クロック（{t: number} を更新して現在時刻を進める）を
// 組み合わせて MetadataService を組み立てるヘルパー。
function svc(source: FakeSource, ttlMs: number, clock: { t: number }): MetadataService {
  return new MetadataService(source as unknown as MetadataSource, ttlMs, () => clock.t);
}

describe('MetadataService TTL', () => {
  // 初回（ミス）はライブ取得され、TTL 内の再取得はキャッシュから返され
  // fetch が再実行されないことを検証する。
  it('serves live on miss, cache on hit within TTL', async () => {
    const source = new FakeSource();
    const clock = { t: 1000 };
    const service = svc(source, 5000, clock);

    const first = await service.getCatalogs();
    expect(first.source).toBe('live');
    expect(first.stale).toBe(false);
    expect(source.catalogCalls).toBe(1);

    clock.t += 1000; // within TTL
    const second = await service.getCatalogs();
    expect(second.source).toBe('cache');
    expect(second.stale).toBe(false);
    expect(source.catalogCalls).toBe(1); // no re-fetch
  });
});

describe('MetadataService stale-while-revalidate', () => {
  // TTL を超えたエントリは stale として即座に古い値が返り、その後
  // バックグラウンドで再取得が走って値が更新されることを検証する。
  it('serves stale immediately then refreshes in the background', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 1000, clock);

    await service.getCatalogs(); // populate
    expect(source.catalogCalls).toBe(1);

    clock.t += 5000; // now stale
    source.catalogs = [{ name: 'tpch' }, { name: 'mysql' }];
    const stale = await service.getCatalogs();
    expect(stale.source).toBe('cache');
    expect(stale.stale).toBe(true);
    expect(stale.items).toHaveLength(1); // old value served

    // Background revalidation has run.
    // マイクロタスクキューを1周させ、バックグラウンドの再取得が完了するのを待つ。
    await new Promise((r) => setTimeout(r, 0));
    expect(source.catalogCalls).toBe(2);

    const fresh = await service.getCatalogs();
    expect(fresh.source).toBe('cache');
    expect(fresh.stale).toBe(false);
    expect(fresh.items).toHaveLength(2);
  });

  // バックグラウンドの再取得が失敗しても、既存の stale な値を返し続け、
  // 進行中マーカーが解除されて次回呼び出しで再試行できることを検証する。
  it('keeps serving stale when the background refresh fails', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 1000, clock);
    await service.getCatalogs();

    clock.t += 5000;
    source.failNext = true;
    const stale = await service.getCatalogs();
    expect(stale.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // Still serves the cached value; a subsequent call retries.
    const retry = await service.getCatalogs();
    expect(retry.items).toHaveLength(1);
  });
});

describe('MetadataService.refresh', () => {
  // refresh() が TTL 判定を経ずに強制的に再取得し、以降のキャッシュ参照が
  // 新しい値を返すことを検証する。
  it('forces a re-fetch and resets freshness', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 100000, clock);
    await service.getCatalogs();
    expect(source.catalogCalls).toBe(1);

    source.catalogs = [{ name: 'x' }];
    await service.refresh();
    expect(source.catalogCalls).toBe(2);

    const after = await service.getCatalogs();
    expect(after.source).toBe('cache');
    expect(after.items).toEqual([{ name: 'x' }]);
  });
});
