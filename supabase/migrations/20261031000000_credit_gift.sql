-- 権利の「無料配布」（こちらのミスのお詫び・特典など）
--   ・お金をいただいて追加する「追加（都度購入など）」と区別して記録する（source = 'gift'）
--   ・スタッフだけが付与できる。有効期限は、ほかの権利と同じく付与した月から半年後の月末
-- 何度実行しても問題ありません。

alter table public.credits drop constraint if exists credits_source_check;
alter table public.credits add constraint credits_source_check
  check (source in ('monthly', 'first_free', 'purchase', 'manual', 'gift'));

create or replace function public.admin_gift_credit(p_member uuid, p_kind text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception '権限がありません'; end if;
  if p_kind not in ('video', 'meeting') then raise exception '種類が正しくありません'; end if;
  perform public.add_credits(p_member, p_kind, 1, 'gift', p_note, null);
end;
$$;
revoke execute on function public.admin_gift_credit(uuid, text, text) from public, anon;
grant execute on function public.admin_gift_credit(uuid, text, text) to authenticated;
