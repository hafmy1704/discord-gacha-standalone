begin;

create or replace function public.draw_hon_khi_with_session(
  p_guild_id   text,
  p_user_id    text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_guild_id, p_user_id, p_request_id),
      0
    )
  );

  result := public.draw_hon_khi(p_guild_id, p_user_id, p_request_id);
  return result || jsonb_build_object(
    'session', public.get_hon_khi_session(p_guild_id, p_user_id)
  );
end;
$$;

revoke execute on function public.draw_hon_khi_with_session(text, text, text)
  from public, anon, authenticated;
grant execute on function public.draw_hon_khi_with_session(text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
