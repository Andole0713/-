-- アプリから hacomono での申込みへの流れ（形1）
--   ・plan_applications：会員がアプリの「このプランを申し込む」を押して、hacomono の申込み画面へ進んだ記録
--     スタッフは hacomono で契約・支払いを確かめてから、アプリでプランを有効にする（確認待ちの一覧に出る）
--   ・紹介の記録（referral_records）は、演者の専用リンクから登録した人なら、そのリンクの演者を使う（アンケートより優先）
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- =========================================================
-- 申込みの記録
-- =========================================================
create table if not exists public.plan_applications (
  member_id    uuid primary key references public.profiles (id) on delete cascade default auth.uid(),
  plan         text not null check (char_length(plan) between 1 and 40),
  applied_at   timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid
);
alter table public.plan_applications enable row level security;
drop policy if exists "plan_applications: 本人と管理者は閲覧可" on public.plan_applications;
create policy "plan_applications: 本人と管理者は閲覧可" on public.plan_applications
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "plan_applications: 本人が記録" on public.plan_applications;
create policy "plan_applications: 本人が記録" on public.plan_applications
  for insert to authenticated with check (member_id = auth.uid() or public.is_admin());
drop policy if exists "plan_applications: 本人と管理者が変更" on public.plan_applications;
create policy "plan_applications: 本人と管理者が変更" on public.plan_applications
  for update to authenticated using (member_id = auth.uid() or public.is_admin()) with check (member_id = auth.uid() or public.is_admin());
drop policy if exists "plan_applications: 管理者が削除" on public.plan_applications;
create policy "plan_applications: 管理者が削除" on public.plan_applications
  for delete to authenticated using (public.is_admin());

-- 会員は「確認済み」を付けられない。申し込み直したら、確認待ちに戻る
create or replace function public.plan_applications_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    new.confirmed_at := null;
    new.confirmed_by := null;
    new.applied_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.plan_applications_guard() from public, anon, authenticated;
drop trigger if exists plan_applications_guard on public.plan_applications;
create trigger plan_applications_guard before insert or update on public.plan_applications
  for each row execute function public.plan_applications_guard();

-- =========================================================
-- 紹介の記録：専用リンク（signup_sources の bunbu-コード）を優先、なければアンケート
-- =========================================================
create or replace function public.snapshot_referral(p_member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text; v_partner uuid; v_note text; v_name text; v_plan text; v_src text;
begin
  if p_member is null or exists (select 1 from public.referral_records where member_id = p_member) then return; end if;
  if not public.is_member_active(p_member) then return; end if;
  -- 演者の専用リンクから登録した人
  select source into v_src from public.signup_sources where member_id = p_member;
  if v_src like 'bunbu-%' then
    select id, name into v_partner, v_name from public.referral_partners where code = substr(v_src, 7);
    if v_partner is not null then v_ref := 'bunbu'; v_note := '専用リンクから登録'; end if;
  end if;
  -- それ以外はアンケートの回答
  if v_ref is null then
    select referral, referral_partner_id, referral_note into v_ref, v_partner, v_note
      from public.member_survey where member_id = p_member;
    if coalesce(v_ref, '') = '' then return; end if;
    select name into v_name from public.referral_partners where id = v_partner;
  end if;
  select plan into v_plan from public.profiles where id = p_member;
  insert into public.referral_records (member_id, referral, partner_id, partner_name, note, plan)
    values (p_member, v_ref, v_partner, v_name, coalesce(v_note, ''), v_plan)
    on conflict (member_id) do nothing;
end;
$$;
revoke execute on function public.snapshot_referral(uuid) from public, anon, authenticated;
grant execute on function public.snapshot_referral(uuid) to service_role;

create or replace function public.snapshot_referral_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name in ('member_survey', 'signup_sources') then
    perform public.snapshot_referral(new.member_id);
  else
    perform public.snapshot_referral(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.snapshot_referral_trigger() from public, anon, authenticated;

drop trigger if exists signup_sources_snapshot_referral on public.signup_sources;
create trigger signup_sources_snapshot_referral after insert on public.signup_sources
  for each row execute function public.snapshot_referral_trigger();
