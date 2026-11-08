-- 会員が、送った不具合・ご要望を取り消せるようにする（スタッフが対応する前＝未対応のものだけ）
-- 何度実行しても問題ありません。
drop policy if exists "feedback: 本人が取り消し" on public.feedback;
create policy "feedback: 本人が取り消し" on public.feedback
  for delete to authenticated using (member_id = auth.uid() and status = 'open');
