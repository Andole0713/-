-- 対応者の共有（担当を固定しない運用で、二重対応・対応漏れを防ぐ）
--   ・提出動画：だれが対応中か（claimed_by・claimed_at）
--   ・レッスン：だれが書いたか（created_by。新しく作るレッスンから自動で記録）
--   ・面談：だれが対応するか（staff_id）
-- ※ profiles への外部キーは付けない（付けると、会員名をまとめて読み込む処理が「どちらの会員か分からない」となり失敗するため）
-- 何度実行しても問題ありません。

alter table public.submissions add column if not exists claimed_by uuid;
alter table public.submissions add column if not exists claimed_at timestamptz;
alter table public.lessons     add column if not exists created_by uuid default auth.uid();
alter table public.meetings    add column if not exists staff_id   uuid;

-- 会員が動画を送るときに、対応者の欄を勝手に入れられないようにする
create or replace function public.submissions_clear_claim()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.claimed_by := null;
    new.claimed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists submissions_clear_claim on public.submissions;
create trigger submissions_clear_claim before insert on public.submissions
  for each row execute function public.submissions_clear_claim();
