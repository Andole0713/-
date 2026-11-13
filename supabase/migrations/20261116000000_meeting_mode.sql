-- 面談モード（準備メモ・記録）と、面談の事前アンケート
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。
-- 先に 20261115000000_concierge.sql（コンシェルジュサポート）を実行しておいてください。

-- 1. 面談ごとの準備メモ（スタッフだけ）と、事前アンケートの回答
alter table public.meetings add column if not exists prep_memo text not null default '' check (char_length(prep_memo) <= 1000);
alter table public.meetings add column if not exists pre_done text not null default '' check (char_length(pre_done) <= 600);     -- 今月できたこと
alter table public.meetings add column if not exists pre_trouble text not null default '' check (char_length(pre_trouble) <= 600); -- 困っていること
alter table public.meetings add column if not exists pre_ask text not null default '' check (char_length(pre_ask) <= 600);       -- 面談で聞きたいこと
alter table public.meetings add column if not exists pre_at timestamptz;          -- 事前アンケートに答えた日時
alter table public.meetings add column if not exists pre_reminded_at timestamptz; -- 事前アンケートのお願いを送った日時

-- 2. 会員が事前アンケートに答える（自分の、まだ終わっていない面談だけ）
create or replace function public.submit_meeting_pre(p_meeting uuid, p_done text, p_trouble text, p_ask text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.meetings
     set pre_done = left(coalesce(p_done, ''), 600), pre_trouble = left(coalesce(p_trouble, ''), 600),
         pre_ask = left(coalesce(p_ask, ''), 600), pre_at = now()
   where id = p_meeting and member_id = auth.uid() and status = 'scheduled';
  if not found then raise exception 'この面談のアンケートには答えられません'; end if;
end;
$$;
revoke execute on function public.submit_meeting_pre(uuid, text, text, text) from public, anon;
grant execute on function public.submit_meeting_pre(uuid, text, text, text) to authenticated;

-- 3. 明日の面談で、事前アンケートがまだの会員に、コンシェルジュサポートでお願いを送る（毎日10時）
create or replace function public.remind_meeting_pre()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
  tomorrow date := (now() at time zone 'Asia/Tokyo')::date + 1;
begin
  if to_regclass('public.concierge_messages') is null then return 0; end if;
  for r in
    select id, member_id, scheduled_at from public.meetings
     where status = 'scheduled' and pre_at is null and pre_reminded_at is null
       and (scheduled_at at time zone 'Asia/Tokyo')::date = tomorrow
  loop
    insert into public.concierge_messages (member_id, from_staff, sender_id, body)
    values (r.member_id, true, null,
      '明日 ' || to_char(r.scheduled_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') || ' からのオンライン面談の前に、事前アンケートへのご回答をお願いします。' || chr(10)
      || 'ホームの「次回の面談」から3分ほどで答えられます。最新のスイング動画もお送りいただくと、面談でより詳しくお話しできます。');
    update public.meetings set pre_reminded_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.remind_meeting_pre() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('remind-meeting-pre'); exception when others then null; end;
    perform cron.schedule('remind-meeting-pre', '0 1 * * *', 'select public.remind_meeting_pre()'); -- 毎日 10:00（日本時間）
  else
    raise notice 'pg_cron が有効ではないため、事前アンケートの自動のお願いは設定していません';
  end if;
end $$;
