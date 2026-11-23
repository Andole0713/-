-- プランの申込み：会員が自分の申込み（スタッフの確認前）を取り消せるようにする
--   アプリでは、hacomono で手続きを済ませたと会員が答えたときに申込みを記録する。
--   間違えて押したときは、スタッフが確認する前なら本人が取り消せる。
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。
drop policy if exists "plan_applications: 管理者が削除" on public.plan_applications;
drop policy if exists "plan_applications: 管理者と本人（確認前）が削除" on public.plan_applications;
create policy "plan_applications: 管理者と本人（確認前）が削除" on public.plan_applications
  for delete to authenticated using (public.is_admin() or (member_id = auth.uid() and confirmed_at is null));
