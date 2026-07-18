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
import { useDatasourceStore } from '../stores/datasourceStore';

/** エディターが現在対象としている catalog / schema コンテキスト。未選択時は省略可能。 */
export interface EditorContextValue {
  catalog?: string;
  schema?: string;
}

interface EditorRuntime {
  cache: SchemaCache;
  /** 現在の catalog.schema コンテキストを返す、安定した参照を持つ getter。 */
  getContext: () => EditorContextValue;
  /** 選択中の datasource id を返す、安定した参照を持つ getter。 */
  getDatasourceId: () => string;
  /** Trino 文法（ANTLR）を有効にするかどうかを返す、安定した参照を持つ getter。 */
  isTrinoLanguage: () => boolean;
}

const RuntimeContext = createContext<EditorRuntime | null>(null);
let activeSchemaCache: SchemaCache | null = null;

/** 現在のエディター用スキーマキャッシュをdatasource単位で無効化する。 */
export function invalidateEditorSchemaCache(datasourceId: string): void {
  activeSchemaCache?.invalidate(datasourceId);
}

/**
 * アプリのルート付近に 1 度だけ配置する Provider。SchemaCache を 1 個だけ生成して
 * アプリ全体で共有し、現在の catalog/schema コンテキストと datasource 種別を
 * 安定した getter（`useEditorRuntime` が返す関数群）経由で公開する。
 *
 * @param context - 現在の catalog / schema コンテキスト（画面遷移で変わる）。
 * @param datasourceId - 選択中の datasource id（`useDatasourceStore` の値が優先される）。
 * @param datasourceKind - Trino 文法（ANTLR）を有効にするかどうかの判定に使う種別。
 * @param children - Provider 配下でこのコンテキストを参照する子要素。
 */
export function EditorRuntimeProvider({
  context,
  datasourceId,
  datasourceKind = 'trino',
  children,
}: {
  context: EditorContextValue;
  datasourceId: string;
  datasourceKind?: 'trino' | 'mysql' | 'postgresql';
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  const kindRef = useRef(datasourceKind);
  useEffect(() => {
    kindRef.current = datasourceKind;
  }, [datasourceKind]);

  // アプリ全体で共有する SchemaCache は API 経由の MetadataSource の上に構築する。
  // useState の lazy initializer で厳密に 1 回だけ生成する
  // （render 中に ref を読むと react-hooks/refs lint に抵触するため）。
  const [cache] = useState(
    () =>
      new SchemaCache(
        createApiMetadataSource(
          queryClient,
          () => useDatasourceStore.getState().selectedId ?? datasourceId,
        ),
        () => useDatasourceStore.getState().selectedId ?? datasourceId,
      ),
  );

  useEffect(() => {
    activeSchemaCache = cache;
    return () => {
      if (activeSchemaCache === cache) activeSchemaCache = null;
    };
  }, [cache]);

  // 安定した getter が常に最新の値を読めるよう、context を ref に保持する。
  // ref の更新は effect 内でのみ行い、render 中には行わない。
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const value = useMemo<EditorRuntime>(
    () => ({
      cache,
      getContext: () => contextRef.current,
      getDatasourceId: () => useDatasourceStore.getState().selectedId ?? datasourceId,
      isTrinoLanguage: () => kindRef.current === 'trino',
    }),
    [cache],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

/**
 * 最も近い `EditorRuntimeProvider` が公開する SchemaCache と各種 getter を取得する。
 * Provider の外で呼ばれた場合は例外を投げる（配線漏れを早期に検出するため）。
 */
export function useEditorRuntime(): EditorRuntime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error('useEditorRuntime must be used within an EditorRuntimeProvider');
  }
  return ctx;
}
