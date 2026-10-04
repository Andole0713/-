-- オンラインゴルフレッスン 会員サイト 初期スキーマ
-- Supabase の SQL Editor に貼り付けて実行するか、`supabase db push` で適用します。

-- =========================================================
-- テーブル
-- =========================================================

-- 会員プロフィール（auth.users と 1 対 1）
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  role                 text not null default 'member' check (role in ('member', 'admin')),
  name                 text not null default '',
  email                text,
  plan                 text check (plan in ('SUBSCRIPTION', 'YOUCAN')),
  goal                 text not null default '',
  best_score           integer check (best_score between 40 and 200),
  avg_score            integer check (avg_score between 40 and 200),
  theme                text not null default '',
  next_meeting_at      timestamptz,             -- 次回の面談日時（管理者が設定）
  access_until         date,                    -- 利用期限（LINE・電話で申し込んだ会員用。管理者が設定）
  stripe_customer_id   text unique,
  subscription_id      text,
  subscription_status  text not null default 'none',
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 今週の練習課題
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 100),
  detail      text not null default '' check (char_length(detail) <= 200),
  sort_order  integer not null default 0,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index tasks_member_idx on public.tasks (member_id, sort_order);

-- 動画提出（会員ページから直接アップロード。ファイルは Storage の swing-videos に保存）
create table public.submissions (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid not null references public.profiles (id) on delete cascade,
  -- Storage 上のパス：「会員ID/ファイル名」
  video_path       text not null check (video_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$'),
  -- 保存期間（3か月）を過ぎて動画ファイルを削除した日時
  video_deleted_at timestamptz,
  club         text not null default '' check (char_length(club) <= 30),
  angle        text not null default '' check (char_length(angle) <= 30),
  question     text not null default '' check (char_length(question) <= 2000),
  status       text not null default 'pending' check (status in ('pending', 'reviewed')),
  created_at   timestamptz not null default now()
);
create index submissions_member_idx on public.submissions (member_id, created_at desc);
create index submissions_pending_idx on public.submissions (created_at) where status = 'pending';

-- レッスン（コーチからの診断・フィードバック）
create table public.lessons (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references public.profiles (id) on delete cascade,
  submission_id  uuid references public.submissions (id) on delete set null,
  lesson_date    date not null default current_date,
  title          text not null check (char_length(title) between 1 and 100),
  point          text not null default '' check (char_length(point) <= 300),
  feedback       text not null default '' check (char_length(feedback) <= 5000),
  practice       text not null default '' check (char_length(practice) <= 2000),
  video_url      text check (
    video_url is null or
    video_url ~ '^https://(www\.|m\.)?(youtube\.com/(watch\?v=|shorts/|live/)|youtu\.be/)[A-Za-z0-9_-]{11}'
  ),
  created_at     timestamptz not null default now()
);
create index lessons_member_idx on public.lessons (member_id, lesson_date desc, created_at desc);

-- =========================================================
-- ヘルパー関数
-- =========================================================

-- ログイン中のユーザーが管理者かどうか（RLS から呼ぶため security definer）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ログイン中のユーザーが有効な契約中かどうか
create or replace function public.has_active_subscription()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and (subscription_status in ('active', 'trialing') or access_until >= current_date)
  );
$$;

-- サービスロール（Edge Function / Stripe Webhook）からの操作かどうか
create or replace function public.is_service_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or current_user in ('postgres', 'supabase_admin', 'service_role');
$$;

-- =========================================================
-- トリガー
-- =========================================================

-- 新規登録時にプロフィールを自動作成
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    left(coalesce(new.raw_user_meta_data ->> 'name', ''), 50)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 会員が自分のプロフィールを更新するときに、変更できる項目を制限する
-- （権限・プラン・契約状態は管理者か Stripe Webhook だけが変更できる）
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_service_role() then
    new.updated_at := now();
    return new;
  end if;

  if public.is_admin() then
    -- 管理者でも Stripe 関連の項目は変更不可（Webhook と食い違わないように）
    if new.stripe_customer_id  is distinct from old.stripe_customer_id
    or new.subscription_id     is distinct from old.subscription_id
    or new.subscription_status is distinct from old.subscription_status
    or new.current_period_end  is distinct from old.current_period_end then
      raise exception '契約情報は Stripe からのみ更新できます';
    end if;
    -- 自分自身の管理者権限は外せない（管理者不在の事故防止）
    if old.id = auth.uid() and new.role is distinct from old.role then
      raise exception '自分の権限は変更できません';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- 一般会員：名前のみ変更可
  if new.id                  is distinct from old.id
  or new.role                is distinct from old.role
  or new.email               is distinct from old.email
  or new.plan                is distinct from old.plan
  or new.goal                is distinct from old.goal
  or new.best_score          is distinct from old.best_score
  or new.avg_score           is distinct from old.avg_score
  or new.theme               is distinct from old.theme
  or new.next_meeting_at     is distinct from old.next_meeting_at
  or new.access_until        is distinct from old.access_until
  or new.stripe_customer_id  is distinct from old.stripe_customer_id
  or new.subscription_id     is distinct from old.subscription_id
  or new.subscription_status is distinct from old.subscription_status
  or new.current_period_end  is distinct from old.current_period_end
  or new.created_at          is distinct from old.created_at then
    raise exception '変更できない項目が含まれています';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger guard_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- 会員は課題の「完了」だけ切り替えられる
