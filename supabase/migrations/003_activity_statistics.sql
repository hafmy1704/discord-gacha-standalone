create table if not exists public.activity_hourly_buckets (
  guild_id text not null,
  user_id text not null,
  channel_id text not null,
  bucket_start timestamptz not null,
  chat_messages integer not null default 0 check (chat_messages >= 0),
  voice_seconds integer not null default 0 check (voice_seconds >= 0),
  primary key (guild_id, user_id, channel_id, bucket_start)
);

create table if not exists public.activity_message_receipts (
  guild_id text not null,
  message_id text not null,
  user_id text not null,
  channel_id text not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, message_id)
);

create table if not exists public.activity_voice_sessions (
  guild_id text not null,
  user_id text not null,
  channel_id text not null,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (guild_id, user_id)
);

create table if not exists public.activity_user_totals (
  guild_id text not null,
  user_id text not null,
  chat_messages bigint not null default 0 check (chat_messages >= 0),
  voice_seconds bigint not null default 0 check (voice_seconds >= 0),
  primary key (guild_id, user_id)
);

create index if not exists activity_hourly_window_idx on public.activity_hourly_buckets (guild_id, bucket_start desc);
create index if not exists activity_hourly_user_window_idx on public.activity_hourly_buckets (guild_id, user_id, bucket_start desc);
create index if not exists activity_hourly_channel_window_idx on public.activity_hourly_buckets (guild_id, channel_id, bucket_start desc);

alter table public.activity_hourly_buckets enable row level security;
alter table public.activity_message_receipts enable row level security;
alter table public.activity_voice_sessions enable row level security;
alter table public.activity_user_totals enable row level security;
revoke all on public.activity_hourly_buckets, public.activity_message_receipts, public.activity_voice_sessions, public.activity_user_totals from public, anon, authenticated;
grant all on public.activity_hourly_buckets, public.activity_message_receipts, public.activity_voice_sessions, public.activity_user_totals to service_role;

