-- ドリル動画
--   ・コーチが作ったドリル（動画ファイル または YouTube）を「ドリル集」として保存し、何人の会員にも使い回せる
--   ・レッスンにドリルを付けると、会員ページの「ドリル」にたまっていく
--   ・ドリルは自動では削除しない。会員が見られるのは契約中（利用期限内）だけ
-- すでに初期設定を実行したデータベースでは、このファイルを SQL Editor で実行してください。何度実行しても問題ありません。

create table if not exists public.drills (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  -- 動画ファイル（Storage の drill-videos に保存。パスは「drills/ファイル名」）
  video_path  text check (video_path is null or video_path ~ '^drills/[A-Za-z0-9._-]{1,120}$'),
  -- または YouTube のリンク
  video_url   text check (
    video_url is null or
    video_url ~ '^https://(www\.|m\.)?(youtube\.com/(watch\?v=|shorts/|live/)|youtu\.be/)[A-Za-z0-9_-]{11}'
  ),
  created_at  timestamptz not null default now(),
  constraint drills_has_video check (video_path is not null or video_url is not null)
);
create index if not exists drills_created_idx on public.drills (created_at desc);

-- どのレッスンにどのドリルを付けたか
create table if not exists public.lesson_drills (
  lesson_id  uuid not null references public.lessons (id) on delete cascade,
  drill_id   uuid not null references public.drills (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (lesson_id, drill_id)
);
create index if not exists lesson_drills_drill_idx on public.lesson_drills (drill_id);

-- ログイン中の会員に、このドリルが届いていて、かつ契約中か
create or replace function public.can_view_drill(p_drill uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_active_subscription() and exists (
    select 1 from public.lesson_drills ld
    join public.lessons l on l.id = ld.lesson_id
    where ld.drill_id = p_drill and l.member_id = auth.uid()
  );
$$;

-- 動画ファイルのパスから同じ判定をする（Storage の閲覧権限で使う）
create or replace function public.can_view_drill_file(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.drills d
    where d.video_path = p_path and public.can_view_drill(d.id)
  );
$$;

revoke execute on function public.can_view_drill(uuid), public.can_view_drill_file(text) from anon, public;
grant execute on function public.can_view_drill(uuid), public.can_view_drill_file(text) to authenticated;

alter table public.drills        enable row level security;
alter table public.lesson_drills enable row level security;

drop policy if exists "drills: 管理者と、届いている契約中の会員は閲覧可" on public.drills;
create policy "drills: 管理者と、届いている契約中の会員は閲覧可" on public.drills
  for select to authenticated
  using (public.is_admin() or public.can_view_drill(id));

drop policy if exists "drills: 管理者は追加・更新・削除可" on public.drills;
create policy "drills: 管理者は追加・更新・削除可" on public.drills
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "lesson_drills: 本人と管理者は閲覧可" on public.lesson_drills;
create policy "lesson_drills: 本人と管理者は閲覧可" on public.lesson_drills
  for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.lessons l where l.id = lesson_id and l.member_id = auth.uid())
  );

drop policy if exists "lesson_drills: 管理者は追加・更新・削除可" on public.lesson_drills;
create policy "lesson_drills: 管理者は追加・更新・削除可" on public.lesson_drills
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.drills, public.lesson_drills from anon;

-- ドリル動画の保存場所（非公開）
insert into storage.buckets (id, name, public)
values ('drill-videos', 'drill-videos', false)
on conflict (id) do nothing;

drop policy if exists "drill-videos: 管理者がアップロード" on storage.objects;
create policy "drill-videos: 管理者がアップロード" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'drill-videos' and public.is_admin());

drop policy if exists "drill-videos: 管理者と、届いている契約中の会員が閲覧" on storage.objects;
create policy "drill-videos: 管理者と、届いている契約中の会員が閲覧" on storage.objects
  for select to authenticated
  using (bucket_id = 'drill-videos' and (public.is_admin() or public.can_view_drill_file(name)));

drop policy if exists "drill-videos: 管理者が削除" on storage.objects;
create policy "drill-videos: 管理者が削除" on storage.objects
  for delete to authenticated
  using (bucket_id = 'drill-videos' and public.is_admin());
