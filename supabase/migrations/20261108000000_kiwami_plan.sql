-- 極プラン（仮）：松プランの内容＋可視化カルテ
--   ・導入するかはまだ未定。お客様のプラン選択には表示しない（app/config.js で hidden）
--   ・スタッフが会員のプランとして設定できるように、プランの種類と毎月の回数だけ用意しておく
--   ・毎月の回数は松と同じ（動画2回・面談1回）
-- 何度実行しても問題ありません。

alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check
  check (plan in ('SUBSCRIPTION', 'YOUCAN', 'UME', 'TAKE', 'MATSU', 'KIWAMI'));

insert into public.plan_quotas (plan, video, meeting) values ('KIWAMI', 2, 1)
on conflict (plan) do nothing;
