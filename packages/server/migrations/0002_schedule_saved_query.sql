-- Schedule が saved query を参照できるようにするための拡張。
-- 直書き SQL (statement) との排他は契約層 (packages/contracts/src/schedule.ts) の
-- refine で第一防御として強制するが、それだけでは経路によって（バッチ更新、
-- 契約層を経由しない直接の DB 操作など）すり抜けうるため、DB 側にも
-- 同じ排他制約を CHECK 制約として二重に持たせる。
ALTER TABLE schedules ADD COLUMN saved_query_id TEXT;
-- 既存の直書き schedule は後方互換で動き続ける必要があるため、statement は
-- nullable化する（saved_query_id 参照の schedule は statement が NULL になる）。
ALTER TABLE schedules ALTER COLUMN statement DROP NOT NULL;

CREATE INDEX idx_schedules_saved_query ON schedules (saved_query_id);

-- statement と saved_query_id は必ずどちらか一方だけが NULL でない排他関係にする。
-- 既存行は全て statement が非 NULL で、saved_query_id が NULL（このカラム追加直後は
-- 常に NULL）なので、この制約を後付けしても既存データを壊さない。
ALTER TABLE schedules ADD CONSTRAINT schedules_statement_xor_saved_query
  CHECK ((statement IS NULL) <> (saved_query_id IS NULL));
