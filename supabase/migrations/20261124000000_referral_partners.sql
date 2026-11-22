-- 紹介パートナー（文武遊ちゃんねるの演者など）
--   ・referral_partners：演者の一覧（名前・リンク用のコード）。スタッフの画面で追加・変更する
--   ・かんたんアンケートの「何で知りましたか？」に「文武遊ちゃんねる（YouTube）」を追加し、演者を選べるようにする
--   ・referral_records：契約中の会員がはじめて答えたときの回答を記録する（あとで会員が回答を変えても、この記録は変わらない。スタッフは直せる）
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- =========================================================
-- 演者の一覧
-- =========================================================
create table if not exists public.referral_partners (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  code       text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.referral_partners enable row level security;
-- 会員はアンケートで選ぶために、公開中の演者の名前だけ見られる
drop policy if exists "referral_partners: 公開中は閲覧可" on public.referral_partners;
create policy "referral_partners: 公開中は閲覧可" on public.referral_partners
  for select to authenticated using (active or public.is_admin());
drop policy if exists "referral_partners: 管理者が管理" on public.referral_partners;
create policy "referral_partners: 管理者が管理" on public.referral_partners
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =========================================================
-- アンケート：選択肢「文武遊ちゃんねる（YouTube）」と、選んだ演者
-- =========================================================
alter table public.member_survey drop constraint if exists member_survey_referral_check;
alter table public.member_survey add constraint member_survey_referral_check
  check (referral in ('', 'store', 'instagram', 'line', 'youtube', 'bunbu', 'search', 'friend', 'flyer', 'other'));
alter table public.member_survey add column if not exists referral_partner_id uuid references public.referral_partners (id) on delete set null;

-- =========================================================
-- 契約のときの回答の記録（スタッフだけが見られる・直せる）
-- =========================================================
create table if not exists public.referral_records (
  member_id    uuid primary key references public.profiles (id) on delete cascade,
  referral     text not null default '',
  partner_id   uuid references public.referral_partners (id) on delete set null,
  partner_name text,                        -- 記録したときの演者の名前（演者を消しても残る）
  note         text not null default '',
  plan         text,
  recorded_at  timestamptz not null default now(),
  updated_by   uuid,
  updated_at   timestamptz
);
alter table public.referral_records enable row level security;
drop policy if exists "referral_records: 管理者が管理" on public.referral_records;
create policy "referral_records: 管理者が管理" on public.referral_records
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 契約中で、まだ記録がなく、アンケートの「何で知ったか」に答えていれば記録する
create or replace function public.snapshot_referral(p_member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text; v_partner uuid; v_note text; v_name text; v_plan text;
begin
  if p_member is null or exists (select 1 from public.referral_records where member_id = p_member) then return; end if;
  if not public.is_member_active(p_member) then return; end if;
  select referral, referral_partner_id, referral_note into v_ref, v_partner, v_note
    from public.member_survey where member_id = p_member;
  if coalesce(v_ref, '') = '' then return; end if;
  select name into v_name from public.referral_partners where id = v_partner;
  select plan into v_plan from public.profiles where id = p_member;
  insert into public.referral_records (member_id, referral, partner_id, partner_name, note, plan)
    values (p_member, v_ref, v_partner, v_name, coalesce(v_note, ''), v_plan)
    on conflict (member_id) do nothing;
end;
$$;
revoke execute on function public.snapshot_referral(uuid) from public, anon, authenticated;
grant execute on function public.snapshot_referral(uuid) to service_role;

-- アンケートに答えたとき・契約が始まったときに記録する
create or replace function public.snapshot_referral_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'member_survey' then
    perform public.snapshot_referral(new.member_id);
  else
    perform public.snapshot_referral(new.id);
  end if;
  return null;
end;
$$;
revoke execute on function public.snapshot_referral_trigger() from public, anon, authenticated;

drop trigger if exists member_survey_snapshot_referral on public.member_survey;
create trigger member_survey_snapshot_referral after insert or update on public.member_survey
  for each row execute function public.snapshot_referral_trigger();

drop trigger if exists profiles_snapshot_referral on public.profiles;
create trigger profiles_snapshot_referral after update of plan, subscription_status, access_until on public.profiles
  for each row execute function public.snapshot_referral_trigger();

-- いま契約中で、すでにアンケートに答えている会員の分も記録しておく
select public.snapshot_referral(p.id) from public.profiles p
  where p.role <> 'admin' and not exists (select 1 from public.referral_records r where r.member_id = p.id);
