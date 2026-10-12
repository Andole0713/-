-- 動画提出・面談の「権利（回数）」
--   ・プランを契約していると、毎月1日に（その月の初めの利用時にも念のため）プランごとの回数を付与する
--   ・月の途中で契約した場合：10日までなら、その月の分も自動で付与。11日以降は、その月は自動で付与しない（スタッフが手動で付与できる）
--   ・初めて契約したときに「初回無料オンライン面談」の権利を1回付与する
--   ・権利は、付与された月から半年後の月末まで有効（例：10月に付与 → 翌年4月30日まで）。過ぎると使えなくなる
--   ・使うときは、期限が近いものから使う
--   ・動画：送ったときに使う。削除・「回数に数えない」で戻る
--   ・面談：「権利を使う」で予約したときに使う。キャンセルで戻る（欠席は戻らない）
-- 何度実行しても問題ありません。

-- =========================================================
-- プラン（仮：梅・竹・松）と、毎月の回数
-- =========================================================
alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check
  check (plan in ('SUBSCRIPTION', 'YOUCAN', 'UME', 'TAKE', 'MATSU'));

create table if not exists public.plan_quotas (
  plan    text primary key,
  video   smallint not null default 0 check (video between 0 and 20),
  meeting smallint not null default 0 check (meeting between 0 and 10)
);
insert into public.plan_quotas (plan, video, meeting) values
  ('UME', 1, 0), ('TAKE', 2, 0), ('MATSU', 2, 1),
  ('SUBSCRIPTION', 2, 1)   -- これまでのサブスクリプション制（松と同じ内容）
on conflict (plan) do nothing;

alter table public.plan_quotas enable row level security;
drop policy if exists "plan_quotas: だれでも閲覧可" on public.plan_quotas;
create policy "plan_quotas: だれでも閲覧可" on public.plan_quotas for select to authenticated using (true);
drop policy if exists "plan_quotas: 管理者が変更" on public.plan_quotas;
create policy "plan_quotas: 管理者が変更" on public.plan_quotas
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =========================================================
-- 権利（1回分＝1行）
-- =========================================================
create table if not exists public.credits (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('video', 'meeting')),
  source        text not null check (source in ('monthly', 'first_free', 'purchase', 'manual')),
  period        date,                              -- 毎月の付与：どの月の分か（その月の1日）
  granted_on    date not null,
  expires_on    date not null,
  note          text not null default '' check (char_length(note) <= 200),
  used_at       timestamptz,
  used_ref_type text check (used_ref_type in ('submission', 'meeting')),
  used_ref_id   uuid,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists credits_member_idx on public.credits (member_id, kind, expires_on) where used_at is null;
create index if not exists credits_ref_idx on public.credits (used_ref_type, used_ref_id);
create index if not exists credits_period_idx on public.credits (member_id, source, period);

alter table public.credits enable row level security;
drop policy if exists "credits: 本人と管理者は閲覧可" on public.credits;
create policy "credits: 本人と管理者は閲覧可" on public.credits
  for select to authenticated using (member_id = auth.uid() or public.is_admin());
drop policy if exists "credits: 管理者が削除" on public.credits;
create policy "credits: 管理者が削除" on public.credits
  for delete to authenticated using (public.is_admin() and used_at is null);
revoke all on public.credits, public.plan_quotas from anon;

-- 面談の支払い方法：credit＝権利を使う／paid＝都度払い（支払い済み）／unpaid＝都度払い（未払い）／free＝無料（サービス）／none＝記録なし（これまでの面談）
alter table public.meetings add column if not exists pay_type text not null default 'none';
alter table public.meetings drop constraint if exists meetings_pay_type_check;
alter table public.meetings add constraint meetings_pay_type_check check (pay_type in ('credit', 'paid', 'unpaid', 'free', 'none'));
alter table public.meetings alter column pay_type set default 'credit';

-- =========================================================
-- 共通の計算
-- =========================================================
create or replace function public.jst_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;

-- 付与された月から半年後の月末
create or replace function public.credit_expiry(p_granted date)
returns date language sql immutable set search_path = '' as $$
  select (date_trunc('month', p_granted) + interval '7 months' - interval '1 day')::date;
$$;

create or replace function public.is_member_active(p_member uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_member and p.role <> 'admin'
      and (p.subscription_status in ('active', 'trialing') or p.access_until >= public.jst_today())
  );
$$;

-- 使える権利の数
create or replace function public.available_credits(p_member uuid, p_kind text)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.credits
  where member_id = p_member and kind = p_kind and used_at is null and expires_on >= public.jst_today();
$$;

