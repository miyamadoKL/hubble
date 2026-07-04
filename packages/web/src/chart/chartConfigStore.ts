// ============================================================================
// 【ファイル概要】
// このファイルは、チャートの表示設定（種別、軸の選択、ソート順、表示件数など）を
// セル（ノートブックの各クエリ結果ブロック）ごとに保持するための Zustand ストアを
// 定義する。設定はクライアント側のメモリ上にのみ保持され、サーバー側の contract
// （ノートブックのスキーマ）には保存されない。詳細は下の英語コメントを参照。
// ============================================================================
// Per-cell chart configuration store (設定はセルごとに保持).
//
// Persistence decision: the chart config is kept in this client-only zustand
// store keyed by cellId — it is NOT written into the notebook contract. The
// `cellResultMetaSchema` (contracts) has no field for it, and the brief permits a
// local store rather than widening the server contract. Config therefore lives
// for the session; a reload reseeds it from the result's columns via
// `reconcileConfig`. This keeps server/contracts untouched (P5 constraint).

import { create } from 'zustand';
import type { ChartConfig } from './chartData';

// ストアの内部状態の型。byCell が実データ、set/clear が更新用アクション。
interface ChartConfigState {
  /** cellId をキーとした ChartConfig のマップ（セルごとのチャート設定）。 */
  byCell: Record<string, ChartConfig>;
  /** 指定した cellId のチャート設定を新しい値で上書き（または新規登録）する。 */
  set: (cellId: string, config: ChartConfig) => void;
  /** 指定した cellId のチャート設定を削除する（未設定状態に戻す）。 */
  clear: (cellId: string) => void;
}

/**
 * セルごとのチャート設定を保持する Zustand ストア。
 * コンポーネントからは `useChartConfig` フックまたは
 * `useChartConfigStore((s) => s.set)` のように必要な部分だけを購読して使う。
 */
export const useChartConfigStore = create<ChartConfigState>((set) => ({
  byCell: {},
  // 既存の byCell をスプレッドでコピーしつつ、対象 cellId のみを新しい config で
  // 置き換えた新しいオブジェクトを返す（他セルの設定はそのまま維持される）。
  set: (cellId, config) => set((s) => ({ byCell: { ...s.byCell, [cellId]: config } })),
  clear: (cellId) =>
    set((s) => {
      // 該当セルの設定がそもそも存在しない場合は状態を変更せずそのまま返す
      // （無駄な再レンダリングを避けるため）。
      if (!(cellId in s.byCell)) return s;
      // 該当 cellId のエントリだけを取り除いた新しいオブジェクトを作って返す。
      const next = { ...s.byCell };
      delete next[cellId];
      return { byCell: next };
    }),
}));

/**
 * The stored chart config for a cell, or undefined if none yet.
 * 指定した cellId に対応するチャート設定を購読するフック。
 * まだ設定が作られていないセルに対しては undefined を返す
 * （呼び出し側で `reconcileConfig`/`defaultConfig` によるデフォルト生成を行う）。
 */
export function useChartConfig(cellId: string): ChartConfig | undefined {
  return useChartConfigStore((s) => s.byCell[cellId]);
}
