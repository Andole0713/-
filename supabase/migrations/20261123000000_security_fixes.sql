-- セキュリティ・不具合の修正（まとめ）
--   1. 動画提出：会員が「回数に数えない」などの欄を勝手に入れて送れないようにする
--   2. 毎月の権利：同時に開いたときの二重付与を防ぐ（付与の記録 credit_grants を追加）
--   3. 面談の準備メモを、会員から見えない別の表（meeting_prep）に移す
--   4. 動画の保存場所：会員が動画以外・決まった場所以外にファイルを置けないようにする
--   5. is_service_role()：会員が管理者用の処理（全員への付与など）を呼べてしまう問題を直す
--   6. 支払いが一時止まって（past_due）11日以降に戻った会員にも、その月の権利を付与する
--   7. 会員が変更できない項目に、最終利用日時などを追加
--   8. コンシェルジュの連絡：送った日時・送った人を会員が偽れないようにする
--   9. レッスン評価の変更：自分のレッスンにだけ付けられるようにする
--  10. 内部用の関数を、ログインしていない人・会員が直接呼べないようにする
--  11. プランの回数の決まりがない会員は、動画を送れない（すべてのプランに回数あり）
--  12. 日付の判定を日本時間にそろえる
--  14. 自動処理の実行記録（job_runs）
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。
--
-- ===== 事前確認（実行の前に、次の SELECT だけを実行してください） =====
-- 契約中なのにプランが空（または回数の決まりがないプラン）の会員は、この修正のあと動画を送れなくなります。
-- 1件でも出てきたら、先に管理画面でその会員のプランを設定してください。
--
--   select p.id, p.name, p.email, p.plan, p.subscription_status, p.access_until
--     from public.profiles p
--    where p.role <> 'admin'
--      and (p.subscription_status in ('active', 'trialing') or p.access_until >= (now() at time zone 'Asia/Tokyo')::date)
--      and not exists (select 1 from public.plan_quotas q where q.plan = p.plan);
-- =====================================================================

-- =========================================================
-- 5. サービスロール（Edge Function・毎日の自動処理）かどうか
--   以前は current_user で判定していたため、security definer の関数の中（current_user が postgres）では
--   会員からの呼び出しでも「サービスロール」と判定されていた。
--   ・Edge Function（service_role のキー）：auth.role() = 'service_role'
--   ・pg_cron・SQL Editor：データベースに直接つなぐので session_user が postgres / supabase_admin
--   ・アプリ（PostgREST）経由：session_user は authenticator なので、上のどちらにもならない
-- =========================================================
create or replace function public.is_service_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or session_user in ('postgres', 'supabase_admin');
$$;

-- トリガー（変更できる項目の制限）専用：サービスロール、または security definer の関数（専用の手続き）の中からの変更か
--   会員が直接（PostgREST から）更新すると current_user は authenticated になる。
--   会員が呼べる専用の手続き（アカウント削除の申し込み・最終利用日時の記録など）は、決まった項目だけを変更するので通してよい。
--   ※ security definer にしないこと（current_user で判定するため）。権限の確認（だれが呼べるか）には使わないこと。
create or replace function public.is_trusted_writer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_service_role()
      or current_user in ('postgres', 'supabase_admin', 'service_role');
$$;
-- トリガーは会員（authenticated）の権限で動くため、会員も実行できる必要がある（中身は判定だけ）
revoke execute on function public.is_trusted_writer() from public, anon;
grant execute on function public.is_trusted_writer() to authenticated, service_role;

