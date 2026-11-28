-- オンライン面談の受付時間を、hacomono のスタッフシフトから作る
--   ・hacomono では、1人のプロ・コーチを「コーチA」「コーチB」の2人のスタッフとして登録している（スタッフコード IN0001 など）
--   ・スタッフの画面で、プロ・コーチごとに A・B のスタッフコードを登録する（hacomono_instructor_codes）
--   ・自動処理（hacomono-schedule）が、hacomono のシフトと予約を読んで、受けられる :55 を meeting_availability に書く
--   ・meeting_availability にデータがあるあいだは、受付時間はこちらを使う（スタッフが決めた meeting_hours は使わない）
--     データがない（hacomono とつなぐ前）あいだは、これまでどおり meeting_hours を使う
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- 1. プロ・コーチごとの hacomono のスタッフコード（A・B）
alter table public.staff_settings add column if not exists hacomono_instructor_codes text[] not null default '{}';

-- 2. hacomono から読んだ「受けられる時間」（プロ・コーチごと・:55 の開始時刻ごと。free_ids＝空いている A・B の hacomono スタッフID）
create table if not exists public.meeting_availability (
  staff_id  uuid not null references public.profiles (id) on delete cascade,
  slot_at   timestamptz not null,
  free_ids  bigint[] not null default '{}',
  synced_at timestamptz not null default now(),
  primary key (staff_id, slot_at)
);
create index if not exists meeting_availability_slot_idx on public.meeting_availability (slot_at);
alter table public.meeting_availability enable row level security;
drop policy if exists "meeting_availability: 管理者は見る" on public.meeting_availability;
create policy "meeting_availability: 管理者は見る" on public.meeting_availability
  for select to authenticated using (public.is_admin());
revoke all on public.meeting_availability from anon, authenticated;
grant select on public.meeting_availability to authenticated;
grant select, insert, update, delete on public.meeting_availability to service_role;

-- 3. 受付時間を hacomono から作っているか
create or replace function public.meeting_from_hacomono()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.meeting_availability);
$$;

-- その :55 を受け付けているか（hacomono から作っているときは、出勤していて空いている人がいるか）
create or replace function public.meeting_slot_open(p_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when public.meeting_from_hacomono() then
    exists (select 1 from public.meeting_availability a join public.staff_settings s on s.staff_id = a.staff_id and s.online_ok where a.slot_at = p_at)
  else
    exists (select 1 from public.meeting_hours where weekday = extract(dow from p_at at time zone 'Asia/Tokyo') and start_time = (p_at at time zone 'Asia/Tokyo')::time)
  end;
$$;

-- 4. その時間に担当できるスタッフ（1時間の枠にオンライン面談がまだない人。hacomono から作っているときは、A・B のどちらかが空いている人）
create or replace function public.meeting_free_staff(p_at timestamptz)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.staff_id
    from public.staff_settings s
    join public.profiles p on p.id = s.staff_id and p.role = 'admin'
   where s.online_ok
     and (not public.meeting_from_hacomono()
          or exists (select 1 from public.meeting_availability a where a.staff_id = s.staff_id and a.slot_at = p_at and cardinality(a.free_ids) > 0))
     and not exists (
       select 1 from public.meetings m
        where m.staff_id = s.staff_id and m.status in ('scheduled', 'done')
          and public.meeting_block(m.scheduled_at) = public.meeting_block(p_at))
   order by (select count(*) from public.meetings m2
              where m2.staff_id = s.staff_id and m2.status in ('scheduled', 'done')
                and (m2.scheduled_at at time zone 'Asia/Tokyo')::date = (p_at at time zone 'Asia/Tokyo')::date), random()
   limit 1;
$$;

-- 5. 予約できる時間の一覧（会員用）
create or replace function public.meeting_slots(p_from date, p_to date)
returns table (slot_at timestamptz, available boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_until date := public.meeting_open_until();
  v_haco boolean := public.meeting_from_hacomono();
  t timestamptz;
begin
  if v_me is null then return; end if;
  if p_to > v_until then p_to := v_until; end if;
  if p_from < public.jst_today() then p_from := public.jst_today(); end if;
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  for t in
    select distinct x.at from (
      select a.slot_at as at
        from public.meeting_availability a join public.staff_settings s on s.staff_id = a.staff_id and s.online_ok
       where v_haco and (a.slot_at at time zone 'Asia/Tokyo')::date between p_from and p_to
      union
      select (d::date + h.start_time) at time zone 'Asia/Tokyo'
        from generate_series(p_from, p_to, interval '1 day') d
        join public.meeting_hours h on h.weekday = extract(dow from d)
       where not v_haco
    ) x order by 1
  loop
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
end;
$$;

-- 6. 予約する（会員）。担当と、hacomono に入れるときのスタッフ（A・B の空いている方）も決める
create or replace function public.book_meeting(p_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_jst timestamp := p_at at time zone 'Asia/Tokyo';
  v_staff uuid;
  v_inst bigint;
  v_id uuid;
begin
  if v_me is null then raise exception 'ログインしてください'; end if;
  if not public.is_member_active(v_me) then raise exception 'いまのプランでは予約できません'; end if;
  if extract(minute from v_jst) <> 55 or extract(second from v_jst) <> 0 then raise exception '予約できない時刻です'; end if;
  if not public.meeting_slot_open(p_at) then raise exception 'この時間は受け付けていません'; end if;
  if p_at < now() + interval '3 hours' then raise exception '予約は3時間前までです。ほかの時間をお選びください'; end if;
  if v_jst::date > public.meeting_open_until() then raise exception 'この日の受付はまだ始まっていません（毎月20日から翌月分を受け付けます）'; end if;
  perform pg_advisory_xact_lock(hashtextextended('meeting:' || public.meeting_block(p_at)::text, 0));
  if exists (select 1 from public.meetings where member_id = v_me and status = 'scheduled' and public.meeting_block(scheduled_at) = public.meeting_block(p_at)) then
    raise exception 'この時間はすでに予約しています';
  end if;
  v_staff := public.meeting_free_staff(p_at);
  if v_staff is null then raise exception 'この時間は満席になりました。ほかの時間をお選びください'; end if;
  select a.free_ids[1] into v_inst from public.meeting_availability a where a.staff_id = v_staff and a.slot_at = p_at;
  insert into public.meetings (member_id, scheduled_at, duration_min, status, pay_type, staff_id, booked_via, hacomono_instructor_id)
  values (v_me, p_at, 20, 'scheduled', 'credit', v_staff, 'app', v_inst)
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

revoke execute on function public.meeting_from_hacomono() from public, anon;
grant execute on function public.meeting_from_hacomono() to authenticated;
revoke execute on function public.meeting_slot_open(timestamptz) from public, anon, authenticated;
revoke execute on function public.meeting_free_staff(timestamptz) from public, anon, authenticated;
revoke execute on function public.meeting_slots(date, date) from public, anon;
grant execute on function public.meeting_slots(date, date) to authenticated;
revoke execute on function public.book_meeting(timestamptz) from public, anon;
grant execute on function public.book_meeting(timestamptz) to authenticated;
