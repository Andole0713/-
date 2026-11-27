-- 料金表（案）に合わせたプランの追加：6か月・9か月上達プログラム（UCANシステム）
--   ・会員のプランに YOUCAN6（6か月）・YOUCAN9（9か月）を設定できるようにする
--   ・毎月の回数：動画1回・ミーティング0回（12か月と同じ）。毎月の付与は契約の月数まで
--   ・月額のプラン（ライト・バランス・プレミアム）の回数は今のまま（UME 1/1・TAKE 2/1・MATSU 2/2）
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check
  check (plan in ('SUBSCRIPTION', 'YOUCAN', 'YOUCAN6', 'YOUCAN9', 'UME', 'TAKE', 'MATSU', 'KIWAMI'));

insert into public.plan_quotas (plan, video, meeting) values ('YOUCAN6', 1, 0), ('YOUCAN9', 1, 0)
on conflict (plan) do nothing;

create or replace function public.grant_monthly_for(p_member uuid, p_force boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m date;
  v_video int;
  v_meeting int;
  v_plan text;
  v_created timestamptz;
  v_start timestamptz;
  v_rows int;
  added int := 0;
  v_limit int;
begin
  if p_member is null then return 0; end if;
  -- 同じ会員の付与は同時に1つずつ（ページを開いたとき・動画を送るとき・毎日の自動処理が重なっても二重にならない）
  perform pg_advisory_xact_lock(hashtextextended(p_member::text, 0));
  m := date_trunc('month', public.jst_today())::date;

  if not public.is_member_active(p_member) then return 0; end if;
  select pq.video, pq.meeting, p.plan, p.created_at into v_video, v_meeting, v_plan, v_created
    from public.profiles p join public.plan_quotas pq on pq.plan = p.plan
   where p.id = p_member;
  if v_plan is null then return 0; end if;   -- 回数の決まりがないプラン

  -- 初回無料オンライン面談（サブスクシステムで、はじめて契約したときに1回だけ。UCAN の6・9・12か月は対象外）
  if v_plan not in ('YOUCAN', 'YOUCAN6', 'YOUCAN9') and not exists (select 1 from public.credits where member_id = p_member and source = 'first_free') then
    perform public.add_credits(p_member, 'meeting', 1, 'first_free', '初回無料オンライン面談', null);
    added := added + 1;
  end if;

  -- 今月の分をすでに付与した（付与の記録がある）
  if exists (select 1 from public.credit_grants where member_id = p_member and period = m) then
    return added;
  end if;

  v_start := public.membership_fresh_start(p_member);

  -- 6・9・12か月上達プログラム：今回の契約を始めてから、毎月の付与は契約の月数まで（その次の月は付与しない）
  if v_plan in ('YOUCAN', 'YOUCAN6', 'YOUCAN9') then
    v_limit := case v_plan when 'YOUCAN6' then 6 when 'YOUCAN9' then 9 else 12 end;
    if (select count(*) from public.credit_grants g
         where g.member_id = p_member
           and g.period >= date_trunc('month', coalesce(v_start, v_created) at time zone 'Asia/Tokyo')::date) >= v_limit then
      return added;
    end if;
  end if;

  -- 今月の11日以降に契約を始めた場合、今月の分は自動では付与しない
  --   （はじめての契約、または35日より長く空いてからの再開のときだけ。支払いの一時的な停止からの復帰は対象外）
  if v_start is not null
     and (v_start at time zone 'Asia/Tokyo')::date >= m
     and extract(day from (v_start at time zone 'Asia/Tokyo')) >= 11
     and not p_force then
    return added;
  end if;

  -- 動画も面談も0回のプランは何も付与しない（記録も残さず、次回も確認するだけ）
  if coalesce(v_video, 0) + coalesce(v_meeting, 0) <= 0 then return added; end if;

  insert into public.credit_grants (member_id, period) values (p_member, m)
  on conflict (member_id, period) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return added; end if;

  perform public.add_credits(p_member, 'video', v_video, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  perform public.add_credits(p_member, 'meeting', v_meeting, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  return added + v_video + v_meeting;
end;
$$;