-- =========================================================
-- 7. 会員が自分のプロフィールで変更できる項目の制限（最新版）
--   ・最終利用日時（last_seen_at）：会員が直接変えた場合は、今の日時にする（アプリは touch_last_seen() で記録）
--   ・削除の申し込み日時・解約日時・テーマを書いた日も、会員は直接変更できない
-- =========================================================
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_trusted_writer() then
    new.updated_at := now();
    return new;
  end if;

  if public.is_admin() then
    -- 管理者でも Stripe 関連の項目は変更不可（Webhook と食い違わないように）
    if new.stripe_customer_id  is distinct from old.stripe_customer_id
    or new.subscription_id     is distinct from old.subscription_id
    or new.subscription_status is distinct from old.subscription_status
    or new.current_period_end  is distinct from old.current_period_end then
      raise exception '契約情報は Stripe からのみ更新できます';
    end if;
    -- 自分自身の管理者権限は外せない（管理者不在の事故防止）
    if old.id = auth.uid() and new.role is distinct from old.role then
      raise exception '自分の権限は変更できません';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.id                      is distinct from old.id
  or new.role                    is distinct from old.role
  or new.email                   is distinct from old.email
  or new.plan                    is distinct from old.plan
  or new.goal                    is distinct from old.goal
  or new.best_score              is distinct from old.best_score
  or new.avg_score               is distinct from old.avg_score
  or new.theme                   is distinct from old.theme
  or new.theme_set_on            is distinct from old.theme_set_on
  or new.next_meeting_at         is distinct from old.next_meeting_at
  or new.meeting_reminded_for    is distinct from old.meeting_reminded_for
  or new.access_until            is distinct from old.access_until
  or new.extra_submissions       is distinct from old.extra_submissions
  or new.extra_submissions_month is distinct from old.extra_submissions_month
  or new.stripe_customer_id      is distinct from old.stripe_customer_id
  or new.subscription_id         is distinct from old.subscription_id
  or new.subscription_status     is distinct from old.subscription_status
  or new.current_period_end      is distinct from old.current_period_end
  or new.deletion_requested_at   is distinct from old.deletion_requested_at
  or new.cancel_at               is distinct from old.cancel_at
  or new.created_at              is distinct from old.created_at then
    raise exception '変更できない項目が含まれています';
  end if;
  -- 最終利用日時は、会員が好きな日時を入れられないようにする（変えようとしたら今の日時）
  if new.last_seen_at is distinct from old.last_seen_at then
    new.last_seen_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.guard_profile_account()
returns trigger language plpgsql set search_path = '' as $$
begin
  if public.is_trusted_writer() then return new; end if;
  if new.deletion_requested_at is distinct from old.deletion_requested_at
  or new.cancel_at is distinct from old.cancel_at then
    raise exception '変更できない項目が含まれています';
  end if;
  return new;
end;
$$;

create or replace function public.touch_theme_set_on()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.theme is distinct from old.theme then
    new.theme_set_on := case when coalesce(new.theme, '') = '' then null
                             else (now() at time zone 'Asia/Tokyo')::date end;
  elsif new.theme_set_on is distinct from old.theme_set_on
        and not public.is_admin() and not public.is_trusted_writer() then
    raise exception '変更できない項目が含まれています';
  end if;
  return new;
end;
$$;

create or replace function public.guard_task_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_trusted_writer() or public.is_admin() then
    return new;
  end if;
  if new.id         is distinct from old.id
  or new.member_id  is distinct from old.member_id
  or new.title      is distinct from old.title
  or new.detail     is distinct from old.detail
  or new.sort_order is distinct from old.sort_order
  or new.created_at is distinct from old.created_at then
    raise exception '課題の内容は変更できません';
  end if;
  return new;
end;
$$;

-- =========================================================
-- 12. 日付の判定を日本時間にそろえる（jst_today() は 20261018000000_credits.sql で作成済み）
-- =========================================================
create or replace function public.has_active_subscription()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and (subscription_status in ('active', 'trialing') or access_until >= public.jst_today())
  );
$$;

create or replace function public.log_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_active boolean := false;
  is_active  boolean;
begin
  if new.role = 'admin' then return null; end if;
  if tg_op = 'UPDATE' then
    was_active := old.subscription_status in ('active', 'trialing') or coalesce(old.access_until >= public.jst_today(), false);
  end if;
  is_active := new.subscription_status in ('active', 'trialing') or coalesce(new.access_until >= public.jst_today(), false);
  if was_active is distinct from is_active then
    insert into public.membership_events (member_id, kind) values (new.id, case when is_active then 'start' else 'stop' end);
  end if;
  return null;
