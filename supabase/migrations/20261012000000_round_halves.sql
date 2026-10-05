-- スコアを前半・後半（ハーフごと）に入力できるようにする
--   score（合計）は、前半＋後半の合計。後半がない記録は9ホールとして扱う
-- 先に 20261011000000_rounds.sql を実行してください。何度実行しても問題ありません。

alter table public.rounds add column if not exists out_score smallint;   -- 前半（OUT）
alter table public.rounds add column if not exists in_score  smallint;   -- 後半（IN）

alter table public.rounds drop constraint if exists rounds_halves_check;
alter table public.rounds add constraint rounds_halves_check check (
  (out_score is null or out_score between 10 and 125)
  and (in_score is null or in_score between 10 and 125)
  and (out_score is null or score = out_score + coalesce(in_score, 0))
  and (in_score is null or out_score is not null)
);
