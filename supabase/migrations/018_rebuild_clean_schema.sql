begin;

create table if not exists public.guild_config (
  guild_id           text primary key,
  channel_ids        text[] not null default '{}'::text[],
  welcome_message_id text
);

create table if not exists public.players (
  guild_id         text        not null,
  user_id          text        not null,
  is_awakened      boolean     not null default false,
  cultivation_xp   bigint      not null default 0 check (cultivation_xp >= 0),
  soul_orders      bigint      not null default 0 check (soul_orders >= 0),
  vault_xp         bigint      not null default 0 check (vault_xp >= 0),
  refinement_steel bigint      not null default 0 check (refinement_steel >= 0),
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
    'enroll', 'awakening', 'chat_reward', 'gacha_roll',
    'vault_auto_upgrade', 'admin_grant'
  )),
  request_id text,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
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
  level integer := 1;
  next_required bigint;
begin
  if p_xp is null or p_xp < 0 then
    raise exception using message = 'invalid_cultivation_xp';
  end if;

  loop
    next_required := 50 * (level + 1) * level;
    exit when next_required > p_xp;
    level := level + 1;
  end loop;

  return level;
end;
$$;

create or replace function public.cultivation_points(p_xp bigint)
returns bigint
language sql
immutable
as $$
  select p_xp - 50 * public.cultivation_level(p_xp) * (public.cultivation_level(p_xp) - 1);
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
    exit when spent + cost > p_xp;
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
  on conflict (guild_id) do update
    set channel_ids = excluded.channel_ids;
end;
$$;

create or replace function public.enroll_player(
  p_guild_id text,
  p_user_id  text,
  p_awaken   boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row      public.players%rowtype;
  created         boolean := false;
  already_awake   boolean;
  awakening_bonus constant bigint := 10;
begin
  insert into public.players (guild_id, user_id, is_awakened)
  values (p_guild_id, p_user_id, false)
  on conflict (guild_id, user_id) do nothing
  returning * into player_row;

  if found then
    created := true;
  else
    select * into player_row
    from public.players
    where guild_id = p_guild_id and user_id = p_user_id
    for update;
  end if;

  already_awake := player_row.is_awakened;

  if p_awaken and not already_awake then
    update public.players
    set is_awakened = true,
        soul_orders = player_row.soul_orders + awakening_bonus
    where guild_id = p_guild_id and user_id = p_user_id
    returning * into player_row;

    insert into public.user_activity_log
      (guild_id, user_id, event_type, request_id, payload)
    values
      (p_guild_id, p_user_id, 'awakening', 'awakening:' || p_user_id,
       jsonb_build_object(
         'soulOrders', awakening_bonus,
         'soulOrdersAfter', player_row.soul_orders
       ));
  end if;

  insert into public.user_activity_log
    (guild_id, user_id, event_type, payload)
  values
    (p_guild_id, p_user_id, 'enroll',
     jsonb_build_object(
       'created', created,
       'isAwakened', player_row.is_awakened
     ));

  return jsonb_build_object(
    'created', created,
    'already_awakened', already_awake,
    'is_awakened', player_row.is_awakened,
    'soul_orders', player_row.soul_orders
  );
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
declare
  player_row public.players%rowtype;
  old_event  public.user_activity_log%rowtype;
  new_orders bigint;
begin
  if p_amount < 1 or p_amount > 1000000 then
    raise exception using message = 'invalid_amount';
  end if;

  select * into old_event
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'admin_grant'
    and request_id = p_source_id;
  if found then
    return jsonb_build_object(
      'duplicate', true,
      'soul_orders', (old_event.payload ->> 'soulOrdersAfter')::bigint
    );
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;
  if not found then
    raise exception using message = 'not_enrolled';
  end if;

  new_orders := player_row.soul_orders + p_amount;

  update public.players
  set soul_orders = new_orders
  where guild_id = p_guild_id and user_id = p_user_id;

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'admin_grant', p_source_id,
     jsonb_build_object(
       'amount', p_amount,
       'reason', p_reason,
       'adminUserId', p_admin_id,
       'soulOrdersAfter', new_orders
     ));

  return jsonb_build_object('duplicate', false, 'soul_orders', new_orders);
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

