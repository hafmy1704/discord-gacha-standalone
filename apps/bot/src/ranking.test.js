import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags } from "discord.js";
import sharp from "sharp";
import {
  RANKING_CARD_HEIGHT,
  RANKING_TEMPLATE_PATH,
  RANKING_CARD_WIDTH,
  RANKING_COMMAND,
  buildRankingCard,
  deferRankingReply,
  rankingReplyFlags,
  topRankingEntries,
} from "./ranking.js";

const entry = (rank, overrides = {}) => ({
  rank,
  power: 12_345 - rank,
  vaultLevel: 3,
  cultivationLevel: 7,
  highestTier: 5,
  isSelf: rank === 4,
  displayName: `Đạo Hữu ${rank}`,
  avatarUrl: null,
  ...overrides,
});

test("ranking command is private by default and public only for all=true", async () => {
  const command = RANKING_COMMAND.toJSON();
  const allOption = command.options.find((option) => option.name === "all");

  assert.equal(command.name, "ranking");
  assert.equal(allOption?.type, 5);
  assert.equal(allOption?.required ?? false, false);
  assert.equal(rankingReplyFlags(), MessageFlags.Ephemeral);
  assert.equal(rankingReplyFlags(false), MessageFlags.Ephemeral);
  assert.equal(rankingReplyFlags(true), 0);

  const deferredFlags = [];
  for (const value of [null, false, true]) {
    await deferRankingReply({
      options: { getBoolean: () => value },
      deferReply: async ({ flags }) => deferredFlags.push(flags),
    });
  }
  assert.deepEqual(deferredFlags, [
    MessageFlags.Ephemeral,
    MessageFlags.Ephemeral,
    0,
  ]);
});

test("ranking presentation preserves database order and clamps to ten rows", () => {
  const entries = Array.from({ length: 12 }, (_, index) => entry(index + 1));
  const selected = topRankingEntries({ entries });

  assert.equal(selected.length, 10);
  assert.deepEqual(selected.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("ranking card renders safely with avatar failures and hostile display text", async () => {
  const avatarRequests = [];
  const mockAvatar = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 4,
      background: "#42cdb4",
    },
  }).png().toBuffer();
  const entries = Array.from({ length: 12 }, (_, index) =>
    entry(index + 1, index === 0
      ? {
          displayName: "<script>& Một cái tên rất dài cần được giới hạn để không phá bố cục bảng xếp hạng",
          avatarUrl: "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
        }
      : index === 1
        ? { avatarUrl: "https://evil.example/avatar.png" }
        : index === 2
          ? { avatarUrl: "https://media.discordapp.net/avatars/456/hash.webp?size=64" }
        : {}),
  );

  const card = await buildRankingCard({
    leaderboard: { entries, totalPlayers: 42 },
    avatarLoader: async (url) => {
      avatarRequests.push(url);
      if (url.includes("/123/")) return mockAvatar;
      throw new Error("avatar unavailable");
    },
  });
  const metadata = await sharp(card).metadata();

  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, RANKING_CARD_WIDTH);
  assert.equal(metadata.height, RANKING_CARD_HEIGHT);
  assert.ok(card.length < 8 * 1024 * 1024);
  assert.deepEqual(avatarRequests, [
    "https://cdn.discordapp.com/avatars/123/hash.webp?size=64",
    "https://media.discordapp.net/avatars/456/hash.webp?size=64",
  ]);
});

test("ranking renderer uses the generated ten-slot artwork template", async () => {
  const metadata = await sharp(RANKING_TEMPLATE_PATH).metadata();

  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, RANKING_CARD_WIDTH);
  assert.equal(metadata.height, RANKING_CARD_HEIGHT);
});
