import assert from "node:assert/strict";
import test from "node:test";
import {
  createGuildMemberProfileResolver,
  presentLeaderboard,
} from "./leaderboard.js";

const entry = (overrides = {}) => ({
  userId: "123456789012345678",
  tag: "ABC12",
  rank: 1,
  power: 9001,
  vaultLevel: 3,
  highestTier: 5,
  isSelf: false,
  ...overrides,
});

test("leaderboard presents Discord identity without exposing a raw user id field", async () => {
  const result = await presentLeaderboard(
    { entries: [entry()], self: entry({ isSelf: true }), totalPlayers: 1 },
    {
      resolveUser: async () => ({
        displayName: "  Lữ   Khách  ",
        avatarUrl: "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
      }),
    },
  );

  assert.equal(result.entries[0].displayName, "Lữ Khách");
  assert.equal(
    result.entries[0].avatarUrl,
    "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
  );
  assert.equal("userId" in result.entries[0], false);
  assert.equal("userId" in result.self, false);
});

test("leaderboard isolates lookup failures and rejects non-Discord avatar hosts", async () => {
  const result = await presentLeaderboard(
    {
      entries: [
        entry(),
        entry({ userId: "223456789012345678", tag: "SAFE2", rank: 2 }),
      ],
      self: null,
      totalPlayers: 2,
    },
    {
      resolveUser: async (userId) => {
        if (userId.startsWith("1")) throw new Error("lookup failed");
        return {
          displayName: "Người Chơi",
          avatarUrl: "https://example.com/untrusted.png",
        };
      },
    },
  );

  assert.equal(result.entries[0].displayName, "Đạo Hữu #ABC12");
  assert.equal(result.entries[0].avatarUrl, null);
  assert.equal(result.entries[1].displayName, "Người Chơi");
  assert.equal(result.entries[1].avatarUrl, null);
});

test("guild member resolver caches Discord lookups and coalesces concurrent misses", async () => {
  let fetches = 0;
  let releaseFetch;
  const fetched = new Promise((resolve) => { releaseFetch = resolve; });
  const member = {
    displayName: "M0N3S",
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
  };
  const guild = {
    members: {
      cache: new Map(),
      async fetch() {
        fetches += 1;
        await fetched;
        return member;
      },
    },
  };
  const resolveUser = createGuildMemberProfileResolver({ getGuild: () => guild });

  const first = resolveUser("123456789012345678");
  const second = resolveUser("123456789012345678");
  releaseFetch();

  assert.deepEqual(await first, {
    displayName: "M0N3S",
    avatarUrl: "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
  });
  assert.deepEqual(await second, await first);
  assert.deepEqual(await resolveUser("123456789012345678"), await first);
  assert.equal(fetches, 1);
});

test("guild member resolver falls back to global Discord users for historical players", async () => {
  let globalFetches = 0;
  const guild = {
    members: {
      cache: new Map(),
      async fetch() { throw new Error("Unknown Member"); },
    },
    client: {
      users: {
        async fetch() {
          globalFetches += 1;
          return {
            globalName: "Cố Nhân",
            username: "historical-user",
            displayAvatarURL: () => "https://cdn.discordapp.com/avatars/223/hash.webp?size=64",
          };
        },
      },
    },
  };
  const resolveUser = createGuildMemberProfileResolver({ getGuild: () => guild });

  assert.deepEqual(await resolveUser("223456789012345678"), {
    displayName: "Cố Nhân",
    avatarUrl: "https://cdn.discordapp.com/avatars/223/hash.webp?size=64",
  });
  assert.equal(globalFetches, 1);
});
