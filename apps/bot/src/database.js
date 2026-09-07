import { HON_KHI_SLOT_LABELS, HON_KHI_TIER_NAMES } from "./hon-khi.js";

/**
 * Supabase database adapter for the Discord Gacha bot.
 * Uses Supabase REST API + RPC functions (service role key).
 */
export function createDatabase({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!url || !serviceRoleKey)
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs must be a positive number");

  const base = url.replace(/\/$/u, "");

  async function rest(path, options = {}) {
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const msg =
        body?.message ?? body?.error ?? body?.hint ?? "supabase_error";
      throw Object.assign(new Error(msg), { status: response.status, body });
    }
    return body;
  }

  async function rpc(name, args) {
    try {
      return await rest(`rpc/${name}`, {
        method: "POST",
        body: JSON.stringify(args),
      });
    } catch (error) {
      // Re-raise well-known domain errors as plain Error with that message
      const known = [
        "gacha_empty",
        "gacha_cooldown",
        "insufficient_soul_orders",
        "invalid_request_id",
        "not_enrolled",
        "not_awakened",
        "invalid_amount",
        "guild_not_configured",
      ];
      const hit = known.find((code) => String(error.message).includes(code));
      if (hit) throw new Error(hit);
      throw error;
    }
  }

  async function select(table, filters = {}, selectCols = "*") {
    const qs = Object.entries(filters)
      .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
      .join("&");
    return rest(`${table}?${qs}&select=${selectCols}`);
  }

  return {
    // ── Guild config ─────────────────────────────────────────

    async configureGuild({ guildId, channelIds }) {
      return rpc("ensure_guild_config", {
        p_guild_id: guildId,
        p_channels: channelIds,
      });
    },

    async getGuildRewardConfig(guildId) {
      const rows = await select(
        "guild_config",
        { guild_id: guildId },
        "channel_ids",
      );
      if (!rows?.length) return null;
      return {
        channelIds: new Set(rows[0].channel_ids ?? []),
      };
    },

    async addRewardChannel({ guildId, channelId }) {
      const rows = await select(
        "guild_config",
        { guild_id: guildId },
        "channel_ids",
      );
      const current = new Set(rows?.[0]?.channel_ids ?? []);
      current.add(channelId);
      const channels = [...current];
      await rest(`guild_config?guild_id=eq.${encodeURIComponent(guildId)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ channel_ids: channels }),
      });
      return channels;
    },

    async removeRewardChannel({ guildId, channelId }) {
      const rows = await select(
        "guild_config",
        { guild_id: guildId },
        "channel_ids",
      );
      const current = new Set(rows?.[0]?.channel_ids ?? []);
      const removed = current.delete(channelId);
      const channels = [...current];
      await rest(`guild_config?guild_id=eq.${encodeURIComponent(guildId)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ channel_ids: channels }),
      });
      return { removed, channels };
    },

    async getWelcomeMessageId(guildId) {
      const rows = await select(
        "guild_config",
        { guild_id: guildId },
        "welcome_message_id",
      );
      return rows?.[0]?.welcome_message_id ?? null;
    },

    async setWelcomeMessageId({ guildId, messageId }) {
      return rest(`guild_config?guild_id=eq.${encodeURIComponent(guildId)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ welcome_message_id: messageId }),
      });
    },

    // ── Players ───────────────────────────────────────────────

    async enrollPlayer({ guildId, userId, awaken = false }) {
      return rpc("enroll_player", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_awaken: awaken,
      });
    },

    async getProfile({ guildId, userId }) {
      const profile = await rpc("get_player_profile", {
        p_guild_id: guildId,
        p_user_id: userId,
      });
      return profile ? mapPlayerProfile(profile) : null;
    },

    async getProfileEquipment({ guildId, userId }) {
      const session = await rpc("get_hon_khi_session", {
        p_guild_id: guildId,
        p_user_id: userId,
      });
      return (session?.equipped ?? []).map(mapProfileEquipment);
    },
    async getServerPowerRank({ guildId, userId }) {
      const leaderboard = await rpc("get_hon_khi_leaderboard", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_limit: 0,
      });
      const self = leaderboard?.self;
      return {
        rank: self ? Number(self.rank) : null,
        totalPlayers: Number(leaderboard?.totalPlayers ?? 0),
        power: self ? Number(self.power) : null,
      };
    },
    async getHonKhiLeaderboard({ guildId, userId, limit = 20 }) {
      const leaderboard = await rpc("get_hon_khi_leaderboard", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_limit: limit,
      });
      return {
        entries: (leaderboard?.entries ?? []).map(mapLeaderboardEntry),
        self: leaderboard?.self ? mapLeaderboardEntry(leaderboard.self) : null,
        totalPlayers: Number(leaderboard?.totalPlayers ?? 0),
      };
    },
    // ── Soul orders ───────────────────────────────────────────

    async grantSoulOrders({
      guildId,
      userId,
      amount,
      sourceId,
      adminUserId,
      reason,
    }) {
      return rpc("grant_soul_orders", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_amount: amount,
        p_source_id: sourceId,
        p_reason: reason ?? "admin_grant",
        p_admin_id: adminUserId ?? null,
      });
    },

    // ── Chat reward ───────────────────────────────────────────

    async awardChatMessage({
      guildId,
      userId,
      messageId,
      fingerprint,
      uniqueCharacters,
      sentenceCount,
      isHumanReply,
    }) {
      return rpc("award_chat_message", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_message_id: messageId,
        p_fingerprint: fingerprint ?? null,
        p_unique_chars: uniqueCharacters,
        p_sentence_count: sentenceCount,
        p_is_reply: Boolean(isHumanReply),
      });
    },

    // ── Hồn Khí gacha ────────────────────────────────────────

    async seedHonKhiCatalog(items) {
      const rows = (items ?? []).map((item) => ({
        item_code: item.itemCode,
        tier: item.tier,
        slot: item.slot,
        name: item.name,
        slot_budget: item.slotBudget,
        asset_key: item.assetKey,
      }));
      return rest("hon_khi_catalog?on_conflict=item_code", {
        method: "POST",
        headers: {
          prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(rows),
      });
    },

    async listHonKhiItems() {
      const rows = await rest(
        "hon_khi_catalog?select=item_code,tier,slot,name,slot_budget,asset_key&order=tier,slot",
      );
      return (rows ?? []).map(mapCatalogItem);
    },

    async getHonKhiSession({ guildId, userId }) {
      const session = await rpc("get_hon_khi_session", {
        p_guild_id: guildId,
        p_user_id: userId,
      });
      return mapHonKhiSession(session);
    },

    async drawHonKhi({ guildId, userId, requestId }) {
      const result = await rpc("draw_hon_khi_with_session", {
        p_guild_id: guildId,
        p_user_id: userId,
        p_request_id: requestId,
      });
      return {
        ...mapHonKhiRoll(result),
        session: mapHonKhiSession(result.session),
      };
    },

    async cleanupActivityLog() {
      return rpc("cleanup_user_activity_log", {});
    },
  };
}

// Deterministic, non-reversible short tag so the client can show a stable
// pseudonym per player without ever receiving raw Discord user ids.
function anonymiseUserId(userId) {
  let hash = 2166136261;
  for (let index = 0; index < String(userId).length; index += 1) {
    hash ^= String(userId).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(5, "0").slice(-5);
}

function mapCatalogItem(row) {
  return {
    itemCode: row.item_code,
    tier: Number(row.tier),
    slot: row.slot,
    slotLabel: HON_KHI_SLOT_LABELS[row.slot] ?? row.slot,
    tierLabel: HON_KHI_TIER_NAMES[Number(row.tier)] ?? `Tier ${row.tier}`,
    name: row.name,
    slotBudget: Number(row.slot_budget),
    assetKey: row.asset_key ?? null,
  };
}

function mapProfileEquipment(item) {
  return {
    ...item,
    code: item.itemCode,
    asset: item.assetKey ?? null,
    tier: Number(item.tier),
    ageYears: Number(item.ageYears),
    power: Number(item.power),
  };
}

function mapHonKhiRoll(value) {
  return {
    ...value,
    tier: Number(value.tier),
    ageYears: Number(value.ageYears),
    power: Number(value.power),
    salvageSteel: Number(value.salvageSteel ?? 0),
    soulOrdersAfter: Number(value.soulOrdersAfter),
    refinementSteelAfter: Number(value.refinementSteelAfter),
  };
}

function mapPlayerProfile(value) {
  return {
    isAwakened: Boolean(value.isAwakened),
    soulOrders: Number(value.soulOrders ?? 0),
    cultivationLevel: Number(value.cultivationLevel ?? 1),
    cultivationPoints: Number(value.cultivationPoints ?? 0),
    cultivationPointsRequired: Number(value.cultivationPointsRequired ?? 100),
    cultivationProgress: Number(value.cultivationProgress ?? 0),
    vaultXp: Number(value.vaultXp ?? 0),
    vaultLevel: Number(value.vaultLevel ?? 1),
    refinementSteel: Number(value.refinementSteel ?? 0),
    equipmentPower: Number(value.equipmentPower ?? 0),
    power: Number(value.power ?? 0),
    equipmentStats: value.equipmentStats ?? {},
    totalRolls: Number(value.totalRolls ?? 0),
  };
}

function mapLeaderboardEntry(value) {
  return {
    rank: Number(value.rank ?? 0),
    power: Number(value.power ?? 0),
    vaultLevel: Number(value.vaultLevel ?? 1),
    cultivationLevel: Number(value.cultivationLevel ?? 1),
    highestTier: Number(value.highestTier ?? 0),
    tag: anonymiseUserId(value.userId),
    isSelf: Boolean(value.isSelf),
  };
}

function mapHonKhiSession(value) {
  return {
    soulOrders: Number(value?.soulOrders ?? 0),
    refinementSteel: Number(value?.refinementSteel ?? 0),
    vaultXp: Number(value?.vaultXp ?? 0),
    vaultLevel: Number(value?.vaultLevel ?? 1),
    upgradeCost: Number(value?.upgradeCost ?? 100),
    vaultProgress: Number(value?.vaultProgress ?? 0),
    canDraw: Boolean(value?.canDraw),
    totalRolls: Number(value?.totalRolls ?? 0),
    tierRates: (value?.tierRates ?? []).map((entry) => ({
      tier: Number(entry.tier),
      rate: Number(entry.rate),
    })),
    tierRatePreviews: (value?.tierRatePreviews ?? []).map((preview) => ({
      level: Number(preview.level),
      rates: (preview.rates ?? []).map((entry) => ({
        tier: Number(entry.tier),
        rate: Number(entry.rate),
      })),
    })),
    equipmentCount: Number(value?.equipmentCount ?? 0),
    equipmentPower: Number(value?.equipmentPower ?? 0),
    equipped: value?.equipped ?? [],
    collection: (value?.collection ?? []).map((item) => ({
      ...item,
      tier: Number(item.tier),
      rollCount: Number(item.rollCount ?? 0),
    })),
    collectionSummary: {
      discoveredCount: Number(value?.collectionSummary?.discoveredCount ?? 0),
      totalCount: Number(value?.collectionSummary?.totalCount ?? 0),
      byTier: (value?.collectionSummary?.byTier ?? []).map((entry) => ({
        tier: Number(entry.tier),
        discoveredCount: Number(entry.discoveredCount ?? 0),
        totalCount: Number(entry.totalCount ?? 0),
      })),
    },
    history: value?.history ?? [],
  };
}
