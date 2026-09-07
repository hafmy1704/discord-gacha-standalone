begin;

create or replace function public.get_player_profile(
  p_guild_id text,
  p_user_id  text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  player_row public.players%rowtype;
  total_rolls bigint;
  cultivation_level integer;
  cultivation_progress numeric;
  equipment_power numeric;
  equipment_stats jsonb;
begin
  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id;

  if not found then
    return null;
  end if;

  cultivation_level := public.cultivation_level(player_row.cultivation_xp);
  cultivation_progress := round(
    public.cultivation_points(player_row.cultivation_xp)::numeric
      / (100 * cultivation_level),
    4
  );
  select coalesce(sum(e.power), 0)::numeric
  into equipment_power
  from public.hon_khi_equipped e
  where e.guild_id = p_guild_id and e.user_id = p_user_id;

  select coalesce(jsonb_object_agg(stat.key, stat.total), '{}'::jsonb)
  into equipment_stats
  from (
    select entry.key, sum((entry.value #>> '{}')::numeric) as total
    from public.hon_khi_equipped e
    cross join lateral jsonb_each(e.stats) entry
    where e.guild_id = p_guild_id and e.user_id = p_user_id
    group by entry.key
  ) stat;

  total_rolls := public.get_total_hon_khi_rolls(p_guild_id, p_user_id);

  return jsonb_build_object(
    'isAwakened', player_row.is_awakened,
    'soulOrders', player_row.soul_orders,
    'cultivationLevel', cultivation_level,
    'cultivationPoints', public.cultivation_points(player_row.cultivation_xp),
    'cultivationPointsRequired', 100 * cultivation_level,
    'cultivationProgress', cultivation_progress,
    'vaultXp', player_row.vault_xp,
    'vaultLevel', public.hon_khi_vault_level(player_row.vault_xp),
    'refinementSteel', player_row.refinement_steel,
    'equipmentPower', equipment_power,
    'power', cultivation_level * 100 + equipment_power,
    'equipmentStats', equipment_stats,
    'totalRolls', total_rolls
  );
end;
$$;

create or replace function public.get_hon_khi_session(
  p_guild_id text,
  p_user_id  text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  player_row              public.players%rowtype;
  equipped_json           jsonb;
  collection_json         jsonb;
  collection_summary_json jsonb;
  history_json            jsonb;
  tier_rate_previews_json jsonb;
  total_rolls             bigint;
  equipment_count         bigint;
  equipment_power         numeric;
  vault_level             integer;
  upgrade_cost            bigint;
  vault_progress          numeric;
begin
  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id;

  if not found or not player_row.is_awakened then
    raise exception using message = 'not_enrolled';
  end if;

  vault_level := public.hon_khi_vault_level(player_row.vault_xp);
  upgrade_cost := public.hon_khi_vault_cost(vault_level);
  vault_progress := round(
    least(1::numeric, player_row.refinement_steel::numeric / upgrade_cost) * 100,
    2
  );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'itemCode', e.item_code,
      'name', c.name,
      'slot', e.slot,
      'slotLabel', public.hon_khi_slot_label(e.slot),
      'tier', e.tier,
      'tierLabel', concat('T', e.tier),
      'ageYears', e.age_years,
      'stats', e.stats,
      'power', e.power,
      'assetKey', c.asset_key,
      'acquiredAt', e.acquired_at
    ) order by array_position(
      array['weapon', 'offhand', 'crown', 'armor', 'bracer', 'belt', 'boots',
        'necklace', 'ring', 'talisman', 'treasure', 'seal']::text[], e.slot
    )
  ), '[]'::jsonb)
  into equipped_json
  from public.hon_khi_equipped e
  join public.hon_khi_catalog c on c.item_code = e.item_code
  where e.guild_id = p_guild_id and e.user_id = p_user_id;

  select count(*)::bigint, coalesce(sum(e.power), 0)::numeric
  into equipment_count, equipment_power
  from public.hon_khi_equipped e
  where e.guild_id = p_guild_id and e.user_id = p_user_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'itemCode', c.item_code,
      'name', c.name,
      'tier', c.tier,
      'slot', c.slot,
      'slotLabel', public.hon_khi_slot_label(c.slot),
      'assetKey', c.asset_key,
      'rollCount', u.roll_count
    ) order by c.tier, array_position(
      array['weapon', 'offhand', 'crown', 'armor', 'bracer', 'belt', 'boots',
        'necklace', 'ring', 'talisman', 'treasure', 'seal']::text[], c.slot
    )
  ), '[]'::jsonb)
  into collection_json
  from public.user_hon_khi_collection u
  join public.hon_khi_catalog c on c.item_code = u.item_code
  where u.guild_id = p_guild_id and u.user_id = p_user_id;

  select jsonb_build_object(
    'discoveredCount', (
      select count(*)::bigint
      from public.user_hon_khi_collection
      where guild_id = p_guild_id and user_id = p_user_id
    ),
    'totalCount', (select count(*)::bigint from public.hon_khi_catalog),
    'byTier', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'tier', tier,
          'discoveredCount', discovered_count,
          'totalCount', total_count
        ) order by tier
      )
      from (
        select c.tier,
               count(*)::bigint as total_count,
               count(u.item_code)::bigint as discovered_count
        from public.hon_khi_catalog c
        left join public.user_hon_khi_collection u
          on u.guild_id = p_guild_id
         and u.user_id = p_user_id
         and u.item_code = c.item_code
        group by c.tier
      ) tier_summary
    ), '[]'::jsonb)
  )
  into collection_summary_json;

  select public.get_total_hon_khi_rolls(p_guild_id, p_user_id)
  into total_rolls;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'level', preview.level,
      'rates', public.hon_khi_tier_rates(preview.level)
    ) order by preview.level
  ), '[]'::jsonb)
  into tier_rate_previews_json
  from (
    select level from generate_series(1, 15) level
    union
    select vault_level
  ) preview(level);

  select coalesce(jsonb_agg(
    h.payload || jsonb_build_object(
      'requestId', h.request_id,
      'createdAt', h.created_at
    ) order by h.created_at desc
  ), '[]'::jsonb)
  into history_json
  from (
    select payload, request_id, created_at
    from public.user_activity_log
    where guild_id = p_guild_id
      and user_id = p_user_id
      and event_type = 'gacha_roll'
    order by created_at desc
    limit 20
  ) h;

  return jsonb_build_object(
    'soulOrders', player_row.soul_orders,
    'refinementSteel', player_row.refinement_steel,
    'vaultXp', player_row.vault_xp,
    'vaultLevel', vault_level,
    'upgradeCost', upgrade_cost,
    'vaultProgress', vault_progress,
    'canDraw', player_row.soul_orders > 0,
    'tierRates', public.hon_khi_tier_rates(vault_level),
    'tierRatePreviews', tier_rate_previews_json,
    'totalRolls', total_rolls,
    'equipmentCount', equipment_count,
    'equipmentPower', equipment_power,
    'equipped', equipped_json,
    'collection', collection_json,
    'collectionSummary', collection_summary_json,
    'history', history_json
  );
