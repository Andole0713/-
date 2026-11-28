-- アプリからのオンライン面談の予約（hacomono とつなぐ前の下準備）
--   ・面談は毎時55分から20分（例：18:55〜19:15）。受け付ける時間は、スタッフが曜日ごとに決める（meeting_hours）
--   ・予約は3時間前まで。キャンセルは8時間前まで（それより後のキャンセルは回数を使う）
--   ・毎月20日から、翌月末までの分を受け付ける（19日までは今月末まで）
--   ・面談の回数（権利）を1回使う。回数がなければ予約できない
--   ・1人のプロ・コーチは、1時間の枠（:55〜次の:55 の前まで）にオンライン面談1件まで。担当はアプリが空いている人から自動で決める
--   ・お客様には、プロ・コーチの名前は出さない（空いている時間だけを出す）
-- hacomono とつないだあとは、この予約と同時に hacomono にも予約を入れる（hacomono_reservation_id に記録）
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- =========================================================
-- 1. オンライン面談を担当できるスタッフ（hacomono のスタッフ A・B との対応も）
-- =========================================================
alter table public.staff_settings add column if not exists online_ok boolean not null default false;
alter table public.staff_settings add column if not exists hacomono_instructor_ids bigint[] not null default '{}';

-- =========================================================
-- 2. 面談：どこから予約されたか・hacomono の予約
-- =========================================================
alter table public.meetings add column if not exists booked_via text not null default 'staff';
alter table public.meetings drop constraint if exists meetings_booked_via_check;
alter table public.meetings add constraint meetings_booked_via_check check (booked_via in ('staff', 'app'));
alter table public.meetings add column if not exists hacomono_reservation_id bigint;
alter table public.meetings add column if not exists hacomono_instructor_id bigint;

-- =========================================================
-- 3. 受け付ける時間（曜日ごと・毎時55分の開始時刻）
-- =========================================================
create table if not exists public.meeting_hours (
  weekday    smallint not null check (weekday between 0 and 6),   -- 0:日 1:月 … 6:土
  start_time time not null check (extract(minute from start_time) = 55 and extract(second from start_time) = 0),
  primary key (weekday, start_time)
);
alter table public.meeting_hours enable row level security;
drop policy if exists "meeting_hours: 管理者" on public.meeting_hours;
create policy "meeting_hours: 管理者" on public.meeting_hours
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.meeting_hours from anon;
grant select, insert, update, delete on public.meeting_hours to authenticated, service_role;

-- =========================================================
-- 4. 決まり
-- =========================================================
-- 受け付ける最後の日：20日からは翌月末まで、19日までは今月末まで
create or replace function public.meeting_open_until(p_today date default public.jst_today())
returns date language sql immutable set search_path = '' as $$
  select (date_trunc('month', p_today) + case when extract(day from p_today) >= 20 then interval '2 months' else interval '1 month' end - interval '1 day')::date;
$$;

