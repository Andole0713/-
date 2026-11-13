-- 権利（動画・面談の回数）の持ち越しを1か月にする
--   ・付与された月の翌月末まで有効（例：11月に付与 → 12月31日まで）
--   ・12か月上達プログラムも回数の管理に入れる（毎月 動画1回。面談はオプションなので0回）
--     毎月の付与は12回まで。12か月目の分は13か月目の月末まで使える
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- 1. 有効期限：付与された月の翌月末
create or replace function public.credit_expiry(p_granted date)
returns date language sql immutable set search_path = '' as $$
  select (date_trunc('month', p_granted) + interval '2 months' - interval '1 day')::date;
$$;

-- 2. 12か月上達プログラムの毎月の回数
insert into public.plan_quotas (plan, video, meeting) values ('YOUCAN', 1, 0)
on conflict (plan) do nothing;

-- 3. 毎月の付与（12か月上達プログラムは12回まで・初回無料面談はサブスクリプション制だけ）
create or replace function public.grant_monthly_for(p_member uuid, p_force boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m date := date_trunc('month', public.jst_today())::date;
  v_video int;
  v_meeting int;
  v_plan text;
  v_created timestamptz;
  v_start timestamptz;
  late_start boolean;
  added int := 0;
begin
  if not public.is_member_active(p_member) then return 0; end if;
  select pq.video, pq.meeting, p.plan, p.created_at into v_video, v_meeting, v_plan, v_created
    from public.profiles p join public.plan_quotas pq on pq.plan = p.plan
   where p.id = p_member;
  if v_plan is null then return 0; end if;   -- 回数の決まりがないプラン

  -- 初回無料オンライン面談（サブスクリプション制で、はじめて契約したときに1回だけ）
  if v_plan <> 'YOUCAN' and not exists (select 1 from public.credits where member_id = p_member and source = 'first_free') then
    perform public.add_credits(p_member, 'meeting', 1, 'first_free', '初回無料オンライン面談', null);
    added := added + 1;
  end if;

  if exists (select 1 from public.credits where member_id = p_member and source = 'monthly' and period = m) then
    return added;
  end if;

  -- 12か月上達プログラム：今回の契約を始めてから、毎月の付与は12回まで（13か月目は付与しない）
  if v_plan = 'YOUCAN' then
    select coalesce(max(e.created_at), v_created) into v_start
      from public.membership_events e where e.member_id = p_member and e.kind = 'start';
    if (select count(distinct c.period) from public.credits c
         where c.member_id = p_member and c.source = 'monthly'
           and c.period >= date_trunc('month', v_start at time zone 'Asia/Tokyo')::date) >= 12 then
      return added;
    end if;
  end if;

  -- 今月の11日以降に契約を始めた場合、今月の分は自動では付与しない
  select exists (
    select 1 from public.membership_events e
    where e.member_id = p_member and e.kind = 'start'
      and (e.created_at at time zone 'Asia/Tokyo')::date >= m
      and extract(day from (e.created_at at time zone 'Asia/Tokyo')) >= 11
  ) into late_start;
  if late_start and not p_force then return added; end if;

  perform public.add_credits(p_member, 'video', v_video, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  perform public.add_credits(p_member, 'meeting', v_meeting, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  return added + v_video + v_meeting;
end;
$$;

-- 4. すでに付与済みで、まだ使っていない権利の期限も、新しい決まり（翌月末）にそろえる
--    ※ すでに半年の期限をご案内しているお客様がいる場合は、この1文は実行しないでください
update public.credits set expires_on = public.credit_expiry(granted_on)
 where used_at is null and expires_on > public.credit_expiry(granted_on);
