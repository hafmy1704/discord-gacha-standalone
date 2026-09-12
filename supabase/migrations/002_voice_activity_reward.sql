begin;

drop function if exists public.enroll_player(text, text, boolean);

create table if not exists public.guild_config (
  guild_id           text primary key,
  channel_ids        text[] not null default '{}'::text[],
  welcome_message_id text
);

create table if not exists public.players (
  guild_id         text        not null,
  user_id          text        not null,
  cultivation_xp   bigint      not null default 0 check (cultivation_xp >= 0),
  soul_orders      bigint      not null default 0 check (soul_orders >= 0),
  vault_xp         bigint      not null default 0 check (vault_xp >= 0),
  created_at       timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists public.hon_khi_catalog (
  item_code   text primary key check (item_code ~ '^t[0-9]+_[a-z0-9-]+_base$'),
  tier        integer        not null check (tier between 1 and 10),
  slot        text           not null check (slot in (
    'weapon', 'offhand', 'crown', 'armor', 'bracer', 'belt', 'boots',
    'necklace', 'ring', 'talisman', 'treasure', 'seal'
  )),
  name        text           not null check (char_length(name) between 1 and 160),
  slot_budget numeric(10, 4) not null check (slot_budget > 0),
  asset_key   text,
  unique (tier, slot)
);

create table if not exists public.hon_khi_equipped (
  guild_id    text          not null,
  user_id     text          not null,
  slot        text          not null check (slot in (
    'weapon', 'offhand', 'crown', 'armor', 'bracer', 'belt', 'boots',
    'necklace', 'ring', 'talisman', 'treasure', 'seal'
  )),
  item_code   text          not null references public.hon_khi_catalog(item_code),
  tier        integer       not null check (tier between 1 and 10),
  age_years   integer       not null check (age_years > 0),
  stats       jsonb         not null default '{}'::jsonb,
  power       numeric(18,2) not null check (power >= 0),
  acquired_at timestamptz   not null default now(),
  primary key (guild_id, user_id, slot)
);

create table if not exists public.user_hon_khi_collection (
  guild_id  text   not null,
  user_id   text   not null,
  item_code text   not null references public.hon_khi_catalog(item_code) on delete cascade,
  roll_count bigint not null default 1 check (roll_count >= 1),
  primary key (guild_id, user_id, item_code)
);

create table if not exists public.user_activity_log (
  id         bigint generated always as identity primary key,
  guild_id   text        not null,
  user_id    text        not null,
  event_type text        not null check (event_type in (
    'enroll', 'awakening', 'chat_reward', 'voice_reward', 'gacha_roll',
    'admin_grant'
  )),
  request_id text,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Durable effect receipts are intentionally separate from the one-month
-- activity feed. Deleting presentation/history rows must never make an old
-- externally supplied request identifier executable again.
create table if not exists public.request_receipts (
  guild_id   text        not null,
  event_type text        not null check (event_type in (
    'chat_reward', 'voice_reward', 'gacha_roll', 'admin_grant'
  )),
  request_id text        not null,
  user_id    text        not null,
  result     jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, event_type, request_id)
);

create unique index if not exists user_activity_log_request_idx
  on public.user_activity_log (guild_id, event_type, request_id)
  where request_id is not null;

create index if not exists user_activity_log_user_time_idx
  on public.user_activity_log (guild_id, user_id, created_at desc);

create index if not exists user_activity_log_event_time_idx
  on public.user_activity_log (guild_id, user_id, event_type, created_at desc);

create index if not exists user_activity_log_created_at_idx
  on public.user_activity_log (created_at);

create or replace function public.fingerprint_distance(a text, b text)
returns integer
language sql
immutable
as $$
  select case
    when a is null or b is null then 64
    else length(replace(
      ((('x' || lpad(a, 16, '0'))::bit(64)) # (('x' || lpad(b, 16, '0'))::bit(64)))::text,
      '0',
      ''
    ))
  end;
$$;

create or replace function public.cultivation_level(p_xp bigint)
returns integer
language plpgsql
immutable
as $$
declare
  completed_steps bigint;
  discriminant numeric;
begin
  if p_xp is null or p_xp < 0 then
    raise exception using message = 'invalid_cultivation_xp';
  end if;

  -- 50 * L * (L + 1) <= XP. Reduce XP first so the discriminant remains
  -- exact for every bigint input, then solve the quadratic in constant time.
  completed_steps := p_xp / 50;
  discriminant := 1::numeric + 4::numeric * completed_steps;
  return greatest(0, floor((1::numeric + sqrt(discriminant)) / 2)::integer - 1);
end;
$$;

create or replace function public.cultivation_points(p_xp bigint)
returns bigint
language sql
immutable
as $$
  select (
    p_xp::numeric
      - 50::numeric
        * public.cultivation_level(p_xp)
        * (public.cultivation_level(p_xp) + 1)
  )::bigint;
$$;

create or replace function public.hon_khi_vault_cost(p_level integer)
returns bigint
language plpgsql
immutable
as $$
begin
  if p_level is null or p_level < 1 then
    raise exception using message = 'invalid_vault_level';
  end if;

  return (100 * power(2::numeric, p_level - 1))::bigint;
end;
$$;

create or replace function public.hon_khi_vault_level(p_xp bigint)
returns integer
language plpgsql
immutable
as $$
declare
  level integer := 1;
  spent bigint := 0;
  cost bigint;
begin
  if p_xp is null or p_xp < 0 then
    raise exception using message = 'invalid_vault_xp';
  end if;

  loop
    cost := public.hon_khi_vault_cost(level);
    -- Compare against the remaining balance so spent + cost cannot overflow
    -- at the upper edge of bigint.
    exit when cost > p_xp - spent;
    spent := spent + cost;
    level := level + 1;
  end loop;

  return level;
end;
$$;

create or replace function public.hon_khi_tier_rates(p_vault_level integer)
returns jsonb
language plpgsql
immutable
as $$
declare
  first_rate numeric;
  max_tier integer;
  decay numeric;
  weight_total numeric := 0;
  tier_number integer;
  tier_rate numeric;
  result jsonb := '[]'::jsonb;
begin
  if p_vault_level is null or p_vault_level < 1 then
    raise exception using message = 'invalid_vault_level';
  end if;

  first_rate := greatest(0::numeric, 0.90 - 0.10 * (p_vault_level - 1));
  max_tier := least(10, greatest(2, p_vault_level));
  decay := least(0.65, 0.20 + 0.05 * greatest(0, p_vault_level - 3));

  for tier_number in 2..max_tier loop
    weight_total := weight_total + power(decay, tier_number - 2);
  end loop;

  for tier_number in 1..10 loop
    if tier_number = 1 then
      tier_rate := first_rate;
    elsif tier_number <= max_tier then
      tier_rate := (1 - first_rate) * power(decay, tier_number - 2) / weight_total;
    else
      tier_rate := 0;
    end if;

    result := result || jsonb_build_array(
      jsonb_build_object('tier', tier_number, 'rate', round(tier_rate, 8))
    );
  end loop;

  return result;
end;
$$;

create or replace function public.hon_khi_slot_label(p_slot text)
returns text
language sql
immutable
as $$
  select case p_slot
    when 'weapon' then 'Vũ Khí'
    when 'offhand' then 'Phó Khí'
    when 'crown' then 'Hồn Quan'
    when 'armor' then 'Hộ Giáp'
    when 'bracer' then 'Hộ Uyển'
    when 'belt' then 'Hồn Đai'
    when 'boots' then 'Linh Ngoa'
    when 'necklace' then 'Hồn Liên'
    when 'ring' then 'Hồn Giới'
    when 'talisman' then 'Hộ Phù'
    when 'treasure' then 'Bí Bảo'
    when 'seal' then 'Hồn Ấn'
    else p_slot
  end;
$$;

create or replace function public.ensure_guild_config(
  p_guild_id text,
  p_channels text[] default '{}'::text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.guild_config (guild_id, channel_ids)
  values (p_guild_id, p_channels)
  on conflict (guild_id) do nothing;
end;
$$;

create or replace function public.set_reward_channel(
  p_guild_id  text,
  p_channel_id text,
  p_enabled    boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  config_row public.guild_config%rowtype;
  changed boolean;
begin
  if p_guild_id is null or length(p_guild_id) < 1
     or p_channel_id is null or length(p_channel_id) < 1
     or p_enabled is null then
    raise exception using message = 'invalid_channel_id';
  end if;

  select * into config_row
  from public.guild_config
  where guild_id = p_guild_id
  for update;
  if not found then
    raise exception using message = 'guild_not_configured';
  end if;

  if p_enabled then
    changed := not (p_channel_id = any(config_row.channel_ids));
    if changed then
      config_row.channel_ids := array_append(config_row.channel_ids, p_channel_id);
    end if;
  else
    changed := p_channel_id = any(config_row.channel_ids);
    if changed then
      config_row.channel_ids := array_remove(config_row.channel_ids, p_channel_id);
    end if;
  end if;

  if changed then
    update public.guild_config
    set channel_ids = config_row.channel_ids
    where guild_id = p_guild_id;
  end if;

  return jsonb_build_object(
    'changed', changed,
    'channel_ids', to_jsonb(config_row.channel_ids)
  );
end;
$$;

create or replace function public.enroll_player(
  p_guild_id text,
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row public.players%rowtype;
  created boolean := false;
begin
  insert into public.players (guild_id, user_id)
  values (p_guild_id, p_user_id)
  on conflict (guild_id, user_id) do nothing
  returning * into player_row;

  if found then
    created := true;
  else
    select * into player_row
    from public.players
    where guild_id = p_guild_id and user_id = p_user_id;
  end if;

  insert into public.user_activity_log
    (guild_id, user_id, event_type, payload)
  values
    (p_guild_id, p_user_id, 'enroll',
     jsonb_build_object('created', created));

  return jsonb_build_object(
    'created', created,
    'soul_orders', player_row.soul_orders
  );
end;
$$;

create or replace function public.adjust_soul_orders(
  p_guild_id  text,
  p_user_id   text,
  p_amount    integer,
  p_source_id text,
  p_reason    text default 'admin_grant',
  p_admin_id  text default null,
  p_delta     integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row   public.players%rowtype;
  old_event    public.user_activity_log%rowtype;
  receipt_row  public.request_receipts%rowtype;
  new_orders   bigint;
  response_json jsonb;
begin
  if p_amount < 1 or p_amount > 1000000 or p_delta not in (-1, 1) then
    raise exception using message = 'invalid_amount';
  end if;
  if p_source_id is null or length(p_source_id) < 1 or length(p_source_id) > 128 then
    raise exception using message = 'invalid_source_id';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_guild_id, 'admin_grant', p_source_id),
      0
    )
  );

  select * into receipt_row
  from public.request_receipts
  where guild_id = p_guild_id
    and event_type = 'admin_grant'
    and request_id = p_source_id;
  if found then
    if receipt_row.user_id <> p_user_id then
      raise exception using message = 'invalid_source_id';
    end if;
    return receipt_row.result || jsonb_build_object('duplicate', true);
  end if;

  -- Compatibility with installations upgraded from an earlier schema. A
  -- replay of a still-retained legacy activity row promotes it to a receipt.
  select * into old_event
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'admin_grant'
    and request_id = p_source_id;
  if found then
    if old_event.user_id <> p_user_id then
      raise exception using message = 'invalid_source_id';
    end if;
    response_json := jsonb_build_object(
      'duplicate', false,
      'soul_orders', (old_event.payload ->> 'soulOrdersAfter')::bigint
    );
    insert into public.request_receipts
      (guild_id, event_type, request_id, user_id, result)
    values
      (p_guild_id, 'admin_grant', p_source_id, p_user_id, response_json);
    return response_json || jsonb_build_object('duplicate', true);
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;
  if not found then
    raise exception using message = 'not_enrolled';
  end if;

  new_orders := player_row.soul_orders + (p_amount::bigint * p_delta);
  if new_orders < 0 then
    raise exception using message = 'insufficient_soul_orders';
  end if;

  update public.players
  set soul_orders = new_orders
  where guild_id = p_guild_id and user_id = p_user_id;

  response_json := jsonb_build_object(
    'duplicate', false,
    'soul_orders', new_orders
  );

  insert into public.request_receipts
    (guild_id, event_type, request_id, user_id, result)
  values
    (p_guild_id, 'admin_grant', p_source_id, p_user_id, response_json);

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'admin_grant', p_source_id,
     jsonb_build_object(
       'operation', case when p_delta = 1 then 'add' else 'remove' end,
       'amount', p_amount,
       'reason', p_reason,
       'adminUserId', p_admin_id,
       'soulOrdersAfter', new_orders
     ));

  return response_json;
end;
$$;

create or replace function public.grant_soul_orders(
  p_guild_id  text,
  p_user_id   text,
  p_amount    integer,
  p_source_id text,
  p_reason    text default 'admin_grant',
  p_admin_id  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.adjust_soul_orders(
    p_guild_id, p_user_id, p_amount, p_source_id, p_reason, p_admin_id, 1
  );
end;
$$;

create or replace function public.remove_soul_orders(
  p_guild_id  text,
  p_user_id   text,
  p_amount    integer,
  p_source_id text,
  p_reason    text default 'admin_remove',
  p_admin_id  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.adjust_soul_orders(
    p_guild_id, p_user_id, p_amount, p_source_id, p_reason, p_admin_id, -1
  );
end;
$$;

create or replace function public.get_total_hon_khi_rolls(
  p_guild_id text,
  p_user_id  text
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(roll_count), 0)::bigint
  from public.user_hon_khi_collection
  where guild_id = p_guild_id and user_id = p_user_id;
$$;

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
      / (100 * (cultivation_level + 1)),
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
    'soulOrders', player_row.soul_orders,
    'cultivationLevel', cultivation_level,
    'cultivationPoints', public.cultivation_points(player_row.cultivation_xp),
    'cultivationPointsRequired', 100::bigint * (cultivation_level + 1),
    'cultivationProgress', cultivation_progress,
    'vaultXp', player_row.vault_xp,
    'vaultLevel', public.hon_khi_vault_level(player_row.vault_xp),
    'equipmentPower', equipment_power,
    'power', cultivation_level::numeric * 100 + equipment_power,
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
  vault_progress_xp       bigint;
  vault_progress          numeric;
begin
  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id;

  if not found then
    raise exception using message = 'not_enrolled';
  end if;

  vault_level := public.hon_khi_vault_level(player_row.vault_xp);
  upgrade_cost := public.hon_khi_vault_cost(vault_level);
  vault_progress_xp := greatest(
    0::bigint,
    player_row.vault_xp
      - (100 * (power(2::numeric, vault_level - 1) - 1))::bigint
  );
  vault_progress := round(
    least(1::numeric, vault_progress_xp::numeric / upgrade_cost) * 100,
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
    'vaultXp', player_row.vault_xp,
    'vaultLevel', vault_level,
    'upgradeCost', upgrade_cost,
    'vaultProgressXp', vault_progress_xp,
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

create or replace function public.cleanup_user_activity_log()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from public.user_activity_log
  where created_at < now() - interval '1 month';

  get diagnostics removed = row_count;
  return removed;
end;
$$;

create or replace function public.draw_hon_khi(
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
  player_row         public.players%rowtype;
  player_after       public.players%rowtype;
  activity_row       public.user_activity_log%rowtype;
  receipt_row        public.request_receipts%rowtype;
  old_equipped       public.hon_khi_equipped%rowtype;
  catalog_row        public.hon_khi_catalog%rowtype;
  rolled_tier        integer;
  max_tier           integer;
  tier_number        integer;
  first_rate         numeric;
  decay              numeric;
  weight_total       numeric := 0;
  pick_value         numeric;
  age_min            integer;
  age_max            integer;
  age_years          integer;
  age_factor         numeric;
  budget             numeric;
  attack_weight      numeric;
  hp_weight          numeric;
  accuracy_weight    numeric;
  attack_value       numeric;
  hp_value           numeric;
  accuracy_value     numeric;
  special_key_1      text;
  special_key_2      text;
  special_value_1    numeric;
  special_value_2    numeric;
  basic_stats        jsonb;
  special_stats      jsonb;
  stats_json         jsonb;
  power_value        numeric;
  old_item_code      text;
  old_power          numeric;
  salvage_total      bigint := 0;
  disposition        text;
  activity_payload   jsonb;
  last_roll_at       timestamptz;
  vault_level_before integer;
  vault_level_after  integer;
begin
  if p_guild_id is null or p_user_id is null or p_request_id is null
     or length(p_request_id) < 8 or length(p_request_id) > 128
     or p_request_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using message = 'invalid_request_id';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_guild_id, 'gacha_roll', p_request_id),
      0
    )
  );

  select * into receipt_row
  from public.request_receipts
  where guild_id = p_guild_id
    and event_type = 'gacha_roll'
    and request_id = p_request_id;
  if found then
    if receipt_row.user_id <> p_user_id then
      raise exception using message = 'invalid_request_id';
    end if;
    return receipt_row.result || jsonb_build_object('replayed', true);
  end if;

  -- Promote a retained pre-receipt activity row when upgrading an existing DB.
  select * into activity_row
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'gacha_roll'
    and request_id = p_request_id;

  if found then
    if activity_row.user_id <> p_user_id then
      raise exception using message = 'invalid_request_id';
    end if;
    insert into public.request_receipts
      (guild_id, event_type, request_id, user_id, result)
    values
      (p_guild_id, 'gacha_roll', p_request_id, p_user_id, activity_row.payload);
    return activity_row.payload || jsonb_build_object('replayed', true);
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if not found then
    raise exception using message = 'not_enrolled';
  end if;

  select max(created_at) into last_roll_at
  from public.user_activity_log
  where guild_id = p_guild_id
    and user_id = p_user_id
    and event_type = 'gacha_roll';

  if last_roll_at is not null and clock_timestamp() < last_roll_at + interval '4 seconds' then
    raise exception using message = 'gacha_cooldown';
  end if;

  if player_row.soul_orders < 1 then
    raise exception using message = 'insufficient_soul_orders';
  end if;

  vault_level_before := public.hon_khi_vault_level(player_row.vault_xp);
  first_rate := greatest(0::numeric, 0.90 - 0.10 * (vault_level_before - 1));
  max_tier := least(10, greatest(2, vault_level_before));
  decay := least(0.65, 0.20 + 0.05 * greatest(0, vault_level_before - 3));

  if random()::numeric < first_rate then
    rolled_tier := 1;
  else
    for tier_number in 2..max_tier loop
      weight_total := weight_total + power(decay, tier_number - 2);
    end loop;

    pick_value := random()::numeric * weight_total;
    rolled_tier := max_tier;
    for tier_number in 2..max_tier loop
      pick_value := pick_value - power(decay, tier_number - 2);
      if pick_value < 0 then
        rolled_tier := tier_number;
        exit;
      end if;
    end loop;
  end if;

  select * into catalog_row
  from public.hon_khi_catalog
  where tier = rolled_tier
  order by random()
  limit 1;

  if not found then
    raise exception using message = 'gacha_empty';
  end if;

  age_min := (50 * power(2::numeric, rolled_tier - 1))::integer;
  age_max := age_min * 2;
  age_years := age_min + floor(random()::numeric * (age_max - age_min + 1))::integer;
  age_factor := round(0.85 + 0.30 * ((age_years - age_min)::numeric / (age_max - age_min)), 4);
  budget := round(100 * catalog_row.slot_budget * power(1.6::numeric, rolled_tier - 1) * age_factor, 4);

  if catalog_row.slot in ('weapon', 'offhand', 'bracer', 'ring') then
    attack_weight := 0.50;
    hp_weight := 0.25;
    accuracy_weight := 0.25;
  elsif catalog_row.slot in ('crown', 'armor', 'belt', 'talisman') then
    attack_weight := 0.25;
    hp_weight := 0.50;
    accuracy_weight := 0.25;
  else
    attack_weight := 0.25;
    hp_weight := 0.25;
    accuracy_weight := 0.50;
  end if;

  attack_value := round(budget * attack_weight, 2);
  hp_value := round(budget * hp_weight, 2);
  accuracy_value := round(budget * accuracy_weight, 2);
  basic_stats := jsonb_build_object(
    'attack', attack_value,
    'hp', hp_value,
    'accuracy', accuracy_value
  );

  select option_key into special_key_1
  from unnest(array[
    'basicPower', 'skillPower', 'ultimatePower', 'speed',
    'critRate', 'critDamage', 'skillHaste', 'evasion'
  ]) as options(option_key)
  order by random()
  limit 1;

  select option_key into special_key_2
  from unnest(array[
    'basicPower', 'skillPower', 'ultimatePower', 'speed',
    'critRate', 'critDamage', 'skillHaste', 'evasion'
  ]) as options(option_key)
  where option_key <> special_key_1
  order by random()
  limit 1;

  special_value_1 := round((1.5 + random()::numeric * 4.5) * rolled_tier, 2);
  special_value_2 := round((1.5 + random()::numeric * 4.5) * rolled_tier, 2);
  special_stats := jsonb_build_object(
    special_key_1, special_value_1,
    special_key_2, special_value_2
  );
  stats_json := basic_stats || special_stats;
  power_value := round(
    attack_value + hp_value + accuracy_value
      + 2 * (special_value_1 + special_value_2),
    2
  );

  select * into old_equipped
  from public.hon_khi_equipped
  where guild_id = p_guild_id
    and user_id = p_user_id
    and slot = catalog_row.slot
  for update;

  if found then
    old_item_code := old_equipped.item_code;
    old_power := old_equipped.power;
  end if;

  if old_item_code is null or power_value > old_power then
    disposition := case
      when old_item_code is null then 'equipped'
      else 'replaced'
    end;

    if old_item_code is not null then
      salvage_total := old_equipped.age_years;
    end if;

    insert into public.hon_khi_equipped
      (guild_id, user_id, slot, item_code, tier, age_years, stats, power)
    values
      (p_guild_id, p_user_id, catalog_row.slot, catalog_row.item_code,
       rolled_tier, age_years, stats_json, power_value)
    on conflict (guild_id, user_id, slot) do update set
      item_code = excluded.item_code,
      tier = excluded.tier,
      age_years = excluded.age_years,
      stats = excluded.stats,
      power = excluded.power,
      acquired_at = now();
  else
    disposition := 'salvaged';
    salvage_total := age_years;
  end if;

  update public.players
  set soul_orders = player_row.soul_orders - 1,
      vault_xp = player_row.vault_xp + salvage_total
  where guild_id = p_guild_id and user_id = p_user_id;

  select * into player_after
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id;

  vault_level_after := public.hon_khi_vault_level(player_after.vault_xp);

  insert into public.user_hon_khi_collection
    (guild_id, user_id, item_code, roll_count)
  values
    (p_guild_id, p_user_id, catalog_row.item_code, 1)
  on conflict (guild_id, user_id, item_code) do update
    set roll_count = public.user_hon_khi_collection.roll_count + 1;

  activity_payload := jsonb_build_object(
    'requestId', p_request_id,
    'itemCode', catalog_row.item_code,
    'slot', catalog_row.slot,
    'tier', rolled_tier,
    'ageYears', age_years,
    'stats', stats_json,
    'power', power_value,
    'disposition', disposition,
    'replacedItemCode', old_item_code,
    'salvageSteel', salvage_total,
    'soulOrdersAfter', player_after.soul_orders,
    'vaultXpAfter', player_after.vault_xp,
    'vaultLevelBefore', vault_level_before,
    'vaultLevelAfter', vault_level_after,
    'replayed', false
  );

  insert into public.request_receipts
    (guild_id, event_type, request_id, user_id, result)
  values
    (p_guild_id, 'gacha_roll', p_request_id, p_user_id, activity_payload);

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'gacha_roll', p_request_id, activity_payload);

  return activity_payload;
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
        public.cultivation_level(p.cultivation_xp)::numeric * 100
        + coalesce(sum(e.power), 0),
        2
      ) as power,
      coalesce(max(e.tier), 0) as highest_tier,
      row_number() over (
        order by
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

create or replace function public.award_chat_message(
  p_guild_id       text,
  p_user_id        text,
  p_message_id     text,
  p_fingerprint    text,
  p_unique_chars   integer,
  p_sentence_count integer,
  p_is_reply       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row        public.players%rowtype;
  old_event         public.user_activity_log%rowtype;
  receipt_row       public.request_receipts%rowtype;
  last_reward_at    timestamptz;
  cooldown_ms       constant bigint := 60000;
  base_pts          integer;
  bonus_pts         integer;
  pts_gain          integer := 0;
  orders_gain       integer := 0;
  new_pts           bigint;
  new_xp            bigint;
  old_lvl           integer;
  old_pts           bigint;
  new_lvl           integer;
  new_orders        bigint;
  skip              boolean := false;
  skip_reason       text;
  activity_payload  jsonb;
  response_json     jsonb;
begin
  if p_message_id is null or length(p_message_id) < 1 or length(p_message_id) > 128 then
    raise exception using message = 'invalid_message_id';
  end if;
  if p_fingerprint is not null and p_fingerprint !~ '^[0-9a-f]{16}$' then
    raise exception using message = 'invalid_fingerprint';
  end if;
  if p_unique_chars is null or p_unique_chars < 0
     or p_sentence_count is null or p_sentence_count < 1
     or p_is_reply is null then
    raise exception using message = 'invalid_chat_metrics';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_guild_id, 'chat_reward', p_message_id),
      0
    )
  );

  select * into receipt_row
  from public.request_receipts
  where guild_id = p_guild_id
    and event_type = 'chat_reward'
    and request_id = p_message_id;
  if found then
    if receipt_row.user_id <> p_user_id then
      raise exception using message = 'invalid_message_id';
    end if;
    return receipt_row.result || jsonb_build_object('duplicate', true);
  end if;

  -- Promote a retained pre-receipt activity row when upgrading an existing DB.
  select * into old_event
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'chat_reward'
    and request_id = p_message_id;

  if found then
    if old_event.user_id <> p_user_id then
      raise exception using message = 'invalid_message_id';
    end if;
    response_json := jsonb_build_object(
      'skipped', coalesce((old_event.payload ->> 'skipped')::boolean, false),
      'duplicate', false,
      'cultivation_points', coalesce((old_event.payload ->> 'cultivationPoints')::integer, 0),
      'soul_orders', coalesce((old_event.payload ->> 'soulOrders')::integer, 0)
    );
    insert into public.request_receipts
      (guild_id, event_type, request_id, user_id, result)
    values
      (p_guild_id, 'chat_reward', p_message_id, p_user_id, response_json);
    return response_json || jsonb_build_object('duplicate', true);
  end if;

  if not exists (
    select 1 from public.guild_config where guild_id = p_guild_id
  ) then
    raise exception using message = 'guild_not_configured';
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if not found then
    skip := true;
    skip_reason := 'not_enrolled';
  end if;

  if not skip then
    old_lvl := public.cultivation_level(player_row.cultivation_xp);
    old_pts := public.cultivation_points(player_row.cultivation_xp);
  end if;

  if not skip then
    select max(created_at) into last_reward_at
    from public.user_activity_log
    where guild_id = p_guild_id
      and user_id = p_user_id
      and event_type = 'chat_reward'
      and coalesce((payload ->> 'skipped')::boolean, false) = false;

    if last_reward_at is not null
       and extract(epoch from (now() - last_reward_at)) * 1000 < cooldown_ms then
      skip := true;
      skip_reason := 'cooldown';
    end if;

    if not skip and p_fingerprint is not null and exists (
      select 1
      from public.user_activity_log
      where guild_id = p_guild_id
        and user_id = p_user_id
        and event_type = 'chat_reward'
        and coalesce((payload ->> 'skipped')::boolean, false) = false
        and payload ->> 'fingerprint' is not null
        and created_at >= now() - interval '10 minutes'
        and public.fingerprint_distance(payload ->> 'fingerprint', p_fingerprint) <= 4
    ) then
      skip := true;
      skip_reason := 'duplicate_content';
    end if;
  end if;

  if not skip then
    base_pts := 12;
    bonus_pts := least(6, greatest(0, (p_unique_chars - 8) / 4))
      + case when p_sentence_count >= 2 then 1 else 0 end
      + case when p_is_reply then 1 else 0 end;
    pts_gain := least(20, base_pts + bonus_pts);
    orders_gain := 1;
    new_xp := player_row.cultivation_xp + pts_gain;
    new_lvl := public.cultivation_level(new_xp);
    new_pts := public.cultivation_points(new_xp);
    new_orders := player_row.soul_orders + orders_gain;

    update public.players
    set cultivation_xp = new_xp,
        soul_orders = new_orders
    where guild_id = p_guild_id and user_id = p_user_id;
  end if;

  activity_payload := jsonb_build_object(
    'messageId', p_message_id,
    'fingerprint', p_fingerprint,
    'cultivationPoints', pts_gain,
    'soulOrders', orders_gain,
    'cultivationAfter', coalesce(new_pts, old_pts, 0),
    'soulOrdersAfter', coalesce(new_orders, player_row.soul_orders, 0),
    'skipped', skip,
    'skipReason', skip_reason
  );

  response_json := jsonb_build_object(
    'skipped', skip,
    'skip_reason', skip_reason,
    'duplicate', false,
    'cultivation_points', pts_gain,
    'soul_orders', orders_gain,
    'new_level', coalesce(new_lvl, old_lvl),
    'leveled_up', coalesce(new_lvl > old_lvl, false)
  );

  insert into public.request_receipts
    (guild_id, event_type, request_id, user_id, result)
  values
    (p_guild_id, 'chat_reward', p_message_id, p_user_id, response_json);

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'chat_reward', p_message_id, activity_payload);

  return response_json;
