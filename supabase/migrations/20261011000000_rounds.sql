-- ラウンドのスコア記録
--   会員がラウンドしたスコアを入力し、ベストスコア・平均スコアはそこから自動で計算する
-- 何度実行しても問題ありません。

create table if not exists public.rounds (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles (id) on delete cascade,
  played_on   date not null,
  course_name text not null check (char_length(course_name) between 1 and 100),
  holes       smallint not null default 18 check (holes in (9, 18)),
  score       smallint not null check (score between 20 and 250),
  putts       smallint check (putts between 0 and 150),
  note        text not null default '' check (char_length(note) <= 300),
  created_at  timestamptz not null default now()
);
create index if not exists rounds_member_idx on public.rounds (member_id, played_on desc);

alter table public.rounds enable row level security;

drop policy if exists "rounds: 本人と管理者は閲覧可" on public.rounds;
create policy "rounds: 本人と管理者は閲覧可" on public.rounds
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "rounds: 本人が記録" on public.rounds;
create policy "rounds: 本人が記録" on public.rounds
  for insert to authenticated with check (member_id = auth.uid());
drop policy if exists "rounds: 本人が修正" on public.rounds;
create policy "rounds: 本人が修正" on public.rounds
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());
drop policy if exists "rounds: 本人と管理者が削除" on public.rounds;
create policy "rounds: 本人と管理者が削除" on public.rounds
  for delete to authenticated using (member_id = auth.uid() or public.is_admin());

revoke all on public.rounds from anon;

-- ゴルフ場名の候補（会員みんなが入力したゴルフ場名から探す。だれが行ったかは返さない）
create or replace function public.search_courses(p_query text)
returns table (course_name text, rounds bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select r.course_name, count(*) as rounds
  from public.rounds r
  where char_length(coalesce(p_query, '')) >= 1
    and r.course_name ilike '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  group by r.course_name
  order by count(*) desc, r.course_name
  limit 10;
$$;
revoke execute on function public.search_courses(text) from anon, public;
grant execute on function public.search_courses(text) to authenticated;