create or replace function public.activity_bucket_start(p_at timestamptz)
returns timestamptz language sql immutable as $$
  select date_trunc('day', p_at at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
$$;

create or replace function public.activity_window_start(p_window interval)
returns timestamptz language sql stable as $$
  select date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok' - (p_window - interval '1 day');
$$;
create or replace function public.record_chat_activity(p_guild_id text, p_user_id text, p_channel_id text, p_message_id text, p_created_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare bucket timestamptz := public.activity_bucket_start(p_created_at); inserted integer;
begin
  if p_guild_id is null or p_user_id is null or p_channel_id is null or p_message_id is null then raise exception using message = 'invalid_activity_event'; end if;
  insert into public.activity_message_receipts (guild_id, message_id, user_id, channel_id, created_at) values (p_guild_id, p_message_id, p_user_id, p_channel_id, p_created_at) on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return jsonb_build_object('recorded', false, 'duplicate', true); end if;
  insert into public.activity_hourly_buckets (guild_id, user_id, channel_id, bucket_start, chat_messages) values (p_guild_id, p_user_id, p_channel_id, bucket, 1) on conflict (guild_id, user_id, channel_id, bucket_start) do update set chat_messages = activity_hourly_buckets.chat_messages + 1;
  insert into public.activity_user_totals (guild_id, user_id, chat_messages) values (p_guild_id, p_user_id, 1) on conflict (guild_id, user_id) do update set chat_messages = activity_user_totals.chat_messages + 1;
  return jsonb_build_object('recorded', true, 'duplicate', false);
end;
$$;

create or replace function public.record_voice_activity(p_guild_id text, p_user_id text, p_channel_id text default null, p_active boolean default true, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.activity_voice_sessions%rowtype;
  v_total_seconds integer := 0;
  v_segment_seconds integer;
  v_cursor_at timestamptz;
  bucket timestamptz;
  v_bucket_end timestamptz;
  v_segment_end timestamptz;
begin
  select * into v_session from public.activity_voice_sessions where guild_id = p_guild_id and user_id = p_user_id for update;
  if found then
    v_cursor_at := v_session.last_seen_at;
    while v_cursor_at < p_now loop
      bucket := public.activity_bucket_start(v_cursor_at);
      v_bucket_end := bucket + interval '1 day';
      v_segment_end := least(v_bucket_end, p_now);
      v_segment_seconds := greatest(0, floor(extract(epoch from (v_segment_end - v_cursor_at)))::integer);
      if v_segment_seconds > 0 then
        insert into public.activity_hourly_buckets (guild_id, user_id, channel_id, bucket_start, voice_seconds) values (p_guild_id, p_user_id, v_session.channel_id, bucket, v_segment_seconds) on conflict (guild_id, user_id, channel_id, bucket_start) do update set voice_seconds = activity_hourly_buckets.voice_seconds + excluded.voice_seconds;
        insert into public.activity_user_totals (guild_id, user_id, voice_seconds) values (p_guild_id, p_user_id, v_segment_seconds) on conflict (guild_id, user_id) do update set voice_seconds = activity_user_totals.voice_seconds + excluded.voice_seconds;
        v_total_seconds := v_total_seconds + v_segment_seconds;
      end if;
      v_cursor_at := v_segment_end;
    end loop;
    delete from public.activity_voice_sessions where guild_id = p_guild_id and user_id = p_user_id;
  end if;
  if p_active and p_channel_id is not null then
    insert into public.activity_voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at) values (p_guild_id, p_user_id, p_channel_id, p_now, p_now) on conflict (guild_id, user_id) do update set channel_id = excluded.channel_id, started_at = excluded.started_at, last_seen_at = excluded.last_seen_at;
  end if;
  return jsonb_build_object('updated', true, 'seconds', v_total_seconds);
end;
$$;

create or replace function public.reset_voice_activity_sessions(p_guild_id text)
returns bigint language plpgsql security definer set search_path = public as $$
declare session_row record; reset_count bigint := 0;
begin
  for session_row in
    select guild_id, user_id
    from public.activity_voice_sessions
    where guild_id = p_guild_id
  loop
    perform public.record_voice_activity(session_row.guild_id, session_row.user_id, null, false, now());
    reset_count := reset_count + 1;
  end loop;
  return reset_count;
end;
$$;
create or replace function public.get_activity_window(p_guild_id text, p_user_id text, p_window interval)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('chat', coalesce(sum(chat_messages), 0), 'voiceSeconds', coalesce(sum(voice_seconds), 0))
  from public.activity_hourly_buckets where guild_id = p_guild_id and user_id = p_user_id and bucket_start >= public.activity_window_start(p_window);
$$;

create or replace function public.get_activity_channels(p_guild_id text, p_user_id text, p_window interval)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'chat', coalesce((select jsonb_build_object('channelId', channel_id, 'value', sum(chat_messages)) from public.activity_hourly_buckets where guild_id = p_guild_id and user_id = p_user_id and bucket_start >= public.activity_window_start(p_window) and chat_messages > 0 group by channel_id order by sum(chat_messages) desc, channel_id limit 1), jsonb_build_object('channelId', null, 'value', 0)),
    'voice', coalesce((select jsonb_build_object('channelId', channel_id, 'value', sum(voice_seconds)) from public.activity_hourly_buckets where guild_id = p_guild_id and user_id = p_user_id and bucket_start >= public.activity_window_start(p_window) and voice_seconds > 0 group by channel_id order by sum(voice_seconds) desc, channel_id limit 1), jsonb_build_object('channelId', null, 'value', 0))
  );
$$;

create or replace function public.get_activity_stats(p_guild_id text, p_user_id text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'total', coalesce((select jsonb_build_object('chat', chat_messages, 'voiceSeconds', voice_seconds) from public.activity_user_totals where guild_id = p_guild_id and user_id = p_user_id), jsonb_build_object('chat', 0, 'voiceSeconds', 0)),
    'windows', jsonb_build_object('1', public.get_activity_window(p_guild_id, p_user_id, interval '1 day'), '7', public.get_activity_window(p_guild_id, p_user_id, interval '7 days'), '30', public.get_activity_window(p_guild_id, p_user_id, interval '30 days')),
    'channels', public.get_activity_channels(p_guild_id, p_user_id, interval '30 days')
  );
$$;

create or replace function public.get_activity_leaderboard(p_guild_id text, p_user_id text, p_metric text, p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rows jsonb; self_row jsonb;
begin
  if p_metric not in ('chat', 'voice') then raise exception using message = 'invalid_activity_metric'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 25 then raise exception using message = 'invalid_activity_limit'; end if;
  if p_metric = 'chat' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (select user_id, sum(chat_messages)::bigint value, row_number() over (order by sum(chat_messages) desc, user_id) rank from public.activity_hourly_buckets where guild_id = p_guild_id and bucket_start >= public.activity_window_start(interval '30 days') group by user_id order by value desc, user_id limit p_limit) x;
    select to_jsonb(x) into self_row from (select user_id, sum(chat_messages)::bigint value, row_number() over (order by sum(chat_messages) desc, user_id) rank from public.activity_hourly_buckets where guild_id = p_guild_id and bucket_start >= public.activity_window_start(interval '30 days') group by user_id) x where user_id = p_user_id;
  else
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (select user_id, sum(voice_seconds)::bigint value, row_number() over (order by sum(voice_seconds) desc, user_id) rank from public.activity_hourly_buckets where guild_id = p_guild_id and bucket_start >= public.activity_window_start(interval '30 days') group by user_id order by value desc, user_id limit p_limit) x;
    select to_jsonb(x) into self_row from (select user_id, sum(voice_seconds)::bigint value, row_number() over (order by sum(voice_seconds) desc, user_id) rank from public.activity_hourly_buckets where guild_id = p_guild_id and bucket_start >= public.activity_window_start(interval '30 days') group by user_id) x where user_id = p_user_id;
  end if;
  return jsonb_build_object('metric', p_metric, 'entries', rows, 'self', self_row);
end;
$$;

create or replace function public.cleanup_activity_statistics()
returns bigint language plpgsql security definer set search_path = public as $$
declare removed bigint;
begin
  delete from public.activity_hourly_buckets where bucket_start < public.activity_window_start(interval '35 days');
  get diagnostics removed = row_count;
  delete from public.activity_message_receipts where created_at < now() - interval '35 days';
  return removed;
end;
$$;

revoke all on function public.activity_window_start(interval) from public, anon, authenticated;

grant execute on function public.activity_window_start(interval) to service_role;

revoke all on function public.record_chat_activity(text, text, text, text, timestamptz), public.record_voice_activity(text, text, text, boolean, timestamptz), public.reset_voice_activity_sessions(text), public.get_activity_window(text, text, interval), public.get_activity_channels(text, text, interval), public.get_activity_stats(text, text), public.get_activity_leaderboard(text, text, text, integer), public.cleanup_activity_statistics() from public, anon, authenticated;
grant execute on function public.record_chat_activity(text, text, text, text, timestamptz), public.record_voice_activity(text, text, text, boolean, timestamptz), public.reset_voice_activity_sessions(text), public.get_activity_window(text, text, interval), public.get_activity_channels(text, text, interval), public.get_activity_stats(text, text), public.get_activity_leaderboard(text, text, text, integer), public.cleanup_activity_statistics() to service_role;

-- Level and cultivation leaderboard.

create or replace function public.get_level_leaderboard(
  p_guild_id text,
  p_user_id text,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  safe_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
begin
  with ranked as (
    select
      p.user_id,
      public.cultivation_level(p.cultivation_xp) as cultivation_level,
      public.hon_khi_vault_level(p.vault_xp) as vault_level,
      round(
        public.cultivation_level(p.cultivation_xp)::numeric * 100
        + coalesce(sum(e.power), 0),
        2
      ) as power,
      coalesce(max(e.tier), 0) as highest_tier,
      row_number() over (
        order by
          public.cultivation_level(p.cultivation_xp) desc,
          round(
            public.cultivation_level(p.cultivation_xp)::numeric * 100
            + coalesce(sum(e.power), 0),
            2
          ) desc,
          p.user_id
      ) as rank,
      count(*) over () as total_players
    from public.players p
    left join public.hon_khi_equipped e
      on e.guild_id = p.guild_id and e.user_id = p.user_id
    where p.guild_id = p_guild_id
    group by p.user_id, p.cultivation_xp, p.vault_xp
  )
  select jsonb_build_object(
    'entries', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'userId', user_id,
          'rank', rank,
          'power', power,
          'vaultLevel', vault_level,
          'cultivationLevel', cultivation_level,
          'highestTier', highest_tier,
          'isSelf', user_id = p_user_id
        ) order by rank
      ) filter (where rank <= safe_limit),
      '[]'::jsonb
    ),
    'self', (
      select jsonb_build_object(
        'userId', user_id,
        'rank', rank,
        'power', power,
        'vaultLevel', vault_level,
        'cultivationLevel', cultivation_level,
        'highestTier', highest_tier,
        'isSelf', true
      )
      from ranked
      where user_id = p_user_id
    ),
    'totalPlayers', coalesce(max(total_players), 0)
  )
  into result
  from ranked;

  return coalesce(
    result,
    jsonb_build_object('entries', '[]'::jsonb, 'self', null, 'totalPlayers', 0)
  );
end;
$$;

revoke all on function public.get_level_leaderboard(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_level_leaderboard(text, text, integer)
  to service_role;
