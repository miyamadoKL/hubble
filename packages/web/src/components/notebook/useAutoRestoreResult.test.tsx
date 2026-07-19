// useAutoRestoreResult の「視界外退出→再進入を跨いでも再試行しない」挙動を検証する。
// codex 指摘: この回帰テストは production の useEffect を書き写した再現ではなく、
// 実際に SqlCell が使う production hook を mount → unmount → remount する形で
// 検証すべき。ここでは hook を薄いプローブコンポーネントに載せ、ViewportCell が
// 視界外のセルをアンマウントし、再度視界に入ったときに新しい root で
// 再マウントする様子をそのまま模して駆動する（hasAttemptedRestore/
// markRestoreAttempted 自体もモックせず、execution ストアの本物の実装を使う）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchQuerySnapshot = vi.fn();
const fetchQueryRows = vi.fn();
vi.mock('../../execution/api', () => ({
  createQuery: vi.fn(),
  cancelQuery: vi.fn(),
  fetchQuerySnapshot: (...args: unknown[]) => fetchQuerySnapshot(...args),
  fetchQueryRows: (...args: unknown[]) => fetchQueryRows(...args),
  downloadCsvUrl: vi.fn(),
}));

import { clearRestoreAttemptsForCells } from '../../execution';
import { useAutoRestoreResult } from './useAutoRestoreResult';

/** SqlCell 内で useAutoRestoreResult を呼ぶ箇所だけを切り出した薄いプローブ。 */
function Probe({ cellId, queryId }: { cellId: string; queryId: string | undefined }) {
  useAutoRestoreResult(cellId, false, queryId);
  return null;
}

const CELL_ID = 'hook-test-cell';
const QUERY_ID = 'hook-test-query-expired';

describe('useAutoRestoreResult（視界外退出→再進入での再試行抑止）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // TTL 切れ（サーバー側の永続化結果がもう無い）を模した恒常的な失敗応答。
    fetchQuerySnapshot.mockReset().mockRejectedValue(new Error('gone (TTL swept)'));
    fetchQueryRows.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearRestoreAttemptsForCells([CELL_ID]);
  });

  test('SqlCell 相当のコンポーネントを mount → unmount → remount しても、同じ queryId は1回しか復元を試みない', async () => {
    // 1回目のマウント（このセルが初めて視界に入った状態を模す）。
    await act(async () => {
      root.render(<Probe cellId={CELL_ID} queryId={QUERY_ID} />);
    });
    // restoreCell 内部の fetchQuerySnapshot 呼び出し（非同期）が解決するのを待つ。
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchQuerySnapshot).toHaveBeenCalledTimes(1);

    // ViewportCell が視界外と判定し、SqlCell（＝この hook を使うコンポーネント）を
    // アンマウントする。
    await act(async () => root.unmount());

    // 再び視界に入り、新しい root で SqlCell が再マウントされる。
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe cellId={CELL_ID} queryId={QUERY_ID} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // 同じ cellId + queryId は再試行されない（呼び出し回数は増えない）。
    expect(fetchQuerySnapshot).toHaveBeenCalledTimes(1);

    // もう一度アンマウント→再マウントしても同様。
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe cellId={CELL_ID} queryId={QUERY_ID} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchQuerySnapshot).toHaveBeenCalledTimes(1);
  });

  test('別の queryId（再実行で新しい queryId になった場合）は再マウント後も試行される', async () => {
    await act(async () => {
      root.render(<Probe cellId={CELL_ID} queryId={QUERY_ID} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchQuerySnapshot).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    const NEW_QUERY_ID = 'hook-test-query-fresh';
    await act(async () => {
      root.render(<Probe cellId={CELL_ID} queryId={NEW_QUERY_ID} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // 新しい queryId は別記録として扱われ、試行される。
    expect(fetchQuerySnapshot).toHaveBeenCalledTimes(2);
    expect(fetchQuerySnapshot).toHaveBeenLastCalledWith(NEW_QUERY_ID);

    clearRestoreAttemptsForCells([CELL_ID]);
  });
});
