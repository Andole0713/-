-- 管理者の運営機能（その2）
--   ・カウンセリングシート（member_karte）：会員には見えない、初回カウンセリングの記録
--   ・レッスン文のテンプレート（lesson_templates）
--   ・お祝い済みの記録（admin_acks）：ベスト更新などを「お祝い済み」にした記録
--   ・契約の開始／終了の記録（membership_events）：月のまとめ（入会・退会・継続率）に使う
--   ・提出動画に「対応した日時」（submissions.reviewed_at）：返信までの時間の計算に使う
-- 何度実行しても問題ありません。

-- =========================================================
-- カウンセリングシート
-- =========================================================
create table if not exists public.member_karte (
  member_id    uuid primary key references public.profiles (id) on delete cascade,
  golf_history text not null default '' check (char_length(golf_history) <= 500),  -- ゴルフ歴・ラウンド頻度
  practice_env text not null default '' check (char_length(practice_env) <= 500),  -- 練習環境・練習頻度
  body_notes   text not null default '' check (char_length(body_notes) <= 500),    -- ケガ・体の状態
  goals        text not null default '' check (char_length(goals) <= 500),         -- 目標（具体的に・いつまでに）
  issues       text not null default '' check (char_length(issues) <= 500),        -- 悩み・課題
  contact_pref text not null default '' check (char_length(contact_pref) <= 300),  -- 連絡方法・連絡しやすい時間帯
  notes        text not null default '' check (char_length(notes) <= 2000),        -- その他
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id) on delete set null default auth.uid()
);

-- =========================================================
-- レッスン文のテンプレート
-- =========================================================
create table if not exists public.lesson_templates (
  id         uuid primary key default gen_random_uuid(),
  field      text not null default 'feedback' check (field in ('point', 'feedback', 'practice')),
  title      text not null check (char_length(title) between 1 and 50),
  body       text not null check (char_length(body) between 1 and 3000),
  created_at timestamptz not null default now()
);
create index if not exists lesson_templates_field_idx on public.lesson_templates (field, title);

-- =========================================================
-- お祝い済みの記録
-- =========================================================
create table if not exists public.admin_acks (
  kind       text not null check (kind in ('celebration')),
  ref_id     uuid not null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (kind, ref_id)
);

-- =========================================================
-- 契約の開始／終了の記録
-- =========================================================
create table if not exists public.membership_events (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('start', 'stop')),
  created_at timestamptz not null default now()
);
create index if not exists membership_events_time_idx on public.membership_events (created_at);

create or replace function public.log_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_active boolean := false;
  is_active  boolean;
begin
  if new.role = 'admin' then return null; end if;
  if tg_op = 'UPDATE' then
    was_active := old.subscription_status in ('active', 'trialing') or coalesce(old.access_until >= current_date, false);
  end if;
  is_active := new.subscription_status in ('active', 'trialing') or coalesce(new.access_until >= current_date, false);
  if was_active is distinct from is_active then
    insert into public.membership_events (member_id, kind) values (new.id, case when is_active then 'start' else 'stop' end);
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_log_membership on public.profiles;
create trigger profiles_log_membership after insert or update of subscription_status, access_until on public.profiles
  for each row execute function public.log_membership();

-- 今契約中の会員は、登録日を開始日として記録しておく（初回だけ）
insert into public.membership_events (member_id, kind, created_at)
select p.id, 'start', p.created_at from public.profiles p
where p.role <> 'admin'
  and (p.subscription_status in ('active', 'trialing') or p.access_until >= current_date)
  and not exists (select 1 from public.membership_events e where e.member_id = p.id);

-- =========================================================
-- 提出動画の「対応した日時」
-- =========================================================
alter table public.submissions add column if not exists reviewed_at timestamptz;

create or replace function public.stamp_reviewed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'reviewed' and old.status is distinct from 'reviewed' then
    new.reviewed_at := coalesce(new.reviewed_at, now());
  elsif new.status = 'pending' then
    new.reviewed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_stamp_reviewed on public.submissions;
create trigger submissions_stamp_reviewed before update of status on public.submissions
  for each row execute function public.stamp_reviewed();

-- これまでの対応済み動画は、レッスンを作った日時を対応日時にする
update public.submissions s set reviewed_at = (
  select min(l.created_at) from public.lessons l where l.submission_id = s.id
) where s.status = 'reviewed' and s.reviewed_at is null;

-- =========================================================
-- 閲覧・編集の権限（すべて管理者のみ。会員からは見えません）
-- =========================================================
alter table public.member_karte      enable row level security;
alter table public.lesson_templates  enable row level security;
alter table public.admin_acks        enable row level security;
alter table public.membership_events enable row level security;

drop policy if exists "member_karte: 管理者のみ" on public.member_karte;
create policy "member_karte: 管理者のみ" on public.member_karte
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "lesson_templates: 管理者のみ" on public.lesson_templates;
create policy "lesson_templates: 管理者のみ" on public.lesson_templates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin_acks: 管理者のみ" on public.admin_acks;
create policy "admin_acks: 管理者のみ" on public.admin_acks
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "membership_events: 管理者は閲覧可" on public.membership_events;
create policy "membership_events: 管理者は閲覧可" on public.membership_events
  for select to authenticated using (public.is_admin());

revoke all on public.member_karte, public.lesson_templates, public.admin_acks, public.membership_events from anon;
