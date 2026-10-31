-- 今月のテーマ：書いた月を覚えておき、月が変わったらホームではロードマップのテーマに戻す
-- （アプリ側で「書いた月と今の月が同じときだけ、手で書いたテーマを出す」）

alter table public.profiles add column if not exists theme_set_on date;

-- すでに書いてあるテーマは、今月書いたものとして扱う（急に消えないように）
update public.profiles
   set theme_set_on = (now() at time zone 'Asia/Tokyo')::date
 where coalesce(theme, '') <> '' and theme_set_on is null;

-- テーマが変わったら、書いた日を自動で記録する。会員は書いた日を変えられない
create or replace function public.touch_theme_set_on()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.theme is distinct from old.theme then
    new.theme_set_on := case when coalesce(new.theme, '') = '' then null
                             else (now() at time zone 'Asia/Tokyo')::date end;
  elsif new.theme_set_on is distinct from old.theme_set_on
        and not public.is_admin() and not public.is_service_role() then
    raise exception '変更できない項目が含まれています';
  end if;
  return new;
end;
$$;

drop trigger if exists touch_theme_set_on on public.profiles;
create trigger touch_theme_set_on
  before update on public.profiles
  for each row execute function public.touch_theme_set_on();
