import { z } from 'zod';

/**
 * 契約層 (packages/contracts) 全体で使い回す、最小単位の共通 zod プリミティブを定義するファイル。
 * 各スキーマファイル（query.ts, notebook.ts など）はここから isoTimestamp / id を import して使う。
 */

/**
 * タイムゾーンオフセット付き ISO 8601 形式の日時文字列を表す zod スキーマ。
 * createdAt / updatedAt / submittedAt など「〜At」というフィールド名の値はすべてこれを使う。
 */
export const isoTimestamp = z.iso.datetime({ offset: true });

/**
 * 空文字を許容しない ID 文字列用の zod スキーマ。各エンティティの id フィールドの基礎として使う。
 */
export const id = z.string().min(1);
