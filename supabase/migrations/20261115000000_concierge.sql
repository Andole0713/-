-- コンシェルジュサポート（会員とスタッフの連絡）と、面談の参加リンク・案内
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- 1. 面談の参加リンク（Zoom・Google Meet など）と案内（ミーティングID・パスコードなど）
alter table public.meetings add column if not exists join_url text check (join_url is null or char_length(join_url) <= 500);
alter table public.meetings add column if not exists join_info text not null default '' check (char_length(join_info) <= 1000);

-- 2. コンシェルジュサポートの連絡（1人の会員ごとに1つのやりとり）
create table if not exists public.concierge_messages (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.profiles (id) on delete cascade, -- どの会員とのやりとりか
  from_staff boolean not null default false,                                  -- スタッフが送ったものか
  sender_id  uuid default auth.uid(),                                         -- 送った人（profiles への参照は付けない）
  category   text check (category in ('meeting', 'payment', 'app', 'other', 'quick')), -- 会員が選んだ用件
  body       text not null check (char_length(body) between 1 and 1000),
  read_at    timestamptz,                                                     -- 相手が読んだ日時
  created_at timestamptz not null default now()
);
create index if not exists concierge_member_idx on public.concierge_messages (member_id, created_at desc);
create index if not exists concierge_unread_idx on public.concierge_messages (created_at) where read_at is null;
alter table public.concierge_messages enable row level security;

drop policy if exists "concierge: 本人と管理者は閲覧可" on public.concierge_messages;
create policy "concierge: 本人と管理者は閲覧可" on public.concierge_messages
  for select using (member_id = auth.uid() or public.is_admin());
drop policy if exists "concierge: 会員は自分のやりとりに送れる" on public.concierge_messages;
create policy "concierge: 会員は自分のやりとりに送れる" on public.concierge_messages
  for insert with check (member_id = auth.uid() and from_staff = false and category is not null and read_at is null);
drop policy if exists "concierge: 管理者は送れる" on public.concierge_messages;
create policy "concierge: 管理者は送れる" on public.concierge_messages
  for insert with check (public.is_admin() and from_staff = true and read_at is null);

-- 送りすぎを防ぐ（会員は1日20件まで）
create or replace function public.concierge_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.from_staff and (select count(*) from public.concierge_messages
      where member_id = new.member_id and from_staff = false and created_at > now() - interval '1 day') >= 20 then
    raise exception '本日はこれ以上送れません。お急ぎの場合はLINEでご連絡ください';
  end if;
  return new;
end;
$$;
drop trigger if exists concierge_limit on public.concierge_messages;
create trigger concierge_limit before insert on public.concierge_messages for each row execute function public.concierge_limit();

-- 読んだしるし：会員はスタッフからの連絡を、スタッフは会員からの連絡を「読んだ」にする
create or replace function public.concierge_mark_read(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin() then
    update public.concierge_messages set read_at = now() where member_id = p_member and from_staff = false and read_at is null;
  elsif p_member = auth.uid() then
    update public.concierge_messages set read_at = now() where member_id = auth.uid() and from_staff = true and read_at is null;
  end if;
end;
$$;
revoke execute on function public.concierge_mark_read(uuid) from public, anon;
grant execute on function public.concierge_mark_read(uuid) to authenticated;
