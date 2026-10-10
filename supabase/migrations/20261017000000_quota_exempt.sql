-- 提出本数に「数えない」動画
--   ・こちら側のミスなどで、動画は残したまま今月の提出本数を戻したいときに使う
--   ・quota_exempt = true の動画は、今月の提出本数に数えない
-- 何度実行しても問題ありません。

alter table public.submissions add column if not exists quota_exempt boolean not null default false;

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
            and not s.quota_exempt
            and s.created_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')
        ) < 2 + case
              when p.extra_submissions_month = date_trunc('month', now() at time zone 'Asia/Tokyo')::date
              then p.extra_submissions else 0 end
      )
  );
$$;

revoke execute on function public.can_submit_video() from anon, public;
grant execute on function public.can_submit_video() to authenticated, service_role;
