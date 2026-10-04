-- 会員ページを使いやすくするための追加
--   ・レッスンの「NEW」表示（会員が開いた日時）
--   ・次回までの練習のチェック
--   ・メールでのお知らせ（レッスン到着・面談の前日）
--   ・初回ログイン時の使い方ガイド
-- すでに初期設定を実行したデータベースでは、このファイルを SQL Editor で実行してください。何度実行しても問題ありません。

alter table public.lessons add column if not exists read_at timestamptz;               -- 会員が初めて開いた日時（空なら NEW）
alter table public.lessons add column if not exists practice_done smallint[] not null default '{}'; -- チェック済みの練習（1行目 = 0）

alter table public.profiles add column if not exists email_notify boolean not null default true;  -- お知らせメールを受け取る
alter table public.profiles add column if not exists onboarded_at timestamptz;                    -- 使い方ガイドを見た日時
alter table public.profiles add column if not exists meeting_reminded_for timestamptz;            -- 前日のお知らせを送った面談日時（二重送信防止）

-- 会員がレッスンを開いたときに「既読」にする（本人のレッスンだけ。最初の1回だけ記録）
create or replace function public.mark_lesson_read(p_lesson uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.lessons set read_at = now()
  where id = p_lesson and member_id = auth.uid() and read_at is null;
$$;

-- 会員が「次回までの練習」の1行をチェック／チェック解除する（本人のレッスンだけ）
create or replace function public.set_practice_done(p_lesson uuid, p_index integer, p_done boolean)
returns smallint[]
language sql
security definer
set search_path = ''
as $$
  update public.lessons
  set practice_done = case
    when p_done then (select coalesce(array_agg(distinct x order by x), '{}') from unnest(practice_done || p_index::smallint) x)
    else array_remove(practice_done, p_index::smallint) end
  where id = p_lesson and member_id = auth.uid() and p_index between 0 and 49
  returning practice_done;
$$;

revoke execute on function public.mark_lesson_read(uuid), public.set_practice_done(uuid, integer, boolean) from anon, public;
grant execute on function public.mark_lesson_read(uuid), public.set_practice_done(uuid, integer, boolean) to authenticated;

-- 会員が変更できる項目：名前・Myクラブセッティング・お知らせメールの設定・使い方ガイドの表示済み
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

  if new.id                      is distinct from old.id
  or new.role                    is distinct from old.role
  or new.email                   is distinct from old.email
  or new.plan                    is distinct from old.plan
  or new.goal                    is distinct from old.goal
  or new.best_score              is distinct from old.best_score
  or new.avg_score               is distinct from old.avg_score
  or new.theme                   is distinct from old.theme
  or new.next_meeting_at         is distinct from old.next_meeting_at
  or new.meeting_reminded_for    is distinct from old.meeting_reminded_for
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
