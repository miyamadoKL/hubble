/** dashboard 内の query widget が共有する実行 coordinator と React hook。 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { WidgetData } from './useWidgetData';
import { DashboardQueryCoordinator, type SharedWidgetQueryState } from './widgetQueryCoordinator';

const DashboardQueryContext = createContext<DashboardQueryCoordinator | null>(null);

/** DashboardEditor の寿命に coordinator を一つだけ割り当てる。 */
export function DashboardWidgetDataProvider({
  children,
  coordinator: providedCoordinator,
}: {
  children: ReactNode;
  coordinator?: DashboardQueryCoordinator;
}) {
  const [ownedCoordinator] = useState(() => new DashboardQueryCoordinator());
  const coordinator = providedCoordinator ?? ownedCoordinator;
  useEffect(() => {
    coordinator.activate();
    return () => coordinator.scheduleDispose();
  }, [coordinator]);
  return (
    <DashboardQueryContext.Provider value={coordinator}>{children}</DashboardQueryContext.Provider>
  );
}

const initialState: SharedWidgetQueryState = {
  loading: true,
  error: null,
  columns: [],
  rows: [],
  queryName: null,
};

/** 可視になった widget だけを savedQueryId ごとの共有実行へ接続する。 */
export function useDashboardWidgetData(savedQueryId: string, enabled: boolean): WidgetData {
  const coordinator = useContext(DashboardQueryContext);
  if (!coordinator) throw new Error('DashboardWidgetDataProvider is missing');
  const [state, setState] = useState<SharedWidgetQueryState>(initialState);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    // effect 内の同期 setState を避けつつ、同じ microtask 内の widget を coordinator へ集約する。
    queueMicrotask(() => {
      if (!active) return;
      unsubscribe = coordinator.subscribe(savedQueryId, (next) => {
        if (active) setState(next);
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [coordinator, enabled, savedQueryId]);

  const refresh = useCallback(() => {
    coordinator.refresh(savedQueryId);
  }, [coordinator, savedQueryId]);

  return { ...state, refresh };
}
