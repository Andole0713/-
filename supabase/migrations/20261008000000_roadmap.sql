-- ドリルの定期公開（ロードマップ）
--   ・入会時の初回カウンセリングで、会員ごとに12か月分（月数は自由）の計画を作る
--   ・各月の「公開日」になると、その月のドリルが会員ページに自動で公開される（日本時間）
--   ・管理者はいつでも、テーマ・ドリル・公開日の変更、順番の入れ替え、追加・削除、前倒し公開ができる
-- 先に 20261007000000_drills.sql を実行してください。何度実行しても問題ありません。

create table if not exists public.roadmap_items (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.profiles (id) on delete cascade,
  publish_on   date not null,                                                   -- 公開日
  theme        text not null default '' check (char_length(theme) <= 100),      -- その月のテーマ・目標
  drill_id     uuid references public.drills (id) on delete set null,           -- その月のドリル（ドリル集から選ぶ）
  note         text not null default '' check (char_length(note) <= 1000),      -- 会員へのひとこと
  published_at timestamptz,                                                     -- 公開日より前に手動で公開した日時
  created_at   timestamptz not null default now()
);
create index if not exists roadmap_items_member_idx on public.roadmap_items (member_id, publish_on);

-- 会員に公開済みかどうか（公開日が来た、または手動で公開した）
create or replace function public.roadmap_is_open(p_publish_on date, p_published_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_published_at is not null or p_publish_on <= (now() at time zone 'Asia/Tokyo')::date;
$$;

-- ドリルを見られる条件に「ロードマップで公開済み」を追加
create or replace function public.can_view_drill(p_drill uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_active_subscription() and (
    exists (
      select 1 from public.lesson_drills ld
      join public.lessons l on l.id = ld.lesson_id
      where ld.drill_id = p_drill and l.member_id = auth.uid()
    )
    or exists (
      select 1 from public.roadmap_items r
      where r.drill_id = p_drill and r.member_id = auth.uid()
        and public.roadmap_is_open(r.publish_on, r.published_at)
    )
  );
$$;

alter table public.roadmap_items enable row level security;

-- 会員は自分のロードマップ（まだ公開前の月のテーマも含む）を見られる。ドリルの中身は公開日まで見られない
drop policy if exists "roadmap: 本人と管理者は閲覧可" on public.roadmap_items;
create policy "roadmap: 本人と管理者は閲覧可" on public.roadmap_items
  for select to authenticated
  using (member_id = auth.uid() or public.is_admin());

drop policy if exists "roadmap: 管理者は追加・更新・削除可" on public.roadmap_items;
create policy "roadmap: 管理者は追加・更新・削除可" on public.roadmap_items
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.roadmap_items from anon;