create or replace function public.get_hon_khi_session(
  p_guild_id text,
  p_user_id  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  player_row      public.players%rowtype;
  equipped_json   jsonb;
  collection_json jsonb;
  history_json    jsonb;
  total_rolls     bigint;
begin
  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id;

  if not found or not player_row.is_awakened then
    raise exception using message = 'not_enrolled';
  end if;

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

  select public.get_total_hon_khi_rolls(p_guild_id, p_user_id)
  into total_rolls;

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
    'vaultLevel', public.hon_khi_vault_level(player_row.vault_xp),
    'upgradeCost', public.hon_khi_vault_cost(public.hon_khi_vault_level(player_row.vault_xp)),
    'tierRates', public.hon_khi_tier_rates(public.hon_khi_vault_level(player_row.vault_xp)),
    'totalRolls', total_rolls,
    'equipped', equipped_json,
    'collection', collection_json,
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

  select * into activity_row
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'gacha_roll'
    and request_id = p_request_id;

  if found then
    if activity_row.user_id <> p_user_id then
      raise exception using message = 'invalid_request_id';
    end if;
    return activity_row.payload || jsonb_build_object('replayed', true);
  end if;

  select * into player_row
  from public.players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if not found or not player_row.is_awakened then
    raise exception using message = 'not_enrolled';
  end if;

  select max(created_at) into last_roll_at
  from public.user_activity_log
  where guild_id = p_guild_id
    and user_id = p_user_id
    and event_type = 'gacha_roll';

  if last_roll_at is not null and clock_timestamp() < last_roll_at + interval '1 second' then
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
      refinement_steel = player_row.refinement_steel + salvage_total,
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
    'refinementSteelAfter', player_after.refinement_steel,
    'vaultLevelBefore', vault_level_before,
    'vaultLevelAfter', vault_level_after,
    'replayed', false
  );

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'gacha_roll', p_request_id, activity_payload);

  return activity_payload;
end;
$$;

create or replace function public.auto_upgrade_hon_khi_vault()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_level integer;
  target_level  integer;
  current_steel bigint;
  cost          bigint;
  next_steel    bigint;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  current_level := public.hon_khi_vault_level(old.vault_xp);
  target_level := public.hon_khi_vault_level(new.vault_xp);
  current_steel := new.refinement_steel;

  while current_level < target_level loop
    cost := public.hon_khi_vault_cost(current_level);
    exit when current_steel < cost;
    next_steel := current_steel - cost;

    update public.players
    set refinement_steel = next_steel
    where guild_id = new.guild_id and user_id = new.user_id;

    insert into public.user_activity_log
      (guild_id, user_id, event_type, request_id, payload)
    values
      (
        new.guild_id,
        new.user_id,
        'vault_auto_upgrade',
        format('vault:%s:%s:%s', new.guild_id, new.user_id, current_level + 1),
        jsonb_build_object(
          'fromLevel', current_level,
          'toLevel', current_level + 1,
          'cost', cost,
          'refinementSteelAfter', next_steel,
          'automatic', true
        )
      )
    on conflict (guild_id, event_type, request_id)
      where request_id is not null
    do nothing;

    current_level := current_level + 1;
    current_steel := next_steel;
  end loop;

  return new;
end;
$$;

create trigger players_auto_upgrade_hon_khi_vault
after update of vault_xp, refinement_steel on public.players
for each row execute function public.auto_upgrade_hon_khi_vault();

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
begin
  select * into old_event
  from public.user_activity_log
  where guild_id = p_guild_id
    and event_type = 'chat_reward'
    and request_id = p_message_id;

  if found then
    return jsonb_build_object(
      'skipped', coalesce((old_event.payload ->> 'skipped')::boolean, false),
      'duplicate', true,
      'cultivation_points', coalesce((old_event.payload ->> 'cultivationPoints')::integer, 0),
      'soul_orders', coalesce((old_event.payload ->> 'soulOrders')::integer, 0)
    );
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

  if not skip and not player_row.is_awakened then
    skip := true;
    skip_reason := 'not_awakened';
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

  insert into public.user_activity_log
    (guild_id, user_id, event_type, request_id, payload)
  values
    (p_guild_id, p_user_id, 'chat_reward', p_message_id, activity_payload);

  return jsonb_build_object(
    'skipped', skip,
    'skip_reason', skip_reason,
    'duplicate', false,
    'cultivation_points', pts_gain,
    'soul_orders', orders_gain,
    'new_level', coalesce(new_lvl, old_lvl),
    'leveled_up', coalesce(new_lvl > old_lvl, false)
  );
end;
$$;

alter table public.guild_config           enable row level security;
alter table public.players                enable row level security;
alter table public.hon_khi_catalog        enable row level security;
alter table public.hon_khi_equipped       enable row level security;
alter table public.user_hon_khi_collection enable row level security;
alter table public.user_activity_log      enable row level security;

revoke all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log
from public, anon, authenticated;

grant all on
  public.guild_config,
  public.players,
  public.hon_khi_catalog,
  public.hon_khi_equipped,
  public.user_hon_khi_collection,
  public.user_activity_log
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
  public.enroll_player(text, text, boolean),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_hon_khi_session(text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.auto_upgrade_hon_khi_vault(),
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
  public.enroll_player(text, text, boolean),
  public.grant_soul_orders(text, text, integer, text, text, text),
  public.get_total_hon_khi_rolls(text, text),
  public.get_hon_khi_session(text, text),
  public.cleanup_user_activity_log(),
  public.draw_hon_khi(text, text, text),
  public.award_chat_message(text, text, text, text, integer, integer, boolean)
to service_role;

notify pgrst, 'reload schema';

commit;
