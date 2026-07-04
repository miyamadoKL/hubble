-- スケジュール実行時の principal スナップショット。
-- 新規スケジュールは作成/更新時点の認証済み principal を保存し、owner が
-- email localpart でも email、email domain、group による RBAC 割り当てを
-- 実行時に復元できるようにする。
-- 既存行は NULL のままにして、従来の owner 文字列フォールバックを使う。

ALTER TABLE schedules ADD COLUMN principal_snapshot TEXT;
