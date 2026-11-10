-- 電子カルテ（指導記録）と、ロードマップの節目の目標
--   ・ロードマップ：各年の 3か月目・6か月目に「中間目標」、12か月目に「目標」を設定できるようにする（何年でもくり返せる）
--   ・カルテ：担当コーチ・いま取り組んでいる課題・指導方針（申し送り）を追加
--   ・指導記録：面談・添削・ドリル設定・引き継ぎなどを、決まった項目で時系列に残す（コーチが変わっても共有できる）
--   ・どれも管理者（スタッフ・コーチ）だけが読み書きできる。会員には見えない（ロードマップの節目の目標だけは会員にも表示）
-- 何度実行しても問題ありません。

-- ロードマップの節目の目標（3・6・12か月目に使う）
alter table public.roadmap_items add column if not exists milestone text not null default '';
alter table public.roadmap_items drop constraint if exists roadmap_items_milestone_len;
alter table public.roadmap_items add constraint roadmap_items_milestone_len check (char_length(milestone) <= 200);

-- カルテの基本項目
alter table public.member_karte add column if not exists coach_name text not null default '';
alter table public.member_karte add column if not exists focus      text not null default '';
alter table public.member_karte add column if not exists policy     text not null default '';
alter table public.member_karte drop constraint if exists member_karte_chart_len;
alter table public.member_karte add constraint member_karte_chart_len
  check (char_length(coach_name) <= 50 and char_length(focus) <= 500 and char_length(policy) <= 1000);

-- 指導記録
create table if not exists public.chart_entries (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles (id) on delete cascade,
  entry_date  date not null default current_date,
  kind        text not null default 'other' check (kind in ('meeting', 'review', 'drill', 'handover', 'other')),
  content     text not null default '' check (char_length(content) <= 2000),     -- やったこと・見たこと（事実）
  issues      text not null default '' check (char_length(issues) <= 1000),      -- 課題・気づき（判断）
  drills      text not null default '' check (char_length(drills) <= 1000),      -- 出したドリル・練習
  next_action text not null default '' check (char_length(next_action) <= 1000), -- 次回対応
  next_done   boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists chart_entries_member_idx on public.chart_entries (member_id, entry_date desc, created_at desc);

alter table public.chart_entries enable row level security;
drop policy if exists "chart_entries: 管理者のみ" on public.chart_entries;
create policy "chart_entries: 管理者のみ" on public.chart_entries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
