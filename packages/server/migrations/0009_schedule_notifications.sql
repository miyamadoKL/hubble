-- スケジュール失敗時の外部通知設定。
-- JSON 文字列として保存し、アプリ層の contracts スキーマで検証する。
-- 既存行は NULL のままにして、既定値 onFailure=false と channels=[] にフォールバックする。

ALTER TABLE schedules ADD COLUMN notifications TEXT;
