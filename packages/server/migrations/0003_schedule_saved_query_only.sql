-- Schedule を「保存済みクエリ参照のみ」へ簡素化する migration。
-- 直書き SQL (statement) を Schedule から完全に廃止し、常に saved_queries を
-- 参照する形へ一本化する。あわせて datasource/catalog/schema も schedules 側での
-- 重複管理をやめ、参照先の saved query が持つ値を実行のたびに解決する運用にする
-- (server 側の対応は schedule/scheduler.ts、http/scheduleRoutes.ts を参照)。

-- 1. 既存データ変換の前に、0002 で入れた排他 CHECK 制約を先に外す。
--    これから直書き schedule に saved_query_id を設定するため、変換の一瞬だけ
--    statement / saved_query_id が両方非 NULL になる行が発生し、そのままでは
--    この制約に抵触する。
ALTER TABLE schedules DROP CONSTRAINT schedules_statement_xor_saved_query;

-- 2. 直書き SQL の schedule (statement が非 NULL) それぞれに、変換先となる
--    saved query の id をあらかじめ払い出す。id は saved_queries の実際の採番規則
--    (util/id.ts の newId('sq_') = 'sq_' + UUID v4) に合わせる。
UPDATE schedules
SET saved_query_id = 'sq_' || gen_random_uuid()::text
WHERE statement IS NOT NULL;

-- 3. 払い出した id で saved_queries へ statement/catalog/schema/datasource_id を
--    移送する。owner は schedule の owner を引き継ぎ、name は schedule 名をそのまま
--    使う（saved_queries.name に一意制約は無いため衝突は許容する。schedule 名は
--    契約上の上限が MAX_NAME_LENGTH = 200 文字で saved query の名前も同じ上限
--    なので、接尾辞を付けずそのまま引き継げば上限を超えない。以前は
--    " (schedule)" を付加していたが、200 文字ちょうどの schedule 名だと
--    saved query 側の上限を超え、移行後に編集保存できなくなる不具合があった）。
--    is_favorite は既定の 0。
INSERT INTO saved_queries
  (id, name, description, statement, catalog, schema, datasource_id, is_favorite, owner, created_at, updated_at)
SELECT
  saved_query_id,
  name,
  '',
  statement,
  catalog,
  schema,
  datasource_id,
  0,
  owner,
  created_at,
  updated_at
FROM schedules
WHERE statement IS NOT NULL;

-- 4. 変換が完了したので、schedules から直書き SQL 関連の列を落とす。
--    catalog/schema/datasource_id も saved query 側の値を都度解決する運用に
--    一本化するため、schedules 側では二重管理しない。
ALTER TABLE schedules DROP COLUMN statement;
ALTER TABLE schedules DROP COLUMN catalog;
ALTER TABLE schedules DROP COLUMN schema;
ALTER TABLE schedules DROP COLUMN datasource_id;

-- 5. 全schedule が saved_query_id を持つ状態になったので、NOT NULL を付与する。
ALTER TABLE schedules ALTER COLUMN saved_query_id SET NOT NULL;
