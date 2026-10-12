-- お祝いメッセージ（コーチ → 会員）
--   ・管理画面の「お祝い」から、メッセージを付けて会員に送る（ベスト更新・好スコア・入会記念など）
--   ・会員はアプリのホームで受け取り、「お祝い」ページでこれまでのお祝いを見返せる
-- 何度実行しても問題ありません。

create table if not exists public.celebrations (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.profiles (id) on delete cascade,
  round_id   uuid references public.rounds (id) on delete set null,   -- スコアのお祝いのとき
  stamp      text not null default 'trophy' check (stamp in ('trophy', 'party', 'flag', 'clap', 'fire', 'star')),
  title      text not null check (char_length(title) between 1 and 60),
  message    text not null default '' check (char_length(message) <= 1000),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  seen_at    timestamptz
);
create index if not exists celebrations_member_idx on public.celebrations (member_id, created_at desc);

alter table public.celebrations enable row level security;
drop policy if exists "celebrations: 本人と管理者は閲覧可" on public.celebrations;
create policy "celebrations: 本人と管理者は閲覧可" on public.celebrations
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "celebrations: 管理者が送る" on public.celebrations;
create policy "celebrations: 管理者が送る" on public.celebrations
  for insert to authenticated with check (public.is_admin());
drop policy if exists "celebrations: 管理者が編集" on public.celebrations;
create policy "celebrations: 管理者が編集" on public.celebrations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "celebrations: 管理者が削除" on public.celebrations;
create policy "celebrations: 管理者が削除" on public.celebrations
  for delete to authenticated using (public.is_admin());
revoke all on public.celebrations from anon;

-- 会員：受け取ったお祝いを「見た」にする
create or replace function public.mark_celebrations_seen()
returns void language sql security definer set search_path = '' as $$
  update public.celebrations set seen_at = now() where member_id = auth.uid() and seen_at is null;
$$;
revoke execute on function public.mark_celebrations_seen() from public, anon;
grant execute on function public.mark_celebrations_seen() to authenticated;
