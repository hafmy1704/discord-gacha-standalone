\set ON_ERROR_STOP on

begin;

do $$
declare
  first_event jsonb;
  duplicate_event jsonb;
  stats jsonb;
  leaderboard jsonb;
begin
  first_event := public.record_chat_activity('test-guild', 'test-user', 'test-chat', 'test-message');
  duplicate_event := public.record_chat_activity('test-guild', 'test-user', 'test-chat', 'test-message');
  if (first_event ->> 'recorded')::boolean is distinct from true then
    raise exception 'first chat event was not recorded';
  end if;
  if (duplicate_event ->> 'duplicate')::boolean is distinct from true then
    raise exception 'duplicate chat event was recorded twice';
  end if;

  perform public.record_voice_activity('test-guild', 'test-user', 'test-voice', true, '2026-09-14 00:00:00+00'::timestamptz);
  perform public.record_voice_activity('test-guild', 'test-user', null, false, '2026-09-14 00:02:00+00'::timestamptz);
  stats := public.get_activity_stats('test-guild', 'test-user');
  if (stats #>> '{total,chat}')::integer <> 1 then raise exception 'chat total mismatch'; end if;
  if (stats #>> '{total,voiceSeconds}')::integer <> 120 then raise exception 'voice total mismatch'; end if;

  perform public.reset_voice_activity_sessions('test-guild');
  perform public.record_voice_activity('test-guild', 'test-user', 'test-voice', true, '2026-09-14 00:59:30+00'::timestamptz);
  perform public.record_voice_activity('test-guild', 'test-user', null, false, '2026-09-14 02:00:30+00'::timestamptz);
  if (select sum(voice_seconds) from public.activity_hourly_buckets where guild_id = 'test-guild' and user_id = 'test-user' and bucket_start = '2026-09-14 00:00:00+00'::timestamptz) <> 30 then raise exception 'first voice bucket mismatch'; end if;
  if (select sum(voice_seconds) from public.activity_hourly_buckets where guild_id = 'test-guild' and user_id = 'test-user' and bucket_start = '2026-09-14 01:00:00+00'::timestamptz) <> 3600 then raise exception 'middle voice bucket mismatch'; end if;
  if (select sum(voice_seconds) from public.activity_hourly_buckets where guild_id = 'test-guild' and user_id = 'test-user' and bucket_start = '2026-09-14 02:00:00+00'::timestamptz) <> 30 then raise exception 'last voice bucket mismatch'; end if;
  perform public.reset_voice_activity_sessions('test-guild');
  if exists (select 1 from public.activity_voice_sessions where guild_id = 'test-guild') then raise exception 'voice reset failed'; end if;
  leaderboard := public.get_activity_leaderboard('test-guild', 'test-user', 'chat', 10);
  if jsonb_array_length(leaderboard -> 'entries') <> 1 then raise exception 'leaderboard isolation mismatch'; end if;
  if (leaderboard #>> '{self,rank}')::integer <> 1 then raise exception 'self rank mismatch'; end if;

  if jsonb_array_length(public.get_activity_leaderboard('other-guild', 'test-user', 'chat', 10) -> 'entries') <> 0 then
    raise exception 'guild isolation failed';
  end if;
end;
$$;

rollback;
