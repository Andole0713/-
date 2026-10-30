-- コーチの解説動画（アプリの中で、音声と線を入れて作った動画）
--   ・保存場所 lesson-videos（非公開）。パスは「会員ID/ファイル名」
--   ・会員本人とスタッフだけが見られる。アップロード・削除はスタッフだけ
--   ・レッスンとして見返せるよう、送ってから6か月で自動削除する（レッスンの文章は残る）
-- 何度実行しても問題ありません。

alter table public.lessons add column if not exists coach_video_path text;
alter table public.lessons add column if not exists coach_video_deleted_at timestamptz;

insert into storage.buckets (id, name, public)
values ('lesson-videos', 'lesson-videos', false)
on conflict (id) do nothing;

drop policy if exists "lesson-videos: 管理者がアップロード" on storage.objects;
create policy "lesson-videos: 管理者がアップロード" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lesson-videos' and public.is_admin());

drop policy if exists "lesson-videos: 本人と管理者が閲覧" on storage.objects;
create policy "lesson-videos: 本人と管理者が閲覧" on storage.objects
  for select to authenticated
  using (bucket_id = 'lesson-videos' and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text));

drop policy if exists "lesson-videos: 管理者が削除" on storage.objects;
create policy "lesson-videos: 管理者が削除" on storage.objects
  for delete to authenticated
  using (bucket_id = 'lesson-videos' and public.is_admin());