end;
$$;

-- =========================================================
-- 1. 動画提出：会員が入れられない欄
--   ・回数に数えない（quota_exempt）・お気に入り・対応日時・取り消し依頼・削除日時・状態・送った日時・対応者は、
--     会員が送るときは必ず初期値にする（トリガー）。提出の条件（RLS）でも確認する
--   ・会員は submissions を直接更新できない（更新は管理者だけ。お気に入り・取り消し依頼は専用の手続き）
-- =========================================================
create or replace function public.submissions_clear_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    new.claimed_by := null;
    new.claimed_at := null;
    if not public.is_service_role() then
      new.quota_exempt        := false;
      new.favorite_at         := null;
      new.reviewed_at         := null;
      new.cancel_requested_at := null;
      new.cancel_reason       := '';
      new.video_deleted_at    := null;
      new.status              := 'pending';
      new.created_at          := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists submissions_clear_claim on public.submissions;
create trigger submissions_clear_claim before insert on public.submissions
  for each row execute function public.submissions_clear_claim();

drop policy if exists "submissions: 契約中の本人は提出可" on public.submissions;
create policy "submissions: 契約中の本人は提出可" on public.submissions
  for insert to authenticated
  with check (
    member_id = auth.uid()
    and split_part(video_path, '/', 1) = auth.uid()::text
    and status = 'pending'
    and video_deleted_at is null
    and not quota_exempt
    and favorite_at is null
    and reviewed_at is null
    and cancel_requested_at is null
    and claimed_by is null
    and public.can_submit_video()
  );

-- =========================================================
-- 2. 毎月の権利の付与の記録（1人・1か月に1行）
--   ・付与するかどうかは、この記録で決める（権利の行を管理者が削除しても、もう一度付与されない）
--   ・同じ会員の付与は、同時に1つずつ（pg_advisory_xact_lock）
--   ・管理画面の「最終付与」は max(granted_at) を表示する
-- =========================================================
create table if not exists public.credit_grants (
  member_id  uuid not null references public.profiles (id) on delete cascade,
  period     date not null,                       -- どの月の分か（その月の1日）
  granted_at timestamptz not null default now(),
  primary key (member_id, period)
);
create index if not exists credit_grants_time_idx on public.credit_grants (granted_at);
alter table public.credit_grants enable row level security;
drop policy if exists "credit_grants: 管理者は閲覧可" on public.credit_grants;
create policy "credit_grants: 管理者は閲覧可" on public.credit_grants
  for select to authenticated using (public.is_admin());
revoke all on public.credit_grants from anon;
revoke insert, update, delete, truncate on public.credit_grants from authenticated;

-- これまでに付与した月を記録しておく（このあと同じ月がもう一度付与されないように）
insert into public.credit_grants (member_id, period, granted_at)
select c.member_id, c.period, min(c.created_at)
  from public.credits c
 where c.source = 'monthly' and c.period is not null
 group by c.member_id, c.period
on conflict (member_id, period) do nothing;

