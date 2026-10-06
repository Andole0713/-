-- 管理者の運営機能
--   ・面談の予定と記録（meetings）：予約・日時変更・結果（完了／欠席／キャンセル）・会員に見せるまとめ
--   ・担当者メモ（staff_notes）：会員には見えない、スタッフ間の申し送り
--   ・会員の「次回の面談」（profiles.next_meeting_at）は、面談の予定から自動で更新する
-- 何度実行しても問題ありません。

create table if not exists public.meetings (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.profiles (id) on delete cascade,
  scheduled_at timestamptz not null,
  duration_min smallint not null default 25 check (duration_min between 5 and 180),
  status       text not null default 'scheduled' check (status in ('scheduled', 'done', 'canceled', 'no_show')),
  summary      text not null default '' check (char_length(summary) <= 2000),   -- 会員にも見える面談のまとめ
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists meetings_time_idx on public.meetings (scheduled_at);
create index if not exists meetings_member_idx on public.meetings (member_id, scheduled_at desc);

create table if not exists public.staff_notes (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  pinned     boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists staff_notes_member_idx on public.staff_notes (member_id, created_at desc);

alter table public.meetings    enable row level security;
alter table public.staff_notes enable row level security;

drop policy if exists "meetings: 本人と管理者は閲覧可" on public.meetings;
create policy "meetings: 本人と管理者は閲覧可" on public.meetings
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "meetings: 管理者は追加・更新・削除可" on public.meetings;
create policy "meetings: 管理者は追加・更新・削除可" on public.meetings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff_notes: 管理者のみ" on public.staff_notes;
create policy "staff_notes: 管理者のみ" on public.staff_notes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.meetings, public.staff_notes from anon;

-- 面談の予定が変わったら、会員の「次回の面談」を自動で更新する
create or replace function public.sync_next_meeting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m uuid := coalesce(new.member_id, old.member_id);
begin
  update public.profiles p set next_meeting_at = (
    select min(x.scheduled_at) from public.meetings x
    where x.member_id = m and x.status = 'scheduled' and x.scheduled_at >= now() - interval '2 hours'
  ) where p.id = m;
  return null;
end;
$$;

create or replace function public.touch_meeting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meetings_touch on public.meetings;
create trigger meetings_touch before update on public.meetings
  for each row execute function public.touch_meeting();

drop trigger if exists meetings_sync_next on public.meetings;
create trigger meetings_sync_next after insert or update or delete on public.meetings
  for each row execute function public.sync_next_meeting();

-- これまで会員情報に直接入れていた「次回の面談日時」を、面談の予定として移す
insert into public.meetings (member_id, scheduled_at)
select p.id, p.next_meeting_at from public.profiles p
where p.next_meeting_at is not null
  and not exists (select 1 from public.meetings x where x.member_id = p.id and x.scheduled_at = p.next_meeting_at);
