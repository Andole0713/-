-- 間違えて送った動画の「取り消し依頼」
--   ・会員は、まだコーチが確認していない（確認待ちの）自分の動画について取り消しを依頼できる
--   ・管理者が削除すると、今月の提出本数が1本分戻る（本数は送った動画の数で数えているため）
-- 何度実行しても問題ありません。

alter table public.submissions add column if not exists cancel_requested_at timestamptz;
alter table public.submissions add column if not exists cancel_reason text not null default '';
alter table public.submissions drop constraint if exists submissions_cancel_reason_check;
alter table public.submissions add constraint submissions_cancel_reason_check check (char_length(cancel_reason) <= 300);

-- 会員：取り消しを依頼する（確認待ちの自分の動画だけ）
create or replace function public.request_submission_cancel(p_id uuid, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.submissions
     set cancel_requested_at = now(), cancel_reason = left(coalesce(p_reason, ''), 300)
   where id = p_id and member_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'この動画は取り消しを依頼できません（コーチが確認済みの可能性があります）';
  end if;
end;
$$;

-- 会員：依頼をやめる
create or replace function public.withdraw_submission_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.submissions set cancel_requested_at = null, cancel_reason = ''
   where id = p_id and member_id = auth.uid();
end;
$$;

revoke execute on function public.request_submission_cancel(uuid, text) from anon, public;
revoke execute on function public.withdraw_submission_cancel(uuid) from anon, public;
grant execute on function public.request_submission_cancel(uuid, text) to authenticated;
grant execute on function public.withdraw_submission_cancel(uuid) to authenticated;

create index if not exists submissions_cancel_idx on public.submissions (cancel_requested_at) where cancel_requested_at is not null;
