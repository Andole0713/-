-- 統計（スタッフの「統計」ページ）に使う記録
--   ・member_survey：はじめのアンケート（どこで知ったか・年代・ゴルフ歴・スコア・地域・店舗の利用）
--   ・lesson_ratings：レッスンごとの評価（役に立った／まあまあ／わかりにくい）
--   ・nps_responses：月1回の「友だちにすすめたい度」（0〜10点）
--   ・exit_reasons：退会の理由（会員が答える／スタッフが聞き取って記録）。アカウント削除後も理由だけ残す
--   ・profiles.last_seen_at：最後にアプリを開いた日時（辞めそうな人を早めに見つけるため）
-- 何度実行しても問題ありません。

-- =========================================================
-- はじめのアンケート（1人1行。あとから変更できる）
-- =========================================================
create table if not exists public.member_survey (
  member_id     uuid primary key references public.profiles (id) on delete cascade default auth.uid(),
  referral      text not null default '' check (referral in ('', 'store', 'instagram', 'line', 'youtube', 'search', 'friend', 'flyer', 'other')),
  referral_note text not null default '' check (char_length(referral_note) <= 100),
  age_band      text not null default '' check (age_band in ('', '10s', '20s', '30s', '40s', '50s', '60s', '70s')),
  golf_years    text not null default '' check (golf_years in ('', 'none', 'lt1', '1-3', '3-10', '10+')),
  score_band    text not null default '' check (score_band in ('', 'none', '120+', '110', '100', '90', '80', 'lt80')),
  prefecture    text not null default '' check (char_length(prefecture) <= 10),
  store_use     text not null default '' check (store_use in ('', 'now', 'past', 'never')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.member_survey enable row level security;
drop policy if exists "member_survey: 本人と管理者は閲覧可" on public.member_survey;
create policy "member_survey: 本人と管理者は閲覧可" on public.member_survey
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "member_survey: 本人が記録" on public.member_survey;
create policy "member_survey: 本人が記録" on public.member_survey
  for insert to authenticated with check (member_id = auth.uid());
drop policy if exists "member_survey: 本人が変更" on public.member_survey;
create policy "member_survey: 本人が変更" on public.member_survey
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());

-- =========================================================
-- レッスンの評価（1レッスン1つ。会員本人だけが付けられる）
-- =========================================================
create table if not exists public.lesson_ratings (
  lesson_id  uuid primary key references public.lessons (id) on delete cascade,
  member_id  uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  rating     smallint not null check (rating between 1 and 3),   -- 3＝役に立った／2＝まあまあ／1＝わかりにくい
  comment    text not null default '' check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lesson_ratings_time_idx on public.lesson_ratings (created_at);
alter table public.lesson_ratings enable row level security;
drop policy if exists "lesson_ratings: 本人と管理者は閲覧可" on public.lesson_ratings;
create policy "lesson_ratings: 本人と管理者は閲覧可" on public.lesson_ratings
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "lesson_ratings: 本人が記録" on public.lesson_ratings;
create policy "lesson_ratings: 本人が記録" on public.lesson_ratings
  for insert to authenticated with check (
    member_id = auth.uid()
    and exists (select 1 from public.lessons l where l.id = lesson_id and l.member_id = auth.uid())
  );
drop policy if exists "lesson_ratings: 本人が変更" on public.lesson_ratings;
create policy "lesson_ratings: 本人が変更" on public.lesson_ratings
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());

-- =========================================================
-- 友だちにすすめたい度（月に1回）
-- =========================================================
create table if not exists public.nps_responses (
  member_id  uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  month      date not null,   -- その月の1日
  score      smallint not null check (score between 0 and 10),
  comment    text not null default '' check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  primary key (member_id, month)
);
alter table public.nps_responses enable row level security;
drop policy if exists "nps_responses: 本人と管理者は閲覧可" on public.nps_responses;
create policy "nps_responses: 本人と管理者は閲覧可" on public.nps_responses
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "nps_responses: 本人が今月分を記録" on public.nps_responses;
create policy "nps_responses: 本人が今月分を記録" on public.nps_responses
  for insert to authenticated with check (
    member_id = auth.uid() and month = date_trunc('month', (now() at time zone 'Asia/Tokyo'))::date
  );

-- =========================================================
-- 退会の理由（アカウントを削除しても、理由だけは統計用に残す）
-- =========================================================
create table if not exists public.exit_reasons (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid references public.profiles (id) on delete set null default auth.uid(),
  reasons    text[] not null default '{}' check (reasons <@ array['price', 'time', 'effect', 'online', 'coach', 'app', 'store', 'injury', 'quit_golf', 'other']::text[]),
  comment    text not null default '' check (char_length(comment) <= 1000),
  source     text not null default 'member' check (source in ('member', 'staff')),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists exit_reasons_time_idx on public.exit_reasons (created_at);
alter table public.exit_reasons enable row level security;
drop policy if exists "exit_reasons: 本人と管理者は閲覧可" on public.exit_reasons;
create policy "exit_reasons: 本人と管理者は閲覧可" on public.exit_reasons
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "exit_reasons: 本人か管理者が記録" on public.exit_reasons;
create policy "exit_reasons: 本人か管理者が記録" on public.exit_reasons
  for insert to authenticated with check (
    public.is_admin() or (member_id = auth.uid() and source = 'member')
  );
drop policy if exists "exit_reasons: 管理者が削除" on public.exit_reasons;
create policy "exit_reasons: 管理者が削除" on public.exit_reasons
  for delete to authenticated using (public.is_admin());

revoke all on public.member_survey, public.lesson_ratings, public.nps_responses, public.exit_reasons from anon;

-- =========================================================
-- 最後にアプリを開いた日時（1日1回だけ更新）
-- =========================================================
alter table public.profiles add column if not exists last_seen_at timestamptz;

create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = '' as $$
  update public.profiles set last_seen_at = now()
   where id = auth.uid()
     and (last_seen_at is null or last_seen_at < now() - interval '6 hours');
$$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;
