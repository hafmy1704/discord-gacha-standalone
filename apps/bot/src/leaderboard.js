const DISCORD_AVATAR_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

function fallbackName(entry) {
  const tag = String(entry?.tag ?? "").trim();
  return tag ? `Đạo Hữu #${tag}` : "Đạo Hữu";
}

function normalizeDisplayName(value) {
  const compact = String(value ?? "").trim().replace(/\s+/gu, " ");
  return compact ? [...compact].slice(0, 64).join("") : null;
}

function normalizeAvatarUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !DISCORD_AVATAR_HOSTS.has(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function presentLeaderboard(
  leaderboard,
  { resolveUser = async () => null } = {},
) {
  const lookups = new Map();
  const profileFor = (userId) => {
    if (!userId) return Promise.resolve(null);
    if (!lookups.has(userId)) {
      lookups.set(
        userId,
        Promise.resolve()
          .then(() => resolveUser(userId))
          .catch(() => null),
      );
    }
    return lookups.get(userId);
  };

  const presentEntry = async (entry) => {
    if (!entry) return null;
    const { userId: rawUserId, ...publicEntry } = entry;
    const userId = String(rawUserId ?? "");
    const profile = await profileFor(userId);
    return {
      ...publicEntry,
      displayName:
        normalizeDisplayName(profile?.displayName) ?? fallbackName(entry),
      avatarUrl: normalizeAvatarUrl(profile?.avatarUrl),
    };
  };

  return {
    ...leaderboard,
    entries: await Promise.all(
      (leaderboard?.entries ?? []).map(presentEntry),
    ),
    self: await presentEntry(leaderboard?.self ?? null),
  };
}

export function createGuildMemberProfileResolver({
  getGuild,
  now = Date.now,
  ttlMs = 5 * 60 * 1000,
  missTtlMs = 30 * 1000,
  maxEntries = 250,
} = {}) {
  if (typeof getGuild !== "function")
    throw new Error("getGuild is required");
  const cache = new Map();
  const pending = new Map();

  function store(userId, profile) {
    if (!cache.has(userId) && cache.size >= maxEntries)
      cache.delete(cache.keys().next().value);
    cache.set(userId, {
      expiresAt: now() + (profile ? ttlMs : missTtlMs),
      profile,
    });
  }

  return async function resolveGuildMemberProfile(userId) {
    const key = String(userId ?? "");
    if (!/^\d{17,20}$/u.test(key)) return null;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.profile;
    if (cached) cache.delete(key);
    if (pending.has(key)) return pending.get(key);

    const lookup = (async () => {
      const guild = getGuild();
      if (!guild?.members) return null;
      const member =
        guild.members.cache?.get(key) ??
        (await guild.members.fetch(key).catch(() => null));
      let user = member?.user ?? null;
      if (!member && typeof guild.client?.users?.fetch === "function")
        user = await guild.client.users.fetch(key).catch(() => null);
      const avatarOwner = member ?? user;
      const profile = avatarOwner
        ? {
            displayName:
              member?.displayName ??
              user?.globalName ??
              user?.displayName ??
              user?.username,
            avatarUrl: avatarOwner.displayAvatarURL({
              extension: "webp",
              size: 64,
            }),
          }
        : null;
      store(key, profile);
      return profile;
    })().finally(() => pending.delete(key));
    pending.set(key, lookup);
    return lookup;
  };
}