-- 6. 今回の契約の始まり：はじめての開始、または前回の終了から35日より長く空いてからの再開
--    （支払いが一時止まって（past_due）すぐ戻った場合などは、続けて契約しているものとして扱う）
create or replace function public.membership_fresh_start(p_member uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(s.created_at)
    from public.membership_events s
   where s.member_id = p_member and s.kind = 'start'
     and (
       not exists (
         select 1 from public.membership_events b
          where b.member_id = p_member and b.kind = 'start'
            and (b.created_at, b.id) < (s.created_at, s.id))
       or coalesce((
         select max(t.created_at) from public.membership_events t
          where t.member_id = p_member and t.kind = 'stop'
            and (t.created_at, t.id) < (s.created_at, s.id)) < s.created_at - interval '35 days', false)
     );
$$;

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

  -- 初回無料オンライン面談（サブスクリプション制で、はじめて契約したときに1回だけ）
  if v_plan <> 'YOUCAN' and not exists (select 1 from public.credits where member_id = p_member and source = 'first_free') then
    perform public.add_credits(p_member, 'meeting', 1, 'first_free', '初回無料オンライン面談', null);
    added := added + 1;
  end if;

  -- 今月の分をすでに付与した（付与の記録がある）
  if exists (select 1 from public.credit_grants where member_id = p_member and period = m) then
    return added;
  end if;

  v_start := public.membership_fresh_start(p_member);

  -- 12か月上達プログラム：今回の契約を始めてから、毎月の付与は12回まで（13か月目は付与しない）
  if v_plan = 'YOUCAN' then
    if (select count(*) from public.credit_grants g
         where g.member_id = p_member
           and g.period >= date_trunc('month', coalesce(v_start, v_created) at time zone 'Asia/Tokyo')::date) >= 12 then
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

-- 管理者：今月分を手動で付与（11日以降に契約した人など）。付与済みかどうかは付与の記録で判定
create or replace function public.admin_grant_month(p_member uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '権限がありません'; end if;
  if exists (select 1 from public.credit_grants where member_id = p_member and period = date_trunc('month', public.jst_today())::date) then
    raise exception '今月の分はすでに付与されています（追加する場合は「権利を追加」を使ってください）';
  end if;
  return public.grant_monthly_for(p_member, true);
end;
$$;

-- 契約中の全員に今月の権利を付与する（毎日の自動処理・管理画面から呼ぶ。会員は呼べない）
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

-- =========================================================
-- 11. 動画を送れるかどうか：回数の決まりがないプラン（プラン未設定など）は送れない
-- =========================================================
create or replace function public.can_submit_video()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then return false; end if;
  if not public.is_member_active(auth.uid()) then return false; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and deletion_requested_at is not null) then return false; end if;
  if not public.has_quota_plan(auth.uid()) then return false; end if;
  perform public.grant_monthly_for(auth.uid(), false);
  return public.available_credits(auth.uid(), 'video') > 0;
end;
$$;

-- =========================================================
-- 3. 面談の準備メモ（スタッフだけが見られる別の表）
-- =========================================================
create table if not exists public.meeting_prep (
  meeting_id uuid primary key references public.meetings (id) on delete cascade,
  memo       text not null default '' check (char_length(memo) <= 4000),
  updated_at timestamptz not null default now()
);
alter table public.meeting_prep enable row level security;
drop policy if exists "meeting_prep: 管理者のみ" on public.meeting_prep;
create policy "meeting_prep: 管理者のみ" on public.meeting_prep
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.meeting_prep from anon;
drop trigger if exists meeting_prep_touch on public.meeting_prep;
create trigger meeting_prep_touch before update on public.meeting_prep
  for each row execute function public.touch_meeting();

-- これまでのメモを移してから、会員にも見える meetings の列を削除する
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'meetings' and column_name = 'prep_memo') then
    execute $q$
      insert into public.meeting_prep (meeting_id, memo, updated_at)
      select id, prep_memo, coalesce(updated_at, now()) from public.meetings where coalesce(prep_memo, '') <> ''
      on conflict (meeting_id) do nothing
    $q$;
    execute 'alter table public.meetings drop column prep_memo';
  end if;
end $$;

