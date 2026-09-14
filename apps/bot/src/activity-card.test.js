import assert from "node:assert/strict";
import test from "node:test";
import { buildActivityRankingCard, buildActivityStatCard } from "./activity-card.js";

test("activity stat card renders with avatar fallback", async () => {
  const card = await buildActivityStatCard({
    displayName: "Đạo Hữu <test>",
    avatarUrl: null,
    joinedAt: "2026-09-14T00:00:00.000Z",
    stats: {
      total: { chat: 5, voiceSeconds: 3600 },
      windows: {
        one: { chat: 1, voiceSeconds: 60 },
        seven: { chat: 3, voiceSeconds: 600 },
        thirty: { chat: 5, voiceSeconds: 3600 },
      },
      ranks: { chat: { rank: 2, value: 5 }, voice: { rank: 4, value: 3600 } },
      channels: { chat: { channelId: "chat", value: 1 }, voice: { channelId: "voice", value: 60 } },
    },
    channelNames: { chat: "#level", voice: "Phòng tu luyện" },
  });
  assert.equal(card.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("activity ranking card renders top ten and self rank", async () => {
  const card = await buildActivityRankingCard({
    metric: "voice",
    entries: [{ userId: "123", rank: 1, value: 7200 }],
    self: { userId: "456", rank: 7, value: 60 },
    profiles: new Map([["123", { displayName: "Người đứng đầu" }]]),
  });
  assert.equal(card.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});