create or replace function public.guard_task_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_service_role() or public.is_admin() then
    return new;
  end if;
  if new.id         is distinct from old.id
  or new.member_id  is distinct from old.member_id
  or new.title      is distinct from old.title
  or new.detail     is distinct from old.detail
  or new.sort_order is distinct from old.sort_order
  or new.created_at is distinct from old.created_at then
    raise exception '課題の内容は変更できません';
  end if;
  return new;
end;
$$;

create trigger guard_task_update
  before update on public.tasks
  for each row execute function public.guard_task_update();

-- =========================================================
-- 行レベルセキュリティ（RLS）
-- =========================================================

alter table public.profiles    enable row level security;
alter table public.tasks       enable row level security;
alter table public.submissions enable row level security;
alter table public.lessons     enable row level security;

-- profiles
create policy "profiles: 本人と管理者は閲覧可" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy "profiles: 本人と管理者は更新可" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- tasks
create policy "tasks: 本人と管理者は閲覧可" on public.tasks
  for select to authenticated
  using (member_id = auth.uid() or public.is_admin());

create policy "tasks: 本人は完了切替、管理者は編集可" on public.tasks
  for update to authenticated
  using (member_id = auth.uid() or public.is_admin())
  with check (member_id = auth.uid() or public.is_admin());

create policy "tasks: 管理者は追加可" on public.tasks
  for insert to authenticated
  with check (public.is_admin());

create policy "tasks: 管理者は削除可" on public.tasks
  for delete to authenticated
  using (public.is_admin());

-- submissions
create policy "submissions: 本人と管理者は閲覧可" on public.submissions
  for select to authenticated
  using (member_id = auth.uid() or public.is_admin());

create policy "submissions: 契約中の本人は提出可" on public.submissions
  for insert to authenticated
  with check (
    member_id = auth.uid()
    and split_part(video_path, '/', 1) = auth.uid()::text
    and status = 'pending'
    and video_deleted_at is null
    and public.has_active_subscription()
  );

create policy "submissions: 管理者は更新可" on public.submissions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "submissions: 管理者は削除可" on public.submissions
  for delete to authenticated
  using (public.is_admin());

-- lessons
create policy "lessons: 本人と管理者は閲覧可" on public.lessons
  for select to authenticated
  using (member_id = auth.uid() or public.is_admin());

create policy "lessons: 管理者は追加可" on public.lessons
  for insert to authenticated
  with check (public.is_admin());

create policy "lessons: 管理者は更新可" on public.lessons
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "lessons: 管理者は削除可" on public.lessons
  for delete to authenticated
  using (public.is_admin());

-- 未ログイン（anon）からは一切アクセスさせない
revoke all on public.profiles, public.tasks, public.submissions, public.lessons from anon;
revoke execute on function public.is_admin(), public.has_active_subscription() from anon, public;
grant execute on function public.is_admin(), public.has_active_subscription() to authenticated, service_role;

-- =========================================================
-- 動画の保存場所（Storage）
-- =========================================================

-- 非公開のバケット。ファイルは「会員ID/ファイル名」に保存する。
-- 1本あたりの容量上限は設けない（Supabase の「Upload file size limit」の範囲内）。
insert into storage.buckets (id, name, public)
values ('swing-videos', 'swing-videos', false)
on conflict (id) do nothing;

create policy "swing-videos: 本人がアップロード" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_active_subscription()
  );

create policy "swing-videos: 本人と管理者が閲覧" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'swing-videos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

create policy "swing-videos: 管理者が削除" on storage.objects
  for delete to authenticated
  using (bucket_id = 'swing-videos' and public.is_admin());

-- 3か月を過ぎた動画の一覧（自動削除の処理 purge-old-videos が使う）
create index submissions_video_expiry_idx on public.submissions (created_at) where video_deleted_at is null;
