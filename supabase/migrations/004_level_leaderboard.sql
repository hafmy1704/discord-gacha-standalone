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