-- 権利をまとめて付与する（内部用）
create or replace function public.add_credits(p_member uuid, p_kind text, p_count int, p_source text, p_note text, p_period date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  d date := public.jst_today();
begin
  if p_count is null or p_count <= 0 then return; end if;
  insert into public.credits (member_id, kind, source, period, granted_on, expires_on, note, created_by)
  select p_member, p_kind, p_source, p_period, d, public.credit_expiry(d), coalesce(p_note, ''), auth.uid()
  from generate_series(1, p_count);
end;
$$;

-- 1人分の「今月の権利」を付与する（まだ付与していなければ）
--   p_force = true のときは、11日以降に契約した月でも付与する（スタッフの手動付与）
create or replace function public.grant_monthly_for(p_member uuid, p_force boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m date := date_trunc('month', public.jst_today())::date;
  q record;
  late_start boolean;
  added int := 0;
begin
  if not public.is_member_active(p_member) then return 0; end if;
  select pq.video, pq.meeting into q
    from public.profiles p join public.plan_quotas pq on pq.plan = p.plan
   where p.id = p_member;
  if not found then return 0; end if;   -- 回数の決まりがないプラン（ユーキャン制など）

  -- 初回無料オンライン面談（はじめて契約したときに1回だけ）
  if not exists (select 1 from public.credits where member_id = p_member and source = 'first_free') then
    perform public.add_credits(p_member, 'meeting', 1, 'first_free', '初回無料オンライン面談', null);
    added := added + 1;
  end if;

  if exists (select 1 from public.credits where member_id = p_member and source = 'monthly' and period = m) then
    return added;
  end if;

  -- 今月の11日以降に契約を始めた場合、今月の分は自動では付与しない
  select exists (
    select 1 from public.membership_events e
    where e.member_id = p_member and e.kind = 'start'
      and (e.created_at at time zone 'Asia/Tokyo')::date >= m
      and extract(day from (e.created_at at time zone 'Asia/Tokyo')) >= 11
  ) into late_start;
  if late_start and not p_force then return added; end if;

  perform public.add_credits(p_member, 'video', q.video, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  perform public.add_credits(p_member, 'meeting', q.meeting, 'monthly', to_char(m, 'YYYY年FMMM月分'), m);
  -- 動画も面談も0回のプランでも「付与済み」と分かるように、0回のときは何も入れない（次回も確認するだけ）
  return added + q.video + q.meeting;
end;
$$;

-- 契約中の全員に今月の権利を付与する（毎日の自動処理・管理画面から呼ぶ）
create or replace function public.grant_monthly_credits()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  total int := 0;
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception '権限がありません';
  end if;
  for r in select p.id from public.profiles p join public.plan_quotas pq on pq.plan = p.plan loop
    total := total + public.grant_monthly_for(r.id, false);
  end loop;
  return total;
end;
$$;

-- 会員が自分の今月の権利を受け取る（ページを開いたときに念のため呼ぶ）
create or replace function public.ensure_my_credits()
returns integer language sql security definer set search_path = '' as $$
  select public.grant_monthly_for(auth.uid(), false);
$$;

-- 管理者：今月分を手動で付与（11日以降に契約した人など）
create or replace function public.admin_grant_month(p_member uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '権限がありません'; end if;
  if exists (select 1 from public.credits where member_id = p_member and source = 'monthly' and period = date_trunc('month', public.jst_today())::date) then
    raise exception '今月の分はすでに付与されています';
  end if;
  return public.grant_monthly_for(p_member, true);
end;
$$;

-- 管理者：権利を追加（都度購入・お詫びなど）
create or replace function public.admin_add_credits(p_member uuid, p_kind text, p_count int, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '権限がありません'; end if;
  if p_count < 1 or p_count > 20 then raise exception '回数は1〜20で指定してください'; end if;
  perform public.add_credits(p_member, p_kind, p_count, 'purchase', p_note, null);
end;
$$;

-- 権利を1回使う（期限が近いものから）
create or replace function public.use_credit(p_member uuid, p_kind text, p_ref_type text, p_ref_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  cid uuid;
begin
  select id into cid from public.credits
   where member_id = p_member and kind = p_kind and used_at is null and expires_on >= public.jst_today()
   order by expires_on, granted_on, created_at
   limit 1 for update skip locked;
  if cid is null then
    raise exception using message = case p_kind when 'video' then '動画を送る権利が残っていません' else '面談の権利が残っていません。都度払いを選んでください' end;
  end if;
  update public.credits set used_at = now(), used_ref_type = p_ref_type, used_ref_id = p_ref_id where id = cid;
  return cid;
end;
$$;

-- 使った権利を戻す
create or replace function public.release_credit(p_ref_type text, p_ref_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.credits set used_at = null, used_ref_type = null, used_ref_id = null
   where used_ref_type = p_ref_type and used_ref_id = p_ref_id;
$$;

-- 回数の決まりがあるプランかどうか
create or replace function public.has_quota_plan(p_member uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p join public.plan_quotas pq on pq.plan = p.plan where p.id = p_member);
$$;

-- =========================================================
-- 動画を送れるかどうか（今月の権利をまだ受け取っていなければ、先に受け取る）
-- =========================================================
create or replace function public.can_submit_video()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_member_active(auth.uid()) then return false; end if;
  if not public.has_quota_plan(auth.uid()) then return true; end if;   -- ユーキャン制など
  perform public.grant_monthly_for(auth.uid(), false);
  return public.available_credits(auth.uid(), 'video') > 0;
end;
$$;

-- =========================================================
-- 自動で権利を使う・戻す
-- =========================================================
create or replace function public.credits_on_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if public.has_quota_plan(new.member_id) and not new.quota_exempt then
      perform public.use_credit(new.member_id, 'video', 'submission', new.id);
    end if;
    return null;
  elsif tg_op = 'DELETE' then
    perform public.release_credit('submission', old.id);
    return null;
  else
    if new.quota_exempt and not old.quota_exempt then
      perform public.release_credit('submission', new.id);
    elsif old.quota_exempt and not new.quota_exempt and public.has_quota_plan(new.member_id) then
      perform public.use_credit(new.member_id, 'video', 'submission', new.id);
    end if;
    return null;
  end if;
end;
$$;

drop trigger if exists submissions_credits on public.submissions;
create trigger submissions_credits after insert or delete or update of quota_exempt on public.submissions
  for each row execute function public.credits_on_submission();

create or replace function public.credits_on_meeting()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  had boolean := false;
  hold boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then had := old.pay_type = 'credit' and old.status <> 'canceled'; end if;
  if tg_op in ('INSERT', 'UPDATE') then hold := new.pay_type = 'credit' and new.status <> 'canceled'; end if;
  if had and not hold then perform public.release_credit('meeting', old.id); end if;
  if hold and not had then perform public.use_credit(new.member_id, 'meeting', 'meeting', new.id); end if;
  return null;
end;
$$;

drop trigger if exists meetings_credits on public.meetings;
create trigger meetings_credits after insert or delete or update of status, pay_type on public.meetings
  for each row execute function public.credits_on_meeting();

-- 内部用の関数は、会員が直接呼べないようにする
revoke execute on function public.add_credits(uuid, text, int, text, text, date) from public, anon, authenticated;
revoke execute on function public.use_credit(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.release_credit(text, uuid) from public, anon, authenticated;
revoke execute on function public.grant_monthly_for(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.grant_monthly_credits() from public, anon;
grant execute on function public.grant_monthly_credits() to authenticated, service_role;
revoke execute on function public.ensure_my_credits() from public, anon;
grant execute on function public.ensure_my_credits() to authenticated;
revoke execute on function public.admin_grant_month(uuid) from public, anon;
grant execute on function public.admin_grant_month(uuid) to authenticated;
revoke execute on function public.admin_add_credits(uuid, text, int, text) from public, anon;
grant execute on function public.admin_add_credits(uuid, text, int, text) to authenticated;
revoke execute on function public.can_submit_video() from public, anon;
grant execute on function public.can_submit_video() to authenticated, service_role;

-- =========================================================
-- これまでの会員の引き継ぎ（初回だけ）
--   ・契約中の会員に今月の分を付与し、今月すでに送った動画の分を使ったことにする
--   ・「今月の追加本数」は、追加の権利（都度購入）として付与する
--   ・すでに契約中の会員には「初回無料オンライン面談」は付与しない（新しく契約する人から）
-- =========================================================
do $$
declare
  r record;
  s record;
  m date := date_trunc('month', public.jst_today())::date;
begin
  if exists (select 1 from public.credits) then return; end if;
  for r in select p.id, p.extra_submissions, p.extra_submissions_month from public.profiles p
           join public.plan_quotas pq on pq.plan = p.plan
           where public.is_member_active(p.id) loop
    insert into public.credits (member_id, kind, source, period, granted_on, expires_on, note, created_by)
      values (r.id, 'meeting', 'first_free', null, public.jst_today(), public.jst_today() - 1, '（既存会員のため対象外）', null);
    perform public.grant_monthly_for(r.id, true);
    if r.extra_submissions_month = m and r.extra_submissions > 0 then
      perform public.add_credits(r.id, 'video', r.extra_submissions, 'purchase', '今月の追加本数から引き継ぎ', null);
    end if;
    for s in select id from public.submissions
             where member_id = r.id and not quota_exempt
               and created_at >= (m::timestamp at time zone 'Asia/Tokyo') order by created_at loop
      begin
        perform public.use_credit(r.id, 'video', 'submission', s.id);
      exception when others then null;
      end;
    end loop;
  end loop;
end $$;

-- 引き継ぎ用に作った「対象外」の行は使えない（期限切れ）ので残しておく（初回無料を二重に付与しないため）

-- =========================================================
-- 毎日 0:05（日本時間）に、今月の権利をまとめて付与する
--   Supabase の「Database → Extensions」で pg_cron を有効にしてから、このファイルをもう一度実行してください。
--   有効でない場合も、会員がページを開いたとき・動画を送るとき・管理画面を開いたときに付与されます。
-- =========================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('grant-monthly-credits');
    exception when others then null;
    end;
    perform cron.schedule('grant-monthly-credits', '5 15 * * *', 'select public.grant_monthly_credits()');
  else
    raise notice 'pg_cron が有効ではないため、自動の付与は設定していません（ページを開いたときに付与されます）';
  end if;
end $$;
