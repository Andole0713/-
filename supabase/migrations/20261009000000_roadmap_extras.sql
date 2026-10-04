-- ロードマップの追加機能
--   ・ドリルの「練習した」記録（日ごと）
--   ・月ごとのふり返り（会員が書く）
--   ・ロードマップのゴール（管理者が設定）
--   ・公開されたドリルの未読（NEW）表示
-- 先に 20261008000000_roadmap.sql を実行してください。何度実行しても問題ありません。

-- 未読（会員がドリルのページで見た日時）
alter table public.roadmap_items add column if not exists seen_at timestamptz;

-- 会員がドリルのページを開いたら、公開済みの月をすべて既読にする
create or replace function public.mark_roadmap_seen()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.roadmap_items set seen_at = now()
  where member_id = auth.uid() and seen_at is null
    and public.roadmap_is_open(publish_on, published_at);
$$;
revoke execute on function public.mark_roadmap_seen() from anon, public;
grant execute on function public.mark_roadmap_seen() to authenticated;

-- 会員が記録できるのは「自分の・公開済みの月」で「契約中」のときだけ
create or replace function public.can_log_roadmap(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_active_subscription() and exists (
    select 1 from public.roadmap_items r
    where r.id = p_item and r.member_id = auth.uid()
      and public.roadmap_is_open(r.publish_on, r.published_at)
  );
$$;
revoke execute on function public.can_log_roadmap(uuid) from anon, public;
grant execute on function public.can_log_roadmap(uuid) to authenticated;

-- 練習した日
create table if not exists public.roadmap_practice (
  item_id      uuid not null references public.roadmap_items (id) on delete cascade,
  member_id    uuid not null references public.profiles (id) on delete cascade,
  practiced_on date not null,
  created_at   timestamptz not null default now(),
  primary key (item_id, practiced_on)
);
create index if not exists roadmap_practice_member_idx on public.roadmap_practice (member_id);

-- 月ごとのふり返り
create table if not exists public.roadmap_reflections (
  item_id    uuid primary key references public.roadmap_items (id) on delete cascade,
  member_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null default '' check (char_length(body) <= 1000),
  updated_at timestamptz not null default now()
);

-- ロードマップのゴール（会員ごとに1つ）
create table if not exists public.roadmap_goals (
  member_id  uuid primary key references public.profiles (id) on delete cascade,
  goal       text not null default '' check (char_length(goal) <= 100),
  updated_at timestamptz not null default now()
);

alter table public.roadmap_practice    enable row level security;
alter table public.roadmap_reflections enable row level security;
alter table public.roadmap_goals       enable row level security;

drop policy if exists "roadmap_practice: 本人と管理者は閲覧可" on public.roadmap_practice;
create policy "roadmap_practice: 本人と管理者は閲覧可" on public.roadmap_practice
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "roadmap_practice: 本人が記録" on public.roadmap_practice;
create policy "roadmap_practice: 本人が記録" on public.roadmap_practice
  for insert to authenticated
  with check (
    member_id = auth.uid() and public.can_log_roadmap(item_id)
    and practiced_on <= (now() at time zone 'Asia/Tokyo')::date
    and practiced_on >= (now() at time zone 'Asia/Tokyo')::date - 1
  );
drop policy if exists "roadmap_practice: 本人が取り消し" on public.roadmap_practice;
create policy "roadmap_practice: 本人が取り消し" on public.roadmap_practice
  for delete to authenticated using (member_id = auth.uid());

drop policy if exists "roadmap_reflections: 本人と管理者は閲覧可" on public.roadmap_reflections;
create policy "roadmap_reflections: 本人と管理者は閲覧可" on public.roadmap_reflections
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "roadmap_reflections: 本人が書く" on public.roadmap_reflections;
create policy "roadmap_reflections: 本人が書く" on public.roadmap_reflections
  for insert to authenticated with check (member_id = auth.uid() and public.can_log_roadmap(item_id));
drop policy if exists "roadmap_reflections: 本人が書き直す" on public.roadmap_reflections;
create policy "roadmap_reflections: 本人が書き直す" on public.roadmap_reflections
  for update to authenticated
  using (member_id = auth.uid())
  with check (member_id = auth.uid() and public.can_log_roadmap(item_id));

drop policy if exists "roadmap_goals: 本人と管理者は閲覧可" on public.roadmap_goals;
create policy "roadmap_goals: 本人と管理者は閲覧可" on public.roadmap_goals
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "roadmap_goals: 管理者が設定" on public.roadmap_goals;
create policy "roadmap_goals: 管理者が設定" on public.roadmap_goals
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.roadmap_practice, public.roadmap_reflections, public.roadmap_goals from anon;
