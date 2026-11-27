-- hacomono との自動連携（API・Webhook）の準備
--   ・hacomono_links：アプリの会員と hacomono の会員の結びつき（メールアドレスで自動、またはスタッフが手動で結ぶ）
--   ・hacomono_plan_map：hacomono のプランと、アプリのプランの対応（スタッフが設定画面で決める）
--   ・hacomono_events：hacomono から届いた知らせ（Webhook）の記録。同じ知らせを二重に処理しないためにも使う
-- アプリのプランと利用できる期限（profiles.plan / access_until）は、サーバーの処理（hacomono-sync・hacomono-webhook）が書き換える
-- Supabase の SQL Editor でこのファイルの中身を実行してください（何度実行しても大丈夫です）。

-- =========================================================
-- 会員の結びつき
-- =========================================================
create table if not exists public.hacomono_links (
  member_id          uuid primary key references public.profiles (id) on delete cascade,
  hacomono_member_id bigint not null unique,
  linked_by          text not null default 'email' check (linked_by in ('email', 'staff')),
  linked_at          timestamptz not null default now(),
  synced_at          timestamptz,
  status             text not null default 'linked' check (status in ('linked', 'active', 'ended', 'none', 'error')),
  detail             text not null default '' check (char_length(detail) <= 500)
);
alter table public.hacomono_links enable row level security;
drop policy if exists "hacomono_links: 管理者" on public.hacomono_links;
create policy "hacomono_links: 管理者" on public.hacomono_links
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.hacomono_links from anon;
grant select, insert, update, delete on public.hacomono_links to authenticated, service_role;

-- =========================================================
-- プランの対応
-- =========================================================
create table if not exists public.hacomono_plan_map (
  hacomono_plan_id   bigint primary key,
  hacomono_plan_name text not null default '' check (char_length(hacomono_plan_name) <= 200),
  app_plan           text not null check (app_plan in ('UME', 'TAKE', 'MATSU', 'KIWAMI', 'YOUCAN', 'YOUCAN6', 'YOUCAN9')),
  months             smallint check (months between 1 and 36),   -- 期間のプラン（UCAN）は月数。月額のプランは空
  updated_at         timestamptz not null default now()
);
alter table public.hacomono_plan_map enable row level security;
drop policy if exists "hacomono_plan_map: 管理者" on public.hacomono_plan_map;
create policy "hacomono_plan_map: 管理者" on public.hacomono_plan_map
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.hacomono_plan_map from anon;
grant select, insert, update, delete on public.hacomono_plan_map to authenticated, service_role;

-- =========================================================
-- 届いた知らせ（Webhook）
-- =========================================================
create table if not exists public.hacomono_events (
  id                 bigint primary key,           -- hacomono の知らせの ID（同じ知らせは1回だけ処理する）
  type               text not null default '',
  hacomono_member_id bigint,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  result             text not null default '' check (char_length(result) <= 500)
);
create index if not exists hacomono_events_received_idx on public.hacomono_events (received_at desc);
alter table public.hacomono_events enable row level security;
drop policy if exists "hacomono_events: 管理者は閲覧可" on public.hacomono_events;
create policy "hacomono_events: 管理者は閲覧可" on public.hacomono_events
  for select to authenticated using (public.is_admin());
revoke all on public.hacomono_events from anon;
revoke insert, update, delete, truncate on public.hacomono_events from authenticated;
grant select, insert, update on public.hacomono_events to service_role;

-- 古い知らせの記録は90日で消す（毎日）
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('purge-hacomono-events') where exists (select 1 from cron.job where jobname = 'purge-hacomono-events');
    perform cron.schedule('purge-hacomono-events', '20 15 * * *', $q$delete from public.hacomono_events where received_at < now() - interval '90 days'$q$);
  end if;
end $$;

-- =========================================================
-- 申込みの「確認済み」は、hacomono の自動連携（サーバーの処理）からも付けられるようにする
-- =========================================================
create or replace function public.plan_applications_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() and not public.is_trusted_writer() then
    new.confirmed_at := null;
    new.confirmed_by := null;
    new.applied_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.plan_applications_guard() from public, anon, authenticated;
