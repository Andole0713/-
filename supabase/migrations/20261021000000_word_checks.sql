-- 今日のゴルフ用語の「わかった！」を記録する（連続日数とバッジに使う）
--   ・これまではスマホの中だけに記録していたので、端末を変えると連続日数が消えていた
--   ・今日と昨日の分だけ記録できる（日本時間）
-- 何度実行しても問題ありません。

create table if not exists public.word_checks (
  member_id  uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  checked_on date not null,
  created_at timestamptz not null default now(),
  primary key (member_id, checked_on)
);

alter table public.word_checks enable row level security;
drop policy if exists "word_checks: 本人と管理者は閲覧可" on public.word_checks;
create policy "word_checks: 本人と管理者は閲覧可" on public.word_checks
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "word_checks: 本人が記録" on public.word_checks;
create policy "word_checks: 本人が記録" on public.word_checks
  for insert to authenticated
  with check (
    member_id = auth.uid()
    and checked_on <= (now() at time zone 'Asia/Tokyo')::date
    and checked_on >= (now() at time zone 'Asia/Tokyo')::date - 1
  );
revoke all on public.word_checks from anon;
