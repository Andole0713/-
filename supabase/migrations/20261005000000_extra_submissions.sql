-- 動画提出の本数制限と、追加本数（LINE で申し込み → コーチが許可）
-- サブスクリプション制は毎月2本まで。3本目以降は、コーチが会員詳細の「今月の追加本数」を増やすと送れるようになります。
-- すでに初期設定を実行したデータベースでは、このファイルを SQL Editor で実行してください。何度実行しても問題ありません。

-- 追加本数と、その追加が有効な月（月が変わると自動で 0 本扱い）
alter table public.profiles add column if not exists extra_submissions integer not null default 0;
alter table public.profiles add column if not exists extra_submissions_month date;
alter table public.profiles drop constraint if exists profiles_extra_submissions_check;
alter table public.profiles add constraint profiles_extra_submissions_check check (extra_submissions between 0 and 20);

-- 今月まだ動画を送れるかどうか（月の区切りは日本時間）
-- 毎月の本数（2本）は app/config.js の monthly.submissions と合わせてください。
create or replace function public.can_submit_video()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (p.subscription_status in ('active', 'trialing') or p.access_until >= current_date)
      and (
        p.plan is distinct from 'SUBSCRIPTION'
        or (
          select count(*) from public.submissions s
          where s.member_id = p.id
            and s.created_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')
        ) < 2 + case
              when p.extra_submissions_month = date_trunc('month', now() at time zone 'Asia/Tokyo')::date
              then p.extra_submissions else 0 end
      )
  );
$$;

revoke execute on function public.can_submit_video() from anon, public;
grant execute on function public.can_submit_video() to authenticated, service_role;

-- 提出とアップロードの条件を「契約中」から「契約中かつ今月の本数が残っている」に変更
drop policy if exists "submissions: 契約中の本人は提出可" on public.submissions;
create policy "submissions: 契約中の本人は提出可" on public.submissions
  for insert to authenticated
  with check (
    member_id = auth.uid()
    and split_part(video_path, '/', 1) = auth.uid()::text
    and status = 'pending'
    and video_deleted_at is null
    and public.can_submit_video()
  );

drop policy if exists "swing-videos: 本人がアップロード" on storage.objects;
create policy "swing-videos: 本人がアップロード" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_submit_video()
  );

-- 追加本数は会員本人が変更できないようにする
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_service_role() then
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

  -- 一般会員：名前・Myクラブセッティングのみ変更可
  if new.id                      is distinct from old.id
  or new.role                    is distinct from old.role
  or new.email                   is distinct from old.email
  or new.plan                    is distinct from old.plan
  or new.goal                    is distinct from old.goal
  or new.best_score              is distinct from old.best_score
  or new.avg_score               is distinct from old.avg_score
  or new.theme                   is distinct from old.theme
  or new.next_meeting_at         is distinct from old.next_meeting_at
  or new.access_until            is distinct from old.access_until
  or new.extra_submissions       is distinct from old.extra_submissions
  or new.extra_submissions_month is distinct from old.extra_submissions_month
  or new.stripe_customer_id      is distinct from old.stripe_customer_id
  or new.subscription_id         is distinct from old.subscription_id
  or new.subscription_status     is distinct from old.subscription_status
  or new.current_period_end      is distinct from old.current_period_end
  or new.created_at              is distinct from old.created_at then
    raise exception '変更できない項目が含まれています';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
