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
  const metricOption = command.options.find((option) => option.name === "loai");
  const allOption = command.options.find((option) => option.name === "all");

  assert.equal(command.name, "ranking");
  assert.equal(metricOption?.required, true);
  assert.deepEqual(metricOption?.choices.map((choice) => choice.value), ["voice", "chat", "power", "level"]);
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

test("ranking avatars stay inset and concentric with all ten artwork sockets", async () => {
  const marker = await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 4,
      background: { r: 28, g: 235, b: 205, alpha: 1 },
    },
  })
    .composite([{
      input: Buffer.from('<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg"><path d="M64 0v128M0 64h128" stroke="#ff2c87" stroke-width="5"/><circle cx="64" cy="64" r="10" fill="#fff"/></svg>'),
    }])
    .png()
    .toBuffer();
  const entries = Array.from({ length: 10 }, (_, index) => entry(index + 1, {
    avatarUrl: `https://cdn.discordapp.com/avatars/${index + 1}/marker.webp`,
  }));
  const card = await buildRankingCard({
    leaderboard: { entries, totalPlayers: 10 },
    avatarLoader: async () => marker,
  });
  const { data, info } = await sharp(card)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const expected = [
    [168.5, 328.5, 86],
    [164.5, 465.5, 86],
    [163.5, 588.5, 86],
    [156.5, 704.5, 72],
    [156.5, 808.5, 72],
    [156.5, 912.5, 72],
    [156.5, 1016.5, 72],
    [156.5, 1121.5, 72],
    [156.5, 1225.5, 72],
    [156.5, 1330.5, 72],
  ];

  const observed = expected.map(([, approximateY]) => {
    const points = [];
    for (let y = approximateY - 49; y <= approximateY + 49; y += 1) {
      for (let x = 90; x <= 225; x += 1) {
        const pixelY = Math.round(y);
        const offset = (pixelY * info.width + x) * info.channels;
        const [red, green, blue] = data.subarray(offset, offset + 3);
        if (red < 80 && green > 180 && blue > 150) points.push([x, pixelY]);
      }
    }
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      maxX - minX + 1,
    ];
  });

  assert.deepEqual(observed, expected);
});
