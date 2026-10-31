-- 会員全体へのお知らせ（アップデート・不具合のお詫び・アンケートなど）と、
-- 会員からの不具合・要望の受付
-- 何度実行しても問題ありません。

-- ---------- お知らせ ----------
-- 送ると、会員がアプリを開いたときに必ずその画面を通る。確認すると次からは出ない
create table if not exists public.announcements (
  id           bigint generated always as identity primary key,
  kind         text not null default 'info' check (kind in ('update', 'apology', 'info', 'question')),
  title        text not null check (char_length(title) between 1 and 80),
  body         text not null default '' check (char_length(body) <= 3000),
  choices      text[] not null default '{}',             -- 選んで答えてもらう選択肢（空なら確認だけ）
  allow_comment boolean not null default false,          -- ひと言の自由記入欄を出すか
  audience     text not null default 'active' check (audience in ('active', 'all')), -- active＝契約中の会員だけ
  active       boolean not null default true,            -- 取り下げると、まだ見ていない人にも出なくなる
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.announcements enable row level security;
drop policy if exists "announcements: 会員が閲覧" on public.announcements;
create policy "announcements: 会員が閲覧" on public.announcements
  for select to authenticated using (active or public.is_admin());
drop policy if exists "announcements: 管理者が作成・変更" on public.announcements;
create policy "announcements: 管理者が作成・変更" on public.announcements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 会員ごとの確認・回答
create table if not exists public.announcement_reads (
  announcement_id bigint not null references public.announcements (id) on delete cascade,
  member_id       uuid not null references public.profiles (id) on delete cascade,
  read_at         timestamptz not null default now(),
  choice          text check (char_length(choice) <= 100),
  comment         text check (char_length(comment) <= 1000),
  primary key (announcement_id, member_id)
);
alter table public.announcement_reads enable row level security;
drop policy if exists "announcement_reads: 本人が記録" on public.announcement_reads;
create policy "announcement_reads: 本人が記録" on public.announcement_reads
  for insert to authenticated with check (member_id = auth.uid());
drop policy if exists "announcement_reads: 本人と管理者が閲覧" on public.announcement_reads;
create policy "announcement_reads: 本人と管理者が閲覧" on public.announcement_reads
  for select to authenticated using (member_id = auth.uid() or public.is_admin());

-- ---------- 不具合・要望 ----------
create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  member_id   uuid references public.profiles (id) on delete set null,
  kind        text not null check (kind in ('bug', 'request', 'other')),
  body        text not null check (char_length(body) between 1 and 2000),
  page        text not null default '' check (char_length(page) <= 200),   -- 送ったときに開いていた画面
  device      text not null default '' check (char_length(device) <= 500), -- 端末・ブラウザ（不具合を調べる手がかり）
  status      text not null default 'open' check (status in ('open', 'done')),
  reply       text not null default '' check (char_length(reply) <= 1000), -- スタッフからの返事（会員にも見える）
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists feedback_open_idx on public.feedback (created_at) where status = 'open';
alter table public.feedback enable row level security;
drop policy if exists "feedback: 本人が送信" on public.feedback;
create policy "feedback: 本人が送信" on public.feedback
  for insert to authenticated with check (member_id = auth.uid() and status = 'open' and reply = '');
drop policy if exists "feedback: 本人と管理者が閲覧" on public.feedback;
create policy "feedback: 本人と管理者が閲覧" on public.feedback
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "feedback: 管理者が返事・対応" on public.feedback;
create policy "feedback: 管理者が返事・対応" on public.feedback
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.announcements, public.announcement_reads, public.feedback from anon;
