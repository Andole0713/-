-- 修正：対応者の共有（20261112000000_staff_assign.sql）で付けた外部キーを外す
--   提出動画・面談・レッスンに profiles への参照が2本になり、会員名をまとめて読み込む処理が
--   「どちらの参照か分からない」となって「読み込みに失敗しました」になっていたため。
--   （レッスンのお知らせメールを送る処理も同じ理由で失敗していた）
-- 列とデータはそのまま残ります。何度実行しても問題ありません。
alter table public.submissions drop constraint if exists submissions_claimed_by_fkey;
alter table public.lessons     drop constraint if exists lessons_created_by_fkey;
alter table public.meetings    drop constraint if exists meetings_staff_id_fkey;
