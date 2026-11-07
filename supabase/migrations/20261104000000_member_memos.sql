-- 会員が自分で書くメモ（練習で気づいたこと・覚えておきたいことなど）。コーチも会員詳細で見られる
-- 何度実行しても問題ありません。
create table if not exists public.member_memos (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists member_memos_member_idx on public.member_memos (member_id, created_at desc);
alter table public.member_memos enable row level security;
drop policy if exists "member_memos: 本人と管理者が閲覧" on public.member_memos;
create policy "member_memos: 本人と管理者が閲覧" on public.member_memos
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "member_memos: 本人が書く" on public.member_memos;
create policy "member_memos: 本人が書く" on public.member_memos
  for insert to authenticated with check (member_id = auth.uid());
drop policy if exists "member_memos: 本人が直す" on public.member_memos;
create policy "member_memos: 本人が直す" on public.member_memos
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());
drop policy if exists "member_memos: 本人が消す" on public.member_memos;
create policy "member_memos: 本人が消す" on public.member_memos
  for delete to authenticated using (member_id = auth.uid());
revoke all on public.member_memos from anon;
