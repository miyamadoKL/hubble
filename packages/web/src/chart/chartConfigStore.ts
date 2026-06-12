// Per-cell chart configuration store (design.md §5: 設定はセルごとに保持).
//
// Persistence decision: the chart config is kept in this client-only zustand
// store keyed by cellId — it is NOT written into the notebook contract. The
// `cellResultMetaSchema` (contracts) has no field for it, and the brief permits a
// local store rather than widening the server contract. Config therefore lives
// for the session; a reload reseeds it from the result's columns via
// `reconcileConfig`. This keeps server/contracts untouched (P5 constraint).

import { create } from 'zustand';
import type { ChartConfig } from './chartData';

interface ChartConfigState {
  byCell: Record<string, ChartConfig>;
  set: (cellId: string, config: ChartConfig) => void;
  clear: (cellId: string) => void;
}

export const useChartConfigStore = create<ChartConfigState>((set) => ({
  byCell: {},
  set: (cellId, config) => set((s) => ({ byCell: { ...s.byCell, [cellId]: config } })),
  clear: (cellId) =>
    set((s) => {
      if (!(cellId in s.byCell)) return s;
      const next = { ...s.byCell };
      delete next[cellId];
      return { byCell: next };
    }),
}));

/** The stored chart config for a cell, or undefined if none yet. */
export function useChartConfig(cellId: string): ChartConfig | undefined {
  return useChartConfigStore((s) => s.byCell[cellId]);
}
