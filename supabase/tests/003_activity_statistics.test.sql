\set ON_ERROR_STOP on

begin;

do $$
declare
  first_event jsonb;
  duplicate_event jsonb;
  stats jsonb;
  leaderboard jsonb;
  level_leaderboard jsonb;
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

  -- Restart cleanup must never credit time while the bot was offline.
  perform public.record_voice_activity('restart-guild', 'restart-user', 'test-voice', true, now() - interval '2 hours');
  perform public.reset_voice_activity_sessions('restart-guild');
  if coalesce((select voice_seconds from public.activity_user_totals where guild_id = 'restart-guild' and user_id = 'restart-user'), 0) <> 0 then
    raise exception 'restart cleanup credited offline voice time';
  end if;

  -- Bangkok midnight is 17:00 UTC; a sixty-second session must split 30/30.
  perform public.record_voice_activity('test-guild', 'boundary-user', 'test-voice', true, '2026-09-13 16:59:30+00'::timestamptz);
  perform public.record_voice_activity('test-guild', 'boundary-user', null, false, '2026-09-13 17:00:30+00'::timestamptz);
  if (select sum(voice_seconds) from public.activity_hourly_buckets where guild_id = 'test-guild' and user_id = 'boundary-user' and bucket_start = '2026-09-12 17:00:00+00'::timestamptz) <> 30 then raise exception 'pre-midnight voice bucket mismatch'; end if;
  if (select sum(voice_seconds) from public.activity_hourly_buckets where guild_id = 'test-guild' and user_id = 'boundary-user' and bucket_start = '2026-09-13 17:00:00+00'::timestamptz) <> 30 then raise exception 'post-midnight voice bucket mismatch'; end if;
  perform public.reset_voice_activity_sessions('test-guild');
  if exists (select 1 from public.activity_voice_sessions where guild_id = 'test-guild') then raise exception 'voice reset failed'; end if;
  leaderboard := public.get_activity_leaderboard('test-guild', 'test-user', 'chat', 10);
  if jsonb_array_length(leaderboard -> 'entries') <> 1 then raise exception 'leaderboard isolation mismatch'; end if;
  if (leaderboard #>> '{self,rank}')::integer <> 1 then raise exception 'self rank mismatch'; end if;
  if (leaderboard ->> 'totalPlayers')::integer <> 1 then raise exception 'leaderboard participant count mismatch'; end if;

  if jsonb_array_length(public.get_activity_leaderboard('other-guild', 'test-user', 'chat', 10) -> 'entries') <> 0 then
    raise exception 'guild isolation failed';
  end if;

  insert into public.players (guild_id, user_id, cultivation_xp, vault_xp)
  values ('level-guild', 'level-user', 100, 0)
  on conflict (guild_id, user_id) do update set cultivation_xp = excluded.cultivation_xp;
  level_leaderboard := public.get_level_leaderboard('level-guild', 'level-user', 10);
  if jsonb_array_length(level_leaderboard -> 'entries') <> 1 then raise exception 'level leaderboard entry mismatch'; end if;
  if (level_leaderboard ->> 'totalPlayers')::integer <> 1 then raise exception 'level leaderboard total mismatch'; end if;
  if (level_leaderboard #>> '{self,cultivationLevel}')::integer <> 1 then raise exception 'level leaderboard progression mismatch'; end if;
end;
$$;

rollback;
