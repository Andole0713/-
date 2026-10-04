-- ロードマップ：公開したドリルの取り消し
--   hidden = true の月は、公開日を過ぎていても会員には公開されない（ドリル・動画も見えない）
-- 先に 20261009000000_roadmap_extras.sql を実行してください。何度実行しても問題ありません。

alter table public.roadmap_items add column if not exists hidden boolean not null default false;

create or replace function public.roadmap_is_open(p_publish_on date, p_published_at timestamptz, p_hidden boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not coalesce(p_hidden, false)
     and (p_published_at is not null or p_publish_on <= (now() at time zone 'Asia/Tokyo')::date);
$$;

-- 公開の判定を使っている関数を、取り消しに対応した判定に置き換える
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
        and public.roadmap_is_open(r.publish_on, r.published_at, r.hidden)
    )
  );
$$;

create or replace function public.mark_roadmap_seen()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.roadmap_items set seen_at = now()
  where member_id = auth.uid() and seen_at is null
    and public.roadmap_is_open(publish_on, published_at, hidden);
$$;

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
      and public.roadmap_is_open(r.publish_on, r.published_at, r.hidden)
  );
$$;
