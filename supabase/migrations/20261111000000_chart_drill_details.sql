-- 電子カルテとドリル集の項目を追加（スタッフ用資料 2026年10月25日版の運用案に合わせる）
--   ・指導記録：前回からの変化／ドリルを選んだ理由・練習方法／続けること・変えること（理由）／保留中の話
--   ・ロードマップの節目：何ができれば達成とするか
--   ・カウンセリングシート：初回のスイングの状態
--   ・ドリル集：どんな悩みに使うか／どんな人に向くか／練習方法／次へ進む目安／注意点／更新日と更新の履歴
-- 何度実行しても問題ありません。

alter table public.chart_entries add column if not exists changes         text not null default '';
alter table public.chart_entries add column if not exists drill_reason    text not null default '';
alter table public.chart_entries add column if not exists continue_change text not null default '';
alter table public.chart_entries add column if not exists pending         text not null default '';
alter table public.chart_entries drop constraint if exists chart_entries_more_len;
alter table public.chart_entries add constraint chart_entries_more_len check (
  char_length(changes) <= 1000 and char_length(drill_reason) <= 1000 and char_length(continue_change) <= 1000 and char_length(pending) <= 1000);

alter table public.roadmap_items add column if not exists milestone_check text not null default '';
alter table public.roadmap_items drop constraint if exists roadmap_items_milestone_check_len;
alter table public.roadmap_items add constraint roadmap_items_milestone_check_len check (char_length(milestone_check) <= 200);

alter table public.member_karte add column if not exists first_swing text not null default '';
alter table public.member_karte drop constraint if exists member_karte_first_swing_len;
alter table public.member_karte add constraint member_karte_first_swing_len check (char_length(first_swing) <= 500);

alter table public.drills add column if not exists use_for    text not null default '';
alter table public.drills add column if not exists for_who    text not null default '';
alter table public.drills add column if not exists how_to     text not null default '';
alter table public.drills add column if not exists next_step  text not null default '';
alter table public.drills add column if not exists caution    text not null default '';
alter table public.drills add column if not exists updated_at timestamptz not null default now();
alter table public.drills drop constraint if exists drills_info_len;
alter table public.drills add constraint drills_info_len check (
  char_length(use_for) <= 500 and char_length(for_who) <= 500 and char_length(how_to) <= 1000 and char_length(next_step) <= 500 and char_length(caution) <= 500);

-- ドリルの更新履歴（保存するたびに、その時点の内容を残す。いつどの説明を会員に渡したか分かるように）
create table if not exists public.drill_revisions (
  id          uuid primary key default gen_random_uuid(),
  drill_id    uuid not null references public.drills (id) on delete cascade,
  title       text not null default '',
  description text not null default '',
  use_for     text not null default '',
  for_who     text not null default '',
  how_to      text not null default '',
  next_step   text not null default '',
  caution     text not null default '',
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists drill_revisions_drill_idx on public.drill_revisions (drill_id, created_at desc);
alter table public.drill_revisions enable row level security;
drop policy if exists "drill_revisions: 管理者のみ" on public.drill_revisions;
create policy "drill_revisions: 管理者のみ" on public.drill_revisions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
