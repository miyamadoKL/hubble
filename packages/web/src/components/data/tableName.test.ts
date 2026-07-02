// テスト対象: ./tableName.ts の quoteIdentifier / relativeTableName / selectTemplate。
// 識別子のクォート規則、コンテキストに応じたテーブル名の相対表記、SELECT 雛形生成の
// 各パターンを網羅的に検証する。

import { describe, expect, test } from 'vitest';
import { quoteIdentifier, relativeTableName, selectTemplate } from './tableName';

describe('quoteIdentifier', () => {
  test('leaves plain lowercase identifiers unquoted', () => {
    // 素の識別子（小文字英数字とアンダースコアのみ）はクォートせずそのまま。
    expect(quoteIdentifier('orders')).toBe('orders');
    expect(quoteIdentifier('order_items')).toBe('order_items');
    expect(quoteIdentifier('_x1')).toBe('_x1');
  });

  test('quotes mixed-case, spaced, or leading-digit names', () => {
    // 大文字混在、スペース入り、数字始まりはいずれもダブルクォートが必要になる。
    expect(quoteIdentifier('Orders')).toBe('"Orders"');
    expect(quoteIdentifier('my table')).toBe('"my table"');
    expect(quoteIdentifier('1st')).toBe('"1st"');
  });

  test('escapes embedded double quotes by doubling', () => {
    // 識別子内の " は "" に二重化してエスケープする。
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

describe('relativeTableName', () => {
  const ref = { catalog: 'tpch', schema: 'sf1', name: 'orders' };

  test('bare name when catalog + schema both match context', () => {
    // catalog と schema ともにコンテキストと一致 → テーブル名のみ。
    expect(relativeTableName(ref, { catalog: 'tpch', schema: 'sf1' })).toBe('orders');
  });

  test('schema.table when only the catalog matches', () => {
    // catalog は一致するが schema が異なる → schema.table 表記。
    expect(relativeTableName(ref, { catalog: 'tpch', schema: 'sf10' })).toBe('sf1.orders');
  });

  test('fully-qualified when the catalog differs', () => {
    // catalog 自体が異なる → catalog.schema.table の完全修飾名。
    expect(relativeTableName(ref, { catalog: 'tpcds', schema: 'sf1' })).toBe('tpch.sf1.orders');
  });

  test('fully-qualified when the context is empty', () => {
    // コンテキスト未設定（catalog/schema なし）でも完全修飾名にフォールバックする。
    expect(relativeTableName(ref, {})).toBe('tpch.sf1.orders');
  });

  test('quotes each qualified part as needed', () => {
    // 完全修飾名になる場合、catalog/schema/table の各パーツが個別にクォート判定される。
    const odd = { catalog: 'My Cat', schema: 'S 1', name: 'Tbl' };
    expect(relativeTableName(odd, {})).toBe('"My Cat"."S 1"."Tbl"');
    expect(relativeTableName(odd, { catalog: 'My Cat', schema: 'other' })).toBe('"S 1"."Tbl"');
  });
});

describe('selectTemplate', () => {
  const ref = { catalog: 'tpch', schema: 'sf1', name: 'orders' };

  test('lists known columns and qualifies relative to context', () => {
    // カラムが既知の場合は列挙し、FROM 句はコンテキストに応じた相対名になる。
    const sql = selectTemplate(ref, ['orderkey', 'totalprice'], { catalog: 'tpch', schema: 'sf1' });
    expect(sql).toBe('SELECT orderkey, totalprice\nFROM orders\nLIMIT 100');
  });

  test('falls back to * when no columns are known', () => {
    // カラム未取得時は * にフォールバックする。
    const sql = selectTemplate(ref, [], { catalog: 'tpcds', schema: 'sf1' });
    expect(sql).toBe('SELECT *\nFROM tpch.sf1.orders\nLIMIT 100');
  });

  test('honors a custom limit and quotes odd columns', () => {
    // limit 引数を指定でき、クォートが必要なカラム名も正しく処理される。
    const sql = selectTemplate(ref, ['Order Key'], { catalog: 'tpch', schema: 'sf1' }, 25);
    expect(sql).toBe('SELECT "Order Key"\nFROM orders\nLIMIT 25');
  });
});
