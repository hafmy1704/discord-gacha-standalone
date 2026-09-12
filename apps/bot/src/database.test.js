import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "./database.js";

test("database REST calls carry a timeout signal", async () => {
  let requestSignal;
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Response("null", { status: 200 });
    },
  });

  await database.cleanupActivityLog();
  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, false);
});

test("removing soul orders calls the idempotent admin RPC", async () => {
  let request;
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ duplicate: false, soul_orders: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await database.removeSoulOrders({
    guildId: "guild-1",
    userId: "user-1",
    amount: 2,
    sourceId: "admin_remove:interaction-1",
    adminUserId: "admin-1",
    reason: "test",
  });

  assert.equal(request.url, "https://example.supabase.co/rest/v1/rpc/remove_soul_orders");
  assert.deepEqual(request.body, {
    p_guild_id: "guild-1",
    p_user_id: "user-1",
    p_amount: 2,
    p_source_id: "admin_remove:interaction-1",
    p_reason: "test",
    p_admin_id: "admin-1",
  });
  assert.deepEqual(result, { duplicate: false, soul_orders: 3 });
});

test("reward channel changes use one atomic database RPC", async () => {
  const requests = [];
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method: init.method ?? "GET", body });
      if (!url.endsWith("/rpc/set_reward_channel")) {
        return new Response(JSON.stringify(init.method === "PATCH" ? null : []), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const enabled = body.p_enabled;
      return new Response(
        JSON.stringify({
          changed: true,
          channel_ids: enabled ? ["channel-1"] : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(
    await database.addRewardChannel({ guildId: "guild-1", channelId: "channel-1" }),
    ["channel-1"],
  );
  assert.deepEqual(
    await database.removeRewardChannel({ guildId: "guild-1", channelId: "channel-1" }),
    { removed: true, channels: [] },
  );
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(
      request.url,
      "https://example.supabase.co/rest/v1/rpc/set_reward_channel",
    );
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, {
      p_guild_id: "guild-1",
      p_channel_id: "channel-1",
      p_enabled: index === 0,
    });
  }
});


test("voice session and reward call the atomic RPCs", async () => {
  const requests = [];
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ updated: true, skipped: false, buckets: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await database.setVoiceSession({ guildId: "guild-1", userId: "user-1", active: true });
  await database.awardVoiceActivity({ guildId: "guild-1", userId: "user-1", channelId: "voice-1" });

  assert.deepEqual(requests, [
    {
      url: "https://example.supabase.co/rest/v1/rpc/set_voice_session",
      body: { p_guild_id: "guild-1", p_user_id: "user-1", p_active: true },
    },
    {
      url: "https://example.supabase.co/rest/v1/rpc/award_voice_activity",
      body: { p_guild_id: "guild-1", p_user_id: "user-1", p_channel_id: "voice-1" },
    },
  ]);
});

test("chat reward recreates a deleted player before awarding", async () => {
  const requests = [];
  const database = createDatabase({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (url.includes("/players?")) return new Response(null, { status: 201 });
      return new Response(JSON.stringify({ skipped: false, cultivation_points: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await database.awardChatMessage({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "message-1",
    fingerprint: null,
    uniqueCharacters: 12,
    sentenceCount: 1,
    isHumanReply: false,
  });

  assert.equal(requests[0].url, "https://example.supabase.co/rest/v1/players?on_conflict=guild_id%2Cuser_id");
  assert.deepEqual(requests[0].body, { guild_id: "guild-1", user_id: "user-1" });
  assert.equal(requests[1].url, "https://example.supabase.co/rest/v1/rpc/award_chat_message");
});
