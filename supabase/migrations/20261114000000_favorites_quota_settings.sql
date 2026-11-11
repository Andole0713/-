-- 1) 送った動画の「お気に入り」（会員ごとに3つまで。お気に入りの動画は3か月たっても自動で削除しない）
--    ・お気に入りを外すと、ふつうの動画と同じ扱いに戻る（送ってから3か月を過ぎていれば、次の自動削除で消える）
--    ・自動削除（Edge Function purge-old-videos）は、お気に入りを除くように更新済み（再デプロイが必要）
-- 2) プランごとの毎月の回数（plan_quotas）は、管理者がアプリの「設定」から変更できる（表と権限は 20261018000000_credits.sql で作成済み）
-- 何度実行しても問題ありません。

alter table public.submissions add column if not exists favorite_at timestamptz;
create index if not exists submissions_favorite_idx on public.submissions (member_id) where favorite_at is not null;

-- お気に入りを付ける・外す（本人だけ。3つまで。動画が削除済みなら付けられない）
create or replace function public.set_submission_favorite(p_sub uuid, p_on boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare s public.submissions; n integer;
begin
  select * into s from public.submissions where id = p_sub;
  if s.id is null or s.member_id <> auth.uid() then raise exception '動画が見つかりません'; end if;
  if p_on then
    if s.video_deleted_at is not null then raise exception 'この動画はすでに削除されているため、お気に入りにできません'; end if;
    select count(*) into n from public.submissions where member_id = s.member_id and favorite_at is not null and id <> s.id;
    if n >= 3 then raise exception 'お気に入りは3つまでです。どれかを外してから付けてください'; end if;
    update public.submissions set favorite_at = coalesce(favorite_at, now()) where id = s.id;
  else
    update public.submissions set favorite_at = null where id = s.id;
  end if;
  select count(*) into n from public.submissions where member_id = s.member_id and favorite_at is not null;
  return n;
end $$;
revoke all on function public.set_submission_favorite(uuid, boolean) from public;
grant execute on function public.set_submission_favorite(uuid, boolean) to authenticated;