-- 1時間の枠の始まり（:55 開始の面談は、次の時間の枠。例：18:55 → 19:00 の枠）
create or replace function public.meeting_block(p_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select date_trunc('hour', p_at + interval '10 minutes');
$$;

-- その時間に、オンライン面談を担当できるスタッフ（1時間の枠にオンライン面談がまだない人）。空いていなければ null
create or replace function public.meeting_free_staff(p_at timestamptz)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.staff_id
    from public.staff_settings s
    join public.profiles p on p.id = s.staff_id and p.role = 'admin'
   where s.online_ok
     and not exists (
       select 1 from public.meetings m
        where m.staff_id = s.staff_id and m.status in ('scheduled', 'done')
          and public.meeting_block(m.scheduled_at) = public.meeting_block(p_at))
   order by (select count(*) from public.meetings m2
              where m2.staff_id = s.staff_id and m2.status in ('scheduled', 'done')
                and (m2.scheduled_at at time zone 'Asia/Tokyo')::date = (p_at at time zone 'Asia/Tokyo')::date), random()
   limit 1;
$$;

-- 予約できる時間の一覧（会員用。ほかの会員の予約やスタッフの名前は返さない）
create or replace function public.meeting_slots(p_from date, p_to date)
returns table (slot_at timestamptz, available boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_until date := public.meeting_open_until();
  d date;
  h record;
  t timestamptz;
begin
  if v_me is null then return; end if;
  if p_to > v_until then p_to := v_until; end if;
  if p_from < public.jst_today() then p_from := public.jst_today(); end if;
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  d := p_from;
  while d <= p_to loop
    for h in select start_time from public.meeting_hours where weekday = extract(dow from d) order by start_time loop
      t := (d + h.start_time) at time zone 'Asia/Tokyo';
      slot_at := t;
      if t < now() + interval '3 hours' then
        available := false; reason := '受付終了';
      elsif exists (select 1 from public.meetings m where m.member_id = v_me and m.status = 'scheduled' and public.meeting_block(m.scheduled_at) = public.meeting_block(t)) then
        available := false; reason := '予約済み';
      elsif public.meeting_free_staff(t) is null then
        available := false; reason := '満席';
      else
        available := true; reason := '';
      end if;
      return next;
    end loop;
    d := d + 1;
  end loop;
end;
$$;

-- 予約する（会員）。面談の回数を1回使う
create or replace function public.book_meeting(p_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_jst timestamp := p_at at time zone 'Asia/Tokyo';
  v_staff uuid;
  v_id uuid;
begin
  if v_me is null then raise exception 'ログインしてください'; end if;
  if not public.is_member_active(v_me) then raise exception 'いまのプランでは予約できません'; end if;
  if extract(minute from v_jst) <> 55 or extract(second from v_jst) <> 0 then raise exception '予約できない時刻です'; end if;
  if not exists (select 1 from public.meeting_hours where weekday = extract(dow from v_jst) and start_time = v_jst::time) then
    raise exception 'この時間は受け付けていません';
  end if;
  if p_at < now() + interval '3 hours' then raise exception '予約は3時間前までです。ほかの時間をお選びください'; end if;
  if v_jst::date > public.meeting_open_until() then raise exception 'この日の受付はまだ始まっていません（毎月20日から翌月分を受け付けます）'; end if;
  -- 同じ時間に2人が予約しても、担当が重ならないように（1時間の枠ごとに順番に処理する）
  perform pg_advisory_xact_lock(hashtextextended('meeting:' || public.meeting_block(p_at)::text, 0));
  if exists (select 1 from public.meetings where member_id = v_me and status = 'scheduled' and public.meeting_block(scheduled_at) = public.meeting_block(p_at)) then
    raise exception 'この時間はすでに予約しています';
  end if;
  v_staff := public.meeting_free_staff(p_at);
  if v_staff is null then raise exception 'この時間は満席になりました。ほかの時間をお選びください'; end if;
  -- 回数（権利）を使う（足りなければ、ここで止まる）
  insert into public.meetings (member_id, scheduled_at, duration_min, status, pay_type, staff_id, booked_via)
  values (v_me, p_at, 20, 'scheduled', 'credit', v_staff, 'app')
  returning id into v_id;
  update public.profiles set next_meeting_at = (
    select min(scheduled_at) from public.meetings where member_id = v_me and status = 'scheduled' and scheduled_at > now() - interval '2 hours')
   where id = v_me;
  return v_id;
exception
  when raise_exception then
    if sqlerrm like '面談の権利が残っていません%' then
      raise exception '面談の回数が残っていません。追加するときは、コンシェルジュサポートからご連絡ください';
    end if;
    raise;
end;
$$;

-- キャンセルする（会員）。8時間前までは回数が戻る。それより後は回数を使う（予約の開始時刻を過ぎたらキャンセルできない）
create or replace function public.cancel_my_meeting(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  m record;
  v_late boolean;
begin
  select * into m from public.meetings where id = p_id and member_id = v_me for update;
  if m.id is null then raise exception '予約が見つかりません'; end if;
  if m.status <> 'scheduled' then raise exception 'この予約はキャンセルできません'; end if;
  if m.scheduled_at <= now() then raise exception '開始時刻を過ぎた予約はキャンセルできません'; end if;
  v_late := m.scheduled_at < now() + interval '8 hours';
  update public.meetings set status = 'canceled', updated_at = now() where id = p_id;   -- ここで回数が戻る
  if v_late and m.pay_type = 'credit' then
    -- 8時間を切ったキャンセルは、回数を使ったままにする（使う回数が残っていなければ、そのままキャンセル）
    begin
      perform public.use_credit(v_me, 'meeting', 'meeting', p_id);
    exception when others then null;
    end;
  end if;
  update public.profiles set next_meeting_at = (
    select min(scheduled_at) from public.meetings where member_id = v_me and status = 'scheduled' and scheduled_at > now() - interval '2 hours')
   where id = v_me;
  return case when v_late then 'late' else 'refunded' end;
end;
$$;

revoke execute on function public.meeting_free_staff(timestamptz) from public, anon, authenticated;
revoke execute on function public.meeting_slots(date, date) from public, anon;
grant execute on function public.meeting_slots(date, date) to authenticated;
revoke execute on function public.book_meeting(timestamptz) from public, anon;
grant execute on function public.book_meeting(timestamptz) to authenticated;
revoke execute on function public.cancel_my_meeting(uuid) from public, anon;
grant execute on function public.cancel_my_meeting(uuid) to authenticated;
grant execute on function public.meeting_open_until(date) to authenticated;
