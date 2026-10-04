-- Myクラブセッティング：会員が自分の使っているクラブを登録し、動画提出のときに選べるようにする
-- すでに初期設定（20260926000000_init.sql）を実行したデータベースでは、このファイルを SQL Editor で実行してください。
-- 何度実行しても問題ありません。

alter table public.profiles add column if not exists clubs text[] not null default '{}';

alter table public.profiles drop constraint if exists profiles_clubs_check;
alter table public.profiles add constraint profiles_clubs_check
  check (cardinality(clubs) <= 30 and char_length(array_to_string(clubs, '')) <= 600);

-- 会員本人がプロフィールを更新するときの制限（guard_profile_update）は、
-- 変更できない項目を個別に列挙しているため、clubs は本人が自由に変更できます。
