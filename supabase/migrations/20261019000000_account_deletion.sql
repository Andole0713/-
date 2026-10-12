-- アカウント削除と、解約・退会のお知らせ
--   ・会員がアプリから「アカウントを削除」できる（契約中の場合は、先に解約が必要）
--   ・削除の申し込みから30日間は、ログインして元に戻せる。30日を過ぎると、動画・記録をすべて削除する
--     （実際の削除は、毎日動く purge-old-videos がまとめて行う）
--   ・Web（Stripe）での解約・解約の取り消し・アカウント削除・再登録があったら、管理画面に「お知らせ」を出す
--   ・削除した会員のメールアドレスは、読めない形（ハッシュ）だけ残し、再登録のときに「以前の会員」と分かるようにする
-- 何度実行しても問題ありません。

alter table public.profiles add column if not exists deletion_requested_at timestamptz;  -- 削除の申し込み日時（30日後に削除）
alter table public.profiles add column if not exists cancel_at timestamptz;              -- Web で解約した場合の、利用が終わる日時

-- 上の2つは会員が直接変更できない（専用の手続き・Stripe からのみ）
create or replace function public.guard_profile_account()
returns trigger language plpgsql set search_path = '' as $$
begin
  if public.is_service_role() then return new; end if;
  if new.deletion_requested_at is distinct from old.deletion_requested_at
  or new.cancel_at is distinct from old.cancel_at then
    raise exception '変更できない項目が含まれています';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_profile_account on public.profiles;
create trigger guard_profile_account before update on public.profiles
  for each row execute function public.guard_profile_account();

-- =========================================================
-- 管理画面のお知らせ（解約・退会・再登録）
-- =========================================================
create table if not exists public.member_notices (
  id          bigint generated always as identity primary key,
  member_id   uuid references public.profiles (id) on delete set null,  -- 削除後も、お知らせは残す
  member_name text not null default '',
  kind        text not null check (kind in ('cancel_scheduled', 'cancel_withdrawn', 'canceled', 'delete_requested', 'delete_restored', 'deleted', 'rejoined')),
  detail      text not null default '' check (char_length(detail) <= 500),
  created_at  timestamptz not null default now(),
  acked_at    timestamptz,
  acked_by    uuid references public.profiles (id) on delete set null
);
create index if not exists member_notices_open_idx on public.member_notices (created_at) where acked_at is null;

alter table public.member_notices enable row level security;
drop policy if exists "member_notices: 管理者は閲覧可" on public.member_notices;
create policy "member_notices: 管理者は閲覧可" on public.member_notices
  for select to authenticated using (public.is_admin());
drop policy if exists "member_notices: 管理者が確認済みにする" on public.member_notices;
create policy "member_notices: 管理者が確認済みにする" on public.member_notices
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.member_notices from anon;

create or replace function public.add_member_notice(p_member uuid, p_kind text, p_detail text)
returns void language sql security definer set search_path = '' as $$
  insert into public.member_notices (member_id, member_name, kind, detail)
  select p_member, coalesce((select coalesce(nullif(name, ''), email, '') from public.profiles where id = p_member), ''), p_kind, coalesce(p_detail, '');
$$;
revoke execute on function public.add_member_notice(uuid, text, text) from public, anon, authenticated;
grant execute on function public.add_member_notice(uuid, text, text) to service_role;

-- =========================================================
-- 以前の会員（削除した会員のメールアドレスのハッシュだけを残す）
-- =========================================================
create table if not exists public.former_members (
  email_hash text primary key,
  deleted_at timestamptz not null default now()
);
alter table public.former_members enable row level security;   -- 方針なし＝会員・管理者からは見えない
revoke all on public.former_members from anon, authenticated;

create or replace function public.email_hash(p_email text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(lower(trim(coalesce(p_email, ''))), 'UTF8')), 'hex');
$$;

-- 削除の前に呼ぶ（サーバーのみ）
create or replace function public.remember_former_member(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  em text;
begin
  select email into em from public.profiles where id = p_member;
  if em is null or em = '' then return; end if;
  insert into public.former_members (email_hash, deleted_at) values (public.email_hash(em), now())
  on conflict (email_hash) do update set deleted_at = excluded.deleted_at;
  perform public.add_member_notice(p_member, 'deleted', '30日が過ぎたため、動画・記録をすべて削除しました');
end;
$$;
revoke execute on function public.remember_former_member(uuid) from public, anon, authenticated;
grant execute on function public.remember_former_member(uuid) to service_role;

-- 新しく登録した人が以前の会員なら、お知らせを出す（初回無料面談は通常どおり付与される）
create or replace function public.notice_rejoined()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  prev timestamptz;
begin
  select deleted_at into prev from public.former_members where email_hash = public.email_hash(new.email);
  if prev is not null then
    perform public.add_member_notice(new.id, 'rejoined',
      '以前の会員が再登録しました（前回の削除：' || to_char(prev at time zone 'Asia/Tokyo', 'YYYY/MM/DD') || '）。初回面談でスイングの変化を確認してください');
  end if;
  return null;
end;
$$;
drop trigger if exists profiles_notice_rejoined on public.profiles;
create trigger profiles_notice_rejoined after insert on public.profiles
  for each row execute function public.notice_rejoined();

-- =========================================================
-- アカウント削除の申し込み・取り消し（会員本人）
-- =========================================================
create or replace function public.request_account_deletion()
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  p record;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'ログインが必要です'; end if;
  if p.role = 'admin' then raise exception '管理者のアカウントは削除できません'; end if;
  if p.deletion_requested_at is not null then return p.deletion_requested_at + interval '30 days'; end if;
  -- 月額の支払いが続いている間は削除できない（先に解約）
  if p.subscription_status in ('active', 'trialing', 'past_due', 'unpaid', 'paused') and p.cancel_at is null then
    raise exception '先にお支払いの解約が必要です。「契約・お支払い」から解約してください';
  end if;
  update public.profiles set deletion_requested_at = now() where id = p.id;
  perform public.add_member_notice(p.id, 'delete_requested',
    'アカウントの削除を申し込みました（' || to_char((now() + interval '30 days') at time zone 'Asia/Tokyo', 'YYYY/MM/DD') || ' に完全に削除）');
  return now() + interval '30 days';
end;
$$;

create or replace function public.cancel_account_deletion()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and deletion_requested_at is not null) then return; end if;
  update public.profiles set deletion_requested_at = null where id = auth.uid();
  perform public.add_member_notice(auth.uid(), 'delete_restored', 'アカウントの削除を取り消し、元に戻しました');
end;
$$;

revoke execute on function public.request_account_deletion() from public, anon;
grant execute on function public.request_account_deletion() to authenticated;
revoke execute on function public.cancel_account_deletion() from public, anon;
grant execute on function public.cancel_account_deletion() to authenticated;

-- 削除の手続き中の会員は、動画を送れない
create or replace function public.can_submit_video()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_member_active(auth.uid()) then return false; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and deletion_requested_at is not null) then return false; end if;
  if not public.has_quota_plan(auth.uid()) then return true; end if;   -- ユーキャン制など
  perform public.grant_monthly_for(auth.uid(), false);
  return public.available_credits(auth.uid(), 'video') > 0;
end;
$$;
