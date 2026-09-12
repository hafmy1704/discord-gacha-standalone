\set ON_ERROR_STOP on

begin;

do $$
declare
  level_number integer;
  threshold bigint;
  rate_total numeric;
begin
  if public.cultivation_level(2147418100::bigint) <> 6553 then
    raise exception 'cultivation boundary level mismatch';
  end if;
  if public.cultivation_points(2147418100::bigint) <> 0 then
    raise exception 'cultivation boundary points mismatch';
  end if;
  if public.cultivation_level(9223372036854775807::bigint) <> 429496729 then
    raise exception 'maximum cultivation level mismatch';
  end if;
  if public.hon_khi_vault_level(9223372036854775807::bigint) <> 57 then
    raise exception 'maximum vault level mismatch';
  end if;

  for level_number in 1..56 loop
    threshold := (100::numeric * (power(2::numeric, level_number - 1) - 1))::bigint;
    if public.hon_khi_vault_level(threshold) <> level_number then
      raise exception 'vault threshold mismatch at level %', level_number;
    end if;
    if level_number > 1 and public.hon_khi_vault_level(threshold - 1) <> level_number - 1 then
      raise exception 'vault pre-threshold mismatch at level %', level_number;
    end if;
  end loop;

  for level_number in 1..100 loop
    select sum((entry ->> 'rate')::numeric)
    into rate_total
    from jsonb_array_elements(public.hon_khi_tier_rates(level_number)) entry;
    if abs(rate_total - 1) > 0.000001 then
      raise exception 'tier rates do not sum to one at level %: %', level_number, rate_total;
    end if;
  end loop;
end;
$$;

do $$
declare
  violations integer;
begin
  with samples(xp) as (
    select ((9223372036854775807::numeric * sample_number) / 10000)::bigint
    from generate_series(0, 10000) sample_number
    union
    select unnest(array[
      0::bigint, 49, 50, 299, 300, 2147418099, 2147418100,
      9223372036854775807
    ])
  ), evaluated as (
    select xp, public.cultivation_level(xp)::numeric as level_number
    from samples
  )
  select count(*) into violations
  from evaluated
  where xp::numeric < 50::numeric * level_number * (level_number + 1)
     or xp::numeric >= 50::numeric * (level_number + 1) * (level_number + 2);

  if violations <> 0 then
    raise exception 'cultivation property violations: %', violations;
  end if;

  with rates as (
    select
      level_number,
      (entry ->> 'tier')::integer as tier,
      (entry ->> 'rate')::numeric as rate,
      least(10, greatest(2, level_number)) as max_tier
    from generate_series(1, 10000) level_number
    cross join lateral jsonb_array_elements(
      public.hon_khi_tier_rates(level_number)
    ) entry
  ), per_level as (
    select
      level_number,
      abs(sum(rate) - 1) as delta,
      count(*) filter (
        where rate < 0 or rate > 1 or (tier > max_tier and rate <> 0)
      ) as invalid_rates
    from rates
    group by level_number
  )
  select count(*) into violations
  from per_level
  where delta > 0.000001 or invalid_rates > 0;

  if violations <> 0 then
    raise exception 'tier probability property violations: %', violations;
  end if;
end;
$$;

select public.ensure_guild_config('audit-guild', array[]::text[]);

do $$
declare
  response jsonb;
begin
  response := public.set_reward_channel('audit-guild', 'channel-a', true);
  if response ->> 'changed' <> 'true' then
    raise exception 'first channel enable should change state';
  end if;
  response := public.set_reward_channel('audit-guild', 'channel-b', true);
  response := public.set_reward_channel('audit-guild', 'channel-a', false);
  if response -> 'channel_ids' <> '["channel-b"]'::jsonb then
    raise exception 'atomic reward channel result mismatch: %', response;
  end if;
  perform public.ensure_guild_config('audit-guild', array[]::text[]);
  select to_jsonb(channel_ids) into response
  from public.guild_config where guild_id = 'audit-guild';
  if response <> '["channel-b"]'::jsonb then
    raise exception 'ensure_guild_config overwrote existing channel state: %', response;
  end if;
end;
$$;

select public.enroll_player('audit-guild', 'audit-user');

do $$
declare
  first_result jsonb;
  replay_result jsonb;
  xp_after_first bigint;
  xp_after_replay bigint;
  orders_after_first bigint;
  orders_after_replay bigint;
