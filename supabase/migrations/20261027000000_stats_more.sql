-- 統計を増やすための記録（その2）
--   ・lessons.diag_tags：レッスンの診断の分類（スライス・ダフリなど）
--   ・submissions：撮影方法（SwingFrame／カメラロール）、撮り直した回数、編集したか、アップロードにかかった時間・容量
--   ・signup_sources：どこから来て登録したか（ホームページのリンクの ?from= を自動で記録）
--   ・site_events：ホームページの表示回数と「LINEで相談」「電話する」などのボタンが押された回数（ログイン不要で記録）
--   ・ad_spend：広告にかけた金額（スタッフが月ごとに入力）
--   ・app_events：アプリの画面が開かれた回数、用語集で見つからなかった言葉、アップロードの失敗、アプリのエラー
-- 何度実行しても問題ありません。

-- =========================================================
-- レッスンの診断の分類
-- =========================================================
alter table public.lessons add column if not exists diag_tags text[] not null default '{}';
alter table public.lessons drop constraint if exists lessons_diag_tags_check;
alter table public.lessons add constraint lessons_diag_tags_check check (cardinality(diag_tags) <= 10);

-- =========================================================
-- 提出動画の撮り方・送り方
-- =========================================================
alter table public.submissions add column if not exists capture_source text not null default '' check (capture_source in ('', 'swingframe', 'library'));
alter table public.submissions add column if not exists takes smallint check (takes between 0 and 999);
alter table public.submissions add column if not exists edited boolean;
alter table public.submissions add column if not exists upload_ms integer check (upload_ms >= 0);
alter table public.submissions add column if not exists file_mb numeric(7, 1) check (file_mb >= 0);

-- =========================================================
-- どこから来て登録したか（1人1行。最初の1回だけ）
-- =========================================================
create table if not exists public.signup_sources (
  member_id  uuid primary key references public.profiles (id) on delete cascade default auth.uid(),
  source     text not null default '' check (char_length(source) <= 40),
  first_seen timestamptz,
  created_at timestamptz not null default now()
);
alter table public.signup_sources enable row level security;
drop policy if exists "signup_sources: 本人と管理者は閲覧可" on public.signup_sources;
create policy "signup_sources: 本人と管理者は閲覧可" on public.signup_sources
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "signup_sources: 本人が記録" on public.signup_sources;
create policy "signup_sources: 本人が記録" on public.signup_sources
  for insert to authenticated with check (member_id = auth.uid());

-- =========================================================
-- ホームページの表示・ボタン（だれでも記録できる。個人を特定する情報は持たない）
-- =========================================================
create table if not exists public.site_events (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('view', 'line', 'tel', 'login', 'plan', 'shoot')),
  source     text not null default '' check (char_length(source) <= 40),
  created_at timestamptz not null default now()
);
create index if not exists site_events_time_idx on public.site_events (created_at);
alter table public.site_events enable row level security;
drop policy if exists "site_events: だれでも記録" on public.site_events;
create policy "site_events: だれでも記録" on public.site_events
  for insert to anon, authenticated with check (true);
drop policy if exists "site_events: 管理者が閲覧" on public.site_events;
create policy "site_events: 管理者が閲覧" on public.site_events
  for select to authenticated using (public.is_admin());
grant insert on public.site_events to anon;

-- =========================================================
-- 広告費（スタッフが入力）
-- =========================================================
create table if not exists public.ad_spend (
  month      date not null,
  channel    text not null check (char_length(channel) between 1 and 40),
  amount     integer not null check (amount >= 0),
  updated_at timestamptz not null default now(),
  primary key (month, channel)
);
alter table public.ad_spend enable row level security;
drop policy if exists "ad_spend: 管理者のみ" on public.ad_spend;
create policy "ad_spend: 管理者のみ" on public.ad_spend
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =========================================================
-- アプリの利用の記録
-- =========================================================
create table if not exists public.app_events (
  id         bigint generated always as identity primary key,
  member_id  uuid references public.profiles (id) on delete cascade default auth.uid(),
  kind       text not null check (kind in ('view', 'glossary_miss', 'upload_fail', 'error')),
  name       text not null default '' check (char_length(name) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists app_events_time_idx on public.app_events (kind, created_at);
alter table public.app_events enable row level security;
drop policy if exists "app_events: 本人が記録" on public.app_events;
create policy "app_events: 本人が記録" on public.app_events
  for insert to authenticated with check (member_id = auth.uid());
drop policy if exists "app_events: 管理者が閲覧" on public.app_events;
create policy "app_events: 管理者が閲覧" on public.app_events
  for select to authenticated using (public.is_admin());

revoke all on public.signup_sources, public.ad_spend, public.app_events from anon;
revoke select, update, delete on public.site_events from anon;