end;
$$;

alter table public.guild_config           enable row level security;
alter table public.players                enable row level security;
alter table public.hon_khi_catalog        enable row level security;
alter table public.hon_khi_equipped       enable row level security;
alter table public.user_hon_khi_collection enable row level security;
alter table public.user_activity_log      enable row level security;
alter table public.request_receipts       enable row level security;

revoke all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log,
  public.request_receipts
from public, anon, authenticated;

grant all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log,
  public.request_receipts
to service_role;

revoke execute on function
  public.fingerprint_distance(text, text),
  public.cultivation_level(bigint),
  public.cultivation_points(bigint),
  public.hon_khi_vault_cost(integer),
  public.hon_khi_vault_level(bigint),
  public.hon_khi_tier_rates(integer),
  public.hon_khi_slot_label(text),
  public.ensure_guild_config(text, text[]),
  public.set_reward_channel(text, text, boolean),
  public.enroll_player(text, text),
  public.adjust_soul_orders(text, text, integer, text, text, text, integer),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.remove_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_player_profile(text, text),
  public.get_hon_khi_session(text, text),
  public.get_hon_khi_leaderboard(text, text, integer),
  public.draw_hon_khi_with_session(text, text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.award_chat_message(text, text, text, text, integer, integer, boolean)
from public, anon, authenticated;

grant execute on function
  public.fingerprint_distance(text, text),
  public.cultivation_level(bigint),
  public.cultivation_points(bigint),
  public.hon_khi_vault_cost(integer),
  public.hon_khi_vault_level(bigint),
  public.hon_khi_tier_rates(integer),
  public.hon_khi_slot_label(text),
  public.ensure_guild_config(text, text[]),
  public.set_reward_channel(text, text, boolean),
  public.enroll_player(text, text),
  public.adjust_soul_orders(text, text, integer, text, text, text, integer),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.remove_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_player_profile(text, text),
  public.get_hon_khi_session(text, text),
  public.get_hon_khi_leaderboard(text, text, integer),
  public.draw_hon_khi_with_session(text, text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.award_chat_message(text, text, text, text, integer, integer, boolean)
to service_role;




alter table public.players add column if not exists last_voice_reward_at timestamptz;

create table if not exists public.voice_reward_buckets (
  guild_id text not null,
  user_id text not null,
  bucket_start timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, user_id, bucket_start),
  foreign key (guild_id, user_id) references public.players(guild_id, user_id) on delete cascade
);

create table if not exists public.level_up_events (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  level integer not null check (level >= 1),
  cultivation_xp bigint not null check (cultivation_xp >= 0),
  source_request_id text,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claim_token text,
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (guild_id, user_id, level),
  foreign key (guild_id, user_id) references public.players(guild_id, user_id) on delete cascade
);
create index if not exists level_up_events_status_idx on public.level_up_events(status, created_at);

create or replace function public.queue_level_up_events(p_guild_id text, p_user_id text, p_old_level integer, p_new_level integer, p_cultivation_xp bigint, p_source_request_id text)
returns void language sql security definer set search_path = public as $$
  insert into public.level_up_events (guild_id, user_id, level, cultivation_xp, source_request_id)
  select p_guild_id, p_user_id, level, p_cultivation_xp, p_source_request_id
  from generate_series(p_old_level + 1, p_new_level) as level
  where p_new_level > p_old_level
  on conflict (guild_id, user_id, level) do nothing;
$$;

create or replace function public.set_voice_session(p_guild_id text, p_user_id text, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  update public.players
  set last_voice_reward_at = case when p_active then now() else null end
  where guild_id = p_guild_id and user_id = p_user_id;
  get diagnostics v_count = row_count;
  return jsonb_build_object('updated', v_count > 0, 'active', p_active);
end;
$$;

create or replace function public.award_voice_activity(p_guild_id text, p_user_id text, p_channel_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  player_row public.players%rowtype;
  old_level integer;
  new_level integer;
  new_xp bigint;
  new_orders bigint;
  bucket_count integer;
  awarded_buckets integer;
  reward_until timestamptz;
  request_id text;
begin
  if p_channel_id is null or length(p_channel_id) < 1 or length(p_channel_id) > 128 then
    raise exception using message = 'invalid_channel_id';
  end if;
  select * into player_row from public.players
  where guild_id = p_guild_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('skipped', true, 'skip_reason', 'not_enrolled', 'buckets', 0, 'leveled_up', false);
  end if;
  if player_row.last_voice_reward_at is null then
    update public.players set last_voice_reward_at = now()
    where guild_id = p_guild_id and user_id = p_user_id;
    return jsonb_build_object('skipped', true, 'skip_reason', 'session_started', 'buckets', 0, 'leveled_up', false);
  end if;
  bucket_count := floor(extract(epoch from (now() - player_row.last_voice_reward_at)) / 600)::integer;
  if bucket_count < 1 then
    return jsonb_build_object('skipped', true, 'skip_reason', 'not_due', 'buckets', 0, 'leveled_up', false);
  end if;
  reward_until := player_row.last_voice_reward_at + bucket_count * interval '10 minutes';
  request_id := format('voice:%s:%s', p_user_id, extract(epoch from reward_until)::bigint);
  insert into public.voice_reward_buckets (guild_id, user_id, bucket_start)
  select p_guild_id, p_user_id, player_row.last_voice_reward_at + sequence * interval '10 minutes'
  from generate_series(1, bucket_count) as sequence
  on conflict (guild_id, user_id, bucket_start) do nothing;
  get diagnostics awarded_buckets = row_count;
  update public.players
  set cultivation_xp = cultivation_xp + awarded_buckets * 10,
      soul_orders = soul_orders + awarded_buckets,
      last_voice_reward_at = reward_until
  where guild_id = p_guild_id and user_id = p_user_id
  returning cultivation_xp, soul_orders into new_xp, new_orders;
  old_level := public.cultivation_level(player_row.cultivation_xp);
  new_level := public.cultivation_level(new_xp);
  perform public.queue_level_up_events(p_guild_id, p_user_id, old_level, new_level, new_xp, request_id);
  insert into public.user_activity_log (guild_id, user_id, event_type, request_id, payload)
  values (p_guild_id, p_user_id, 'voice_reward', request_id, jsonb_build_object(
    'channelId', p_channel_id, 'buckets', awarded_buckets,
    'cultivationPoints', awarded_buckets * 10, 'soulOrders', awarded_buckets,
    'rewardUntil', reward_until));
  return jsonb_build_object(
    'skipped', awarded_buckets = 0,
    'skip_reason', case when awarded_buckets = 0 then 'duplicate_bucket' else null end,
    'buckets', awarded_buckets, 'cultivation_points', awarded_buckets * 10,
    'soul_orders', awarded_buckets, 'new_level', new_level,
    'leveled_up', new_level > old_level);
end;
$$;

create or replace function public.claim_level_up_events(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_claim_token text := md5(random()::text || clock_timestamp()::text);
  claimed jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using message = 'invalid_event_limit';
  end if;
  with candidates as (
    select id from public.level_up_events
    where status = 'pending'
       or (status = 'claimed' and claimed_at < now() - interval '2 minutes')
       or (status = 'failed' and attempts < 10)
    order by created_at limit p_limit for update skip locked
  ), updated as (
    update public.level_up_events event
    set status = 'claimed', claim_token = v_claim_token, claimed_at = now(), attempts = attempts + 1
    from candidates where event.id = candidates.id
    returning event.id, event.user_id, event.level, event.cultivation_xp, event.claim_token
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'level', level, 'cultivation_xp', cultivation_xp, 'claim_token', claim_token)), '[]'::jsonb)
  into claimed from updated;
  return claimed;
end;
$$;

create or replace function public.mark_level_up_event_sent(p_event_id bigint, p_claim_token text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.level_up_events set status = 'sent', sent_at = now(), claim_token = null, claimed_at = null
  where id = p_event_id and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.mark_level_up_event_failed(p_event_id bigint, p_claim_token text, p_error text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.level_up_events set status = 'failed', claim_token = null, claimed_at = null, last_error = left(p_error, 500)
  where id = p_event_id and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.award_chat_message(
  p_guild_id       text,
  p_user_id        text,
  p_message_id     text,
  p_fingerprint    text,
  p_unique_chars   integer,
  p_sentence_count integer,
  p_is_reply       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row        public.players%rowtype;
  old_event         public.user_activity_log%rowtype;
  receipt_row       public.request_receipts%rowtype;
  last_reward_at    timestamptz;
  cooldown_ms       constant bigint := 60000;
  base_pts          integer;
  bonus_pts         integer;
  pts_gain          integer := 0;
  orders_gain       integer := 0;
  new_pts           bigint;
  new_xp            bigint;
  old_lvl           integer;
  old_pts           bigint;
  new_lvl           integer;
  new_orders        bigint;
  skip              boolean := false;
  skip_reason       text;
  activity_payload  jsonb;
  response_json     jsonb;
begin
  if p_message_id is null or length(p_message_id) < 1 or length(p_message_id) > 128 then
    raise exception using message = 'invalid_message_id';
  end if;
  if p_fingerprint is not null and p_fingerprint !~ '^[0-9a-f]{16}$' then
    raise exception using message = 'invalid_fingerprint';
  end if;
  if p_unique_chars is null or p_unique_chars < 0
     or p_sentence_count is null or p_sentence_count < 1
     or p_is_reply is null then
    raise exception using message = 'invalid_chat_metrics';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_guild_id, 'chat_reward', p_message_id),
      0
    )
  );

  select * into receipt_row
  from public.request_receipts
  where guild_id = p_guild_id
    and event_type = 'chat_reward'
    and request_id = p_message_id;
  if found then
    if receipt_row.user_id <> p_user_id then
      raise exception using message = 'invalid_message_id';
    end if;
    return receipt_row.result || jsonb_build_object('duplicate', true);
  end if;

  -- Promote a retained pre-receipt activity row when upgrading an existing DB.
  select * into old_event
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'chat_reward'
    and request_id = p_message_id;

  if found then
    if old_event.user_id <> p_user_id then
      raise exception using message = 'invalid_message_id';
    end if;
    response_json := jsonb_build_object(
      'skipped', coalesce((old_event.payload ->> 'skipped')::boolean, false),
      'duplicate', false,
      'cultivation_points', coalesce((old_event.payload ->> 'cultivationPoints')::integer, 0),
      'soul_orders', coalesce((old_event.payload ->> 'soulOrders')::integer, 0)
    );
    insert into public.request_receipts
      (guild_id, event_type, request_id, user_id, result)
    values
      (p_guild_id, 'chat_reward', p_message_id, p_user_id, response_json);
    return response_json || jsonb_build_object('duplicate', true);
  end if;

  if not exists (
    select 1 from public.guild_config where guild_id = p_guild_id
  ) then
    raise exception using message = 'guild_not_configured';
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if not found then
    skip := true;
    skip_reason := 'not_enrolled';
  end if;

  if not skip then
    old_lvl := public.cultivation_level(player_row.cultivation_xp);
    old_pts := public.cultivation_points(player_row.cultivation_xp);
  end if;

  if not skip then
    select max(created_at) into last_reward_at
    from public.user_activity_log
    where guild_id = p_guild_id
      and user_id = p_user_id
      and event_type = 'chat_reward'
      and coalesce((payload ->> 'skipped')::boolean, false) = false;

    if last_reward_at is not null
       and extract(epoch from (now() - last_reward_at)) * 1000 < cooldown_ms then
      skip := true;
      skip_reason := 'cooldown';
    end if;

    if not skip and p_fingerprint is not null and exists (
      select 1
      from public.user_activity_log
      where guild_id = p_guild_id
        and user_id = p_user_id
        and event_type = 'chat_reward'
        and coalesce((payload ->> 'skipped')::boolean, false) = false
        and payload ->> 'fingerprint' is not null
        and created_at >= now() - interval '10 minutes'
        and public.fingerprint_distance(payload ->> 'fingerprint', p_fingerprint) <= 4
    ) then
      skip := true;
      skip_reason := 'duplicate_content';
    end if;
  end if;

  if not skip then
    base_pts := 12;
    bonus_pts := least(6, greatest(0, (p_unique_chars - 8) / 4))
      + case when p_sentence_count >= 2 then 1 else 0 end
      + case when p_is_reply then 1 else 0 end;
    pts_gain := least(20, base_pts + bonus_pts);
    orders_gain := 1;
    new_xp := player_row.cultivation_xp + pts_gain;
    new_lvl := public.cultivation_level(new_xp);
    new_pts := public.cultivation_points(new_xp);
    new_orders := player_row.soul_orders + orders_gain;

    update public.players
    set cultivation_xp = new_xp,
        soul_orders = new_orders
    where guild_id = p_guild_id and user_id = p_user_id;
  end if;

  activity_payload := jsonb_build_object(
    'messageId', p_message_id,
    'fingerprint', p_fingerprint,
    'cultivationPoints', pts_gain,
    'soulOrders', orders_gain,
    'cultivationAfter', coalesce(new_pts, old_pts, 0),
    'soulOrdersAfter', coalesce(new_orders, player_row.soul_orders, 0),
    'skipped', skip,
    'skipReason', skip_reason
  );

  response_json := jsonb_build_object(
    'skipped', skip,
    'skip_reason', skip_reason,
    'duplicate', false,
    'cultivation_points', pts_gain,
    'soul_orders', orders_gain,
    'new_level', coalesce(new_lvl, old_lvl),
    'leveled_up', coalesce(new_lvl > old_lvl, false)
  );

  insert into public.request_receipts
    (guild_id, event_type, request_id, user_id, result)
  values
    (p_guild_id, 'chat_reward', p_message_id, p_user_id, response_json);

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'chat_reward', p_message_id, activity_payload);

  perform public.queue_level_up_events(
    p_guild_id, p_user_id, old_lvl, new_lvl, new_xp, p_message_id
  );

  return response_json;
end;
$$;

alter table public.guild_config           enable row level security;
alter table public.players                enable row level security;
alter table public.hon_khi_catalog        enable row level security;
alter table public.hon_khi_equipped       enable row level security;
alter table public.user_hon_khi_collection enable row level security;
alter table public.user_activity_log      enable row level security;
alter table public.request_receipts       enable row level security;

revoke all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log,
  public.request_receipts
from public, anon, authenticated;

grant all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log,
  public.request_receipts
to service_role;

revoke execute on function
  public.fingerprint_distance(text, text),
  public.cultivation_level(bigint),
  public.cultivation_points(bigint),
  public.hon_khi_vault_cost(integer),
  public.hon_khi_vault_level(bigint),
  public.hon_khi_tier_rates(integer),
  public.hon_khi_slot_label(text),
  public.ensure_guild_config(text, text[]),
  public.set_reward_channel(text, text, boolean),
  public.enroll_player(text, text),
  public.adjust_soul_orders(text, text, integer, text, text, text, integer),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.remove_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_player_profile(text, text),
  public.get_hon_khi_session(text, text),
  public.get_hon_khi_leaderboard(text, text, integer),
  public.draw_hon_khi_with_session(text, text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.award_chat_message(text, text, text, text, integer, integer, boolean)
from public, anon, authenticated;

grant execute on function
  public.fingerprint_distance(text, text),
  public.cultivation_level(bigint),
  public.cultivation_points(bigint),
  public.hon_khi_vault_cost(integer),
  public.hon_khi_vault_level(bigint),
  public.hon_khi_tier_rates(integer),
  public.hon_khi_slot_label(text),
  public.ensure_guild_config(text, text[]),
  public.set_reward_channel(text, text, boolean),
  public.enroll_player(text, text),
  public.adjust_soul_orders(text, text, integer, text, text, text, integer),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.remove_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_player_profile(text, text),
  public.get_hon_khi_session(text, text),
  public.get_hon_khi_leaderboard(text, text, integer),
  public.draw_hon_khi_with_session(text, text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.award_chat_message(text, text, text, text, integer, integer, boolean)
to service_role;



alter table public.players drop column if exists is_awakened;
alter table public.voice_reward_buckets enable row level security;
alter table public.level_up_events enable row level security;
revoke all on public.voice_reward_buckets, public.level_up_events from public, anon, authenticated;
grant all on public.voice_reward_buckets, public.level_up_events to service_role;
revoke execute on function public.enroll_player(text, text), public.set_voice_session(text, text, boolean), public.award_voice_activity(text, text, text), public.claim_level_up_events(integer), public.mark_level_up_event_sent(bigint, text), public.mark_level_up_event_failed(bigint, text, text) from public, anon, authenticated;
grant execute on function public.enroll_player(text, text), public.set_voice_session(text, text, boolean), public.award_voice_activity(text, text, text), public.claim_level_up_events(integer), public.mark_level_up_event_sent(bigint, text), public.mark_level_up_event_failed(bigint, text, text) to service_role;
grant execute on function public.queue_level_up_events(text, text, integer, integer, bigint, text) to service_role;
notify pgrst, 'reload schema';

commit;