begin
  first_result := public.award_chat_message(
    'audit-guild', 'audit-user', 'old-chat-request',
    '0123456789abcdef', 16, 2, true
  );
  select cultivation_xp, soul_orders into xp_after_first, orders_after_first
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';

  delete from public.request_receipts
  where guild_id = 'audit-guild'
    and event_type = 'chat_reward'
    and request_id = 'old-chat-request';
  begin
    perform public.award_chat_message(
      'audit-guild', 'different-user', 'old-chat-request',
      '0123456789abcdef', 16, 2, true
    );
    raise exception using message = 'missing_invalid_message_id';
  exception when others then
    if sqlerrm <> 'invalid_message_id' then
      raise;
    end if;
  end;
  perform public.award_chat_message(
    'audit-guild', 'audit-user', 'old-chat-request',
    '0123456789abcdef', 16, 2, true
  );

  update public.user_activity_log
  set created_at = now() - interval '2 months'
  where guild_id = 'audit-guild' and request_id = 'old-chat-request';
  perform public.cleanup_user_activity_log();

  replay_result := public.award_chat_message(
    'audit-guild', 'audit-user', 'old-chat-request',
    '0123456789abcdef', 16, 2, true
  );
  select cultivation_xp, soul_orders into xp_after_replay, orders_after_replay
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';

  if first_result ->> 'duplicate' <> 'false'
     or replay_result ->> 'duplicate' <> 'true'
     or xp_after_first <> xp_after_replay
     or orders_after_first <> orders_after_replay then
    raise exception 'chat replay committed twice: first %, replay %, xp %/%, orders %/%',
      first_result, replay_result, xp_after_first, xp_after_replay,
      orders_after_first, orders_after_replay;
  end if;
end;
$$;

do $$
declare
  first_result jsonb;
  replay_result jsonb;
  orders_after_first bigint;
  orders_after_replay bigint;
begin
  first_result := public.grant_soul_orders(
    'audit-guild', 'audit-user', 5, 'old-grant-request', 'audit', 'audit-admin'
  );
  select soul_orders into orders_after_first
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';

  update public.user_activity_log
  set created_at = now() - interval '2 months'
  where guild_id = 'audit-guild' and request_id = 'old-grant-request';
  perform public.cleanup_user_activity_log();

  replay_result := public.grant_soul_orders(
    'audit-guild', 'audit-user', 5, 'old-grant-request', 'audit', 'audit-admin'
  );
  select soul_orders into orders_after_replay
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';

  if first_result ->> 'duplicate' <> 'false'
     or replay_result ->> 'duplicate' <> 'true'
     or orders_after_first <> orders_after_replay then
    raise exception 'admin replay committed twice: first %, replay %, balances %/%',
      first_result, replay_result, orders_after_first, orders_after_replay;
  end if;
end;
$$;

insert into public.hon_khi_catalog
  (item_code, tier, slot, name, slot_budget, asset_key)
values
  ('t1_weapon_base', 1, 'weapon', 'Audit T1', 0.65, '/hon-khi/tier-01/t1_weapon_base.webp'),
  ('t2_offhand_base', 2, 'offhand', 'Audit T2', 0.40, '/hon-khi/tier-02/t2_offhand_base.webp');

do $$
declare
  first_result jsonb;
  replay_result jsonb;
  orders_after_first bigint;
  orders_after_replay bigint;
  rolls_after_first bigint;
  rolls_after_replay bigint;
begin
  first_result := public.draw_hon_khi_with_session(
    'audit-guild', 'audit-user', 'old-gacha-request'
  );
  select soul_orders into orders_after_first
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';
  rolls_after_first := public.get_total_hon_khi_rolls('audit-guild', 'audit-user');

  update public.user_activity_log
  set created_at = now() - interval '2 months'
  where guild_id = 'audit-guild' and request_id = 'old-gacha-request';
  perform public.cleanup_user_activity_log();

  replay_result := public.draw_hon_khi_with_session(
    'audit-guild', 'audit-user', 'old-gacha-request'
  );
  select soul_orders into orders_after_replay
  from public.players where guild_id = 'audit-guild' and user_id = 'audit-user';
  rolls_after_replay := public.get_total_hon_khi_rolls('audit-guild', 'audit-user');

  if replay_result ->> 'replayed' <> 'true'
     or orders_after_first <> orders_after_replay
     or rolls_after_first <> rolls_after_replay then
    raise exception 'gacha replay committed twice: first %, replay %, balances %/%, rolls %/%',
      first_result, replay_result, orders_after_first, orders_after_replay,
      rolls_after_first, rolls_after_replay;
  end if;
end;
$$;

do $$
begin
  if has_table_privilege(
       'anon', 'public.request_receipts', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_table_privilege(
       'authenticated', 'public.request_receipts', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or not has_table_privilege(
       'service_role', 'public.request_receipts', 'SELECT'
     ) then
    raise exception 'request receipt privileges are not service-role-only';
  end if;

  if has_function_privilege(
       'anon',
       'public.adjust_soul_orders(text,text,integer,text,text,text,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.draw_hon_khi_with_session(text,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.adjust_soul_orders(text,text,integer,text,text,text,integer)',
       'EXECUTE'
     ) then
    raise exception 'sensitive RPC privileges are not service-role-only';
  end if;

  if exists (
    select 1
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind = 'r'
      and relname in (
        'guild_config', 'players', 'hon_khi_catalog', 'hon_khi_equipped',
        'user_hon_khi_collection', 'user_activity_log', 'request_receipts'
      )
      and not relrowsecurity
  ) then
    raise exception 'RLS disabled on protected table';
  end if;
end;
$$;

\if :{?keep_test_data}
  commit;
\else
  rollback;
\endif