end;
$$;

create or replace function public.get_hon_khi_leaderboard(
  p_guild_id text,
  p_user_id  text,
  p_limit    integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  safe_limit integer := greatest(0, least(coalesce(p_limit, 20), 100));
begin
  with ranked as (
    select
      p.user_id,
      public.cultivation_level(p.cultivation_xp) as cultivation_level,
      public.hon_khi_vault_level(p.vault_xp) as vault_level,
      round(
        public.cultivation_level(p.cultivation_xp) * 100
        + coalesce(sum(e.power), 0),
        2
      ) as power,
      coalesce(max(e.tier), 0) as highest_tier,
      row_number() over (
        order by
          round(
            public.cultivation_level(p.cultivation_xp) * 100
            + coalesce(sum(e.power), 0),
            2
          ) desc,
          p.user_id
      ) as rank,
      count(*) over () as total_players
    from public.players p
    left join public.hon_khi_equipped e
      on e.guild_id = p.guild_id and e.user_id = p.user_id
    where p.guild_id = p_guild_id and p.is_awakened
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
  result := public.draw_hon_khi(p_guild_id, p_user_id, p_request_id);
  return result || jsonb_build_object(
    'session', public.get_hon_khi_session(p_guild_id, p_user_id)
  );
end;
$$;

revoke execute on function public.get_player_profile(text, text) from public, anon, authenticated;
revoke execute on function public.get_hon_khi_leaderboard(text, text, integer) from public, anon, authenticated;
revoke execute on function public.draw_hon_khi_with_session(text, text, text) from public, anon, authenticated;
grant execute on function public.get_player_profile(text, text) to service_role;
grant execute on function public.get_hon_khi_leaderboard(text, text, integer) to service_role;
grant execute on function public.draw_hon_khi_with_session(text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
