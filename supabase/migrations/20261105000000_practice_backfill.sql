-- 練習した日：付け忘れた日をあとから記録できるようにする（60日前まで。これまでは今日と昨日だけ）
-- 何度実行しても問題ありません。
drop policy if exists "roadmap_practice: 本人が記録" on public.roadmap_practice;
create policy "roadmap_practice: 本人が記録" on public.roadmap_practice
  for insert to authenticated
  with check (
    member_id = auth.uid() and public.can_log_roadmap(item_id)
    and practiced_on <= (now() at time zone 'Asia/Tokyo')::date
    and practiced_on >= (now() at time zone 'Asia/Tokyo')::date - 60
  );
