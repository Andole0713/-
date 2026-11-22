-- スタッフ向けの改善
--   ・コンシェルジュサポート：自動で送る連絡（事前アンケートのお願い・面談のお礼）を「お返事待ち」の判定から外す。「対応不要」にできるようにする
--   ・スタッフが返信したとき、会員にメールで知らせる（1時間に1通まで）ための記録
--   ・面談：記録を保存し直しても、カルテが二重にならないようにする（面談とカルテの記録をつなぐ）
--   ・面談：前日のお知らせメールを面談ごとに記録する／事前アンケートのお願いを「24時間以内の面談」にも送る（毎時）
--   ・面談の長さの初期値を20分に
--   ・カルテの「やったこと・見たこと」を10000文字まで（Zoomの要約が長くても切れないように）
--   ・プロ・コーチごとのZoomの部屋（スタッフだけが見られる）
--   ・スタッフへのまとめメール（1日2回）の送信記録
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。
-- 先に 20261116000000_meeting_mode.sql（面談モード）を実行しておいてください。

-- 1. コンシェルジュサポート：自動の連絡のしるし・メールで知らせた日時
alter table public.concierge_messages add column if not exists is_auto boolean not null default false;
alter table public.concierge_messages add column if not exists emailed_at timestamptz;
alter table public.concierge_messages drop constraint if exists concierge_messages_auto_staff;
alter table public.concierge_messages add constraint concierge_messages_auto_staff check (not is_auto or from_staff);
-- これまでに送った自動の連絡にも、しるしを付ける（事前アンケートのお願い：送った人なし／面談のお礼：決まった文）
update public.concierge_messages set is_auto = true
 where from_staff and not is_auto
   and (sender_id is null or body like '本日はオンライン面談ありがとうございました。%');

-- 会員ごとの「対応不要」にした日時（スタッフだけ）
create table if not exists public.concierge_threads (
  member_id uuid primary key references public.profiles (id) on delete cascade,
  done_at   timestamptz,
  done_by   uuid default auth.uid()
);
alter table public.concierge_threads enable row level security;
drop policy if exists "concierge_threads: 管理者のみ" on public.concierge_threads;
create policy "concierge_threads: 管理者のみ" on public.concierge_threads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.concierge_threads from anon;

-- 2. 面談
alter table public.meetings alter column duration_min set default 20;
alter table public.meetings add column if not exists reminded_at timestamptz;   -- 前日のお知らせメールを送った日時
alter table public.meetings add column if not exists chart_entry_id uuid references public.chart_entries (id) on delete set null; -- この面談の記録（カルテ）
-- これまでの「前日のお知らせ」の記録を引き継ぐ（同じ面談に二重に送らないように）
update public.meetings m set reminded_at = p.meeting_reminded_for
  from public.profiles p
 where p.id = m.member_id and m.reminded_at is null and p.meeting_reminded_for = m.scheduled_at;

-- 3. カルテの「やったこと・見たこと」を10000文字まで
alter table public.chart_entries drop constraint if exists chart_entries_content_check;
alter table public.chart_entries drop constraint if exists chart_entries_content_len;
alter table public.chart_entries add constraint chart_entries_content_len check (char_length(content) <= 10000);

-- 4. プロ・コーチごとのZoomの部屋（会員には見えない）
create table if not exists public.staff_settings (
  staff_id   uuid primary key references public.profiles (id) on delete cascade,
  zoom_url   text check (zoom_url is null or (char_length(zoom_url) <= 500 and zoom_url ~* '^https?://')),
  zoom_note  text not null default '' check (char_length(zoom_note) <= 1000),  -- ミーティングID・パスコードなど
  updated_at timestamptz not null default now()
);
alter table public.staff_settings enable row level security;
drop policy if exists "staff_settings: 管理者のみ" on public.staff_settings;
create policy "staff_settings: 管理者のみ" on public.staff_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.staff_settings from anon;

-- 5. スタッフへのまとめメールの送信記録（前回からの新しい動画を数えるため）
create table if not exists public.staff_digests (
  id      uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  counts  jsonb not null default '{}'::jsonb
);
create index if not exists staff_digests_sent_idx on public.staff_digests (sent_at desc);
alter table public.staff_digests enable row level security;
drop policy if exists "staff_digests: 管理者は閲覧可" on public.staff_digests;
create policy "staff_digests: 管理者は閲覧可" on public.staff_digests
  for select to authenticated using (public.is_admin());
revoke all on public.staff_digests from anon;

-- 6. 事前アンケートのお願い：明日の面談（10時から）と、24時間以内に始まる面談に送る（毎時）。自動の連絡のしるしを付ける
create or replace function public.remind_meeting_pre()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
  after10 boolean := extract(hour from (now() at time zone 'Asia/Tokyo')) >= 10;
begin
  if to_regclass('public.concierge_messages') is null then return 0; end if;
  for r in
    select id, member_id, scheduled_at from public.meetings
     where status = 'scheduled' and pre_at is null and pre_reminded_at is null
       and scheduled_at > now()
       and ((after10 and (scheduled_at at time zone 'Asia/Tokyo')::date = tomorrow)
            or scheduled_at <= now() + interval '24 hours')
  loop
    insert into public.concierge_messages (member_id, from_staff, sender_id, body, is_auto)
    values (r.member_id, true, null,
      case when (r.scheduled_at at time zone 'Asia/Tokyo')::date = tomorrow then '明日 ' else '本日 ' end
      || to_char(r.scheduled_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') || ' からのオンライン面談の前に、事前アンケートへのご回答をお願いします。' || chr(10)
      || 'ホームの「次回の面談」から3分ほどで答えられます。最新のスイング動画もお送りいただくと、面談でより詳しくお話しできます。', true);
    update public.meetings set pre_reminded_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.remind_meeting_pre() from public, anon, authenticated;

-- 7. 会員の「次回の面談」を毎日見直す（終わった面談が「予定」のまま残っても、古い日時が出続けないように）
create or replace function public.refresh_next_meetings()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with x as (
    select p.id, (select min(m.scheduled_at) from public.meetings m
                   where m.member_id = p.id and m.status = 'scheduled' and m.scheduled_at >= now() - interval '2 hours') as nxt
      from public.profiles p
  )
  update public.profiles p set next_meeting_at = x.nxt
    from x where x.id = p.id and p.next_meeting_at is distinct from x.nxt;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.refresh_next_meetings() from public, anon, authenticated;
select public.refresh_next_meetings();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('remind-meeting-pre'); exception when others then null; end;
    perform cron.schedule('remind-meeting-pre', '5 * * * *', 'select public.remind_meeting_pre()'); -- 毎時5分
    begin perform cron.unschedule('refresh-next-meetings'); exception when others then null; end;
    perform cron.schedule('refresh-next-meetings', '10 15 * * *', 'select public.refresh_next_meetings()'); -- 毎日 0:10（日本時間）
  else
    raise notice 'pg_cron が有効ではないため、事前アンケートのお願い・次回の面談の見直しの自動実行は設定していません';
  end if;
end $$;
