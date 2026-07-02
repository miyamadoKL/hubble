// EditorRuntime: the single source of editor-layer dependencies shared by every
// SqlEditor instance — the SchemaCache (over the API-backed MetadataSource) and
// the live catalog.schema context. Provided once near the app root so the
// language registration (which is global to the Monaco namespace) reads live
// state through stable getters.
//
// ---- ファイル概要（日本語） ----
// すべての SqlEditor インスタンスが共有する「エディター層の依存」を提供する React
// Context モジュール。具体的には API 経由の MetadataSource 上に構築した SchemaCache
// （1 つだけ生成しアプリ全体で共有）と、現在の catalog.schema コンテキストを指す。
// Monaco の言語登録はグローバル（名前空間単位）なため、アプリのルート付近で 1 度だけ
// Provider を配置し、安定した getter を通じて常に最新の状態を読めるようにしている。

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SchemaCache } from '../trino-lang';
import { createApiMetadataSource } from '../api/metadata';

export interface EditorContextValue {
  catalog?: string;
  schema?: string;
}

interface EditorRuntime {
  cache: SchemaCache;
  /** Stable getter returning the current catalog.schema context. */
  getContext: () => EditorContextValue;
}

const RuntimeContext = createContext<EditorRuntime | null>(null);

export function EditorRuntimeProvider({
  context,
  children,
}: {
  context: EditorContextValue;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  // One SchemaCache for the whole app, built over the API MetadataSource. A
  // lazy useState initializer constructs it exactly once (no ref read during
  // render — react-hooks/refs).
  const [cache] = useState(() => new SchemaCache(createApiMetadataSource(queryClient)));

  // Keep the latest context in a ref so the stable getter always reads fresh;
  // the ref is updated in an effect, never during render.
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const value = useMemo<EditorRuntime>(
    () => ({
      cache,
      getContext: () => contextRef.current,
    }),
    [cache],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useEditorRuntime(): EditorRuntime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useEditorRuntime must be used within an EditorRuntimeProvider');
  }
  return ctx;
}
