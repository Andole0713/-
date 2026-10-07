-- ドリルの区分（タグ）
--   ・P1〜P10、クラブ、球筋、ミス、ショットなどの区分を複数付けて、ドリル集から探しやすくする
-- 何度実行しても問題ありません。

alter table public.drills add column if not exists tags text[] not null default '{}';
alter table public.drills drop constraint if exists drills_tags_check;
alter table public.drills add constraint drills_tags_check
  check (cardinality(tags) <= 40 and char_length(array_to_string(tags, '')) <= 800);
create index if not exists drills_tags_idx on public.drills using gin (tags);
