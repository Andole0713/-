-- かんたんアンケート：年代のかわりに生年月日を聞く
-- （統計の「年代」は、回答時に生年月日から自動で入れる。これまでの回答の年代はそのまま）
-- 何度実行しても問題ありません。
alter table public.member_survey add column if not exists birth_date date
  check (birth_date is null or (birth_date >= date '1900-01-01' and birth_date <= current_date));