-- =========================================================
-- 4. 動画の保存場所（swing-videos）
--   ・会員がアップロードできるのは「自分のID/ファイル名.動画の拡張子」だけ（フォルダの中にフォルダは作れない）
--     アプリは「会員ID/時刻-ランダム.拡張子」で保存する（拡張子は選んだファイルのもの。SwingFrame は mp4）
--   ・動画（video/*）以外は置けない。1本 2GB まで（スマホのスイング動画は通常 数MB〜数百MB）
--   ・どの提出にも使われていないファイルは、purge-old-videos が24時間後に削除する
-- =========================================================
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute $q$update storage.buckets
                  set file_size_limit = 2147483648,
                      allowed_mime_types = array['video/*']
                where id = 'swing-videos'$q$;
  else
    raise notice 'storage.buckets に容量・種類の設定の列がないため、Storage の画面で swing-videos の設定をしてください';
  end if;
end $$;

drop policy if exists "swing-videos: 本人がアップロード" on storage.objects;
create policy "swing-videos: 本人がアップロード" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and name ~* ('^' || auth.uid()::text || '/[a-z0-9_-][a-z0-9._-]{0,110}\.(mp4|mov|m4v|webm|3gp|3g2|qt|mkv|avi)$')
    and public.can_submit_video()
  );

-- =========================================================
-- 8. コンシェルジュの連絡：会員が送るときは、送った日時＝今・送った人＝本人
--   （名前の順でトリガーが動くため、1日20件の確認 concierge_limit より先に動く）
-- =========================================================
create or replace function public.concierge_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not public.is_admin() and not public.is_service_role() then
    new.created_at := now();
    new.sender_id  := auth.uid();
    new.from_staff := false;
    new.read_at    := null;
  end if;
  return new;
end;
$$;
drop trigger if exists concierge_guard_insert on public.concierge_messages;
create trigger concierge_guard_insert before insert on public.concierge_messages
  for each row execute function public.concierge_stamp();

-- =========================================================
-- 9. レッスンの評価の変更：自分のレッスンにだけ
-- =========================================================
drop policy if exists "lesson_ratings: 本人が変更" on public.lesson_ratings;
create policy "lesson_ratings: 本人が変更" on public.lesson_ratings
  for update to authenticated
  using (member_id = auth.uid())
  with check (
    member_id = auth.uid()
    and exists (select 1 from public.lessons l where l.id = lesson_id and l.member_id = auth.uid())
  );

-- =========================================================
-- 14. 自動処理の実行記録（purge-old-videos など。管理画面に表示する）
-- =========================================================
create table if not exists public.job_runs (
  id     bigserial primary key,
  job    text not null,
  ran_at timestamptz not null default now(),
  ok     boolean not null,
  detail text
);
create index if not exists job_runs_job_idx on public.job_runs (job, ran_at desc);
alter table public.job_runs enable row level security;
drop policy if exists "job_runs: 管理者は閲覧可" on public.job_runs;
create policy "job_runs: 管理者は閲覧可" on public.job_runs
  for select to authenticated using (public.is_admin());
revoke all on public.job_runs from anon;
revoke insert, update, delete, truncate on public.job_runs from authenticated;
grant select, insert on public.job_runs to service_role;
grant usage on sequence public.job_runs_id_seq to service_role;

-- =========================================================
-- 10. 内部用の関数を、ログインしていない人・会員が直接呼べないようにする
--   （アプリからは呼んでいない。動画を送れるか・権利の付与などの中から、管理者の権限で呼ばれる）
-- =========================================================
revoke execute on function public.available_credits(uuid, text) from public, anon, authenticated;
revoke execute on function public.is_member_active(uuid) from public, anon, authenticated;
revoke execute on function public.has_quota_plan(uuid) from public, anon, authenticated;
revoke execute on function public.membership_fresh_start(uuid) from public, anon, authenticated;
grant execute on function public.available_credits(uuid, text) to service_role;
grant execute on function public.is_member_active(uuid) to service_role;
grant execute on function public.has_quota_plan(uuid) to service_role;
grant execute on function public.membership_fresh_start(uuid) to service_role;

-- 会員用の手続き：ログインしていない人からは呼べないように（会員は今までどおり呼べる）
revoke execute on function public.set_submission_favorite(uuid, boolean) from public, anon;
grant execute on function public.set_submission_favorite(uuid, boolean) to authenticated;

-- 作り直した関数の権限（念のため、もう一度そろえる）
revoke execute on function public.grant_monthly_for(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.grant_monthly_credits() from public, anon;
grant execute on function public.grant_monthly_credits() to authenticated, service_role;
revoke execute on function public.admin_grant_month(uuid) from public, anon;
grant execute on function public.admin_grant_month(uuid) to authenticated;
revoke execute on function public.can_submit_video() from public, anon;
grant execute on function public.can_submit_video() to authenticated, service_role;
revoke execute on function public.has_active_subscription() from public, anon;
grant execute on function public.has_active_subscription() to authenticated, service_role;
