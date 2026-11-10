-- サブスクリプション制（仮：梅・竹・松）を「オンライン面談が中心」の回数に変更（仮決定）
--   梅：面談1回＋動画1回／竹：面談1回＋動画2回／松：面談2回＋動画2回
--   極（松＋可視化カルテ・お客様には非表示）：面談2回＋動画2回
--   ・変更後の回数は、次に権利が付与されるとき（毎月1日）から反映されます。すでに付与済みの権利はそのまま
-- 何度実行しても問題ありません（極プランの SQL をまだ実行していなくても、これだけで大丈夫です）。

alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check
  check (plan in ('SUBSCRIPTION', 'YOUCAN', 'UME', 'TAKE', 'MATSU', 'KIWAMI'));

insert into public.plan_quotas (plan, video, meeting) values
  ('UME', 1, 1), ('TAKE', 2, 1), ('MATSU', 2, 2), ('KIWAMI', 2, 2)
on conflict (plan) do update set video = excluded.video, meeting = excluded.meeting;
