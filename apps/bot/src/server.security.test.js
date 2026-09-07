import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMiniappServer } from "./server.js";

test("miniapp security boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-gacha-security-"));
  await writeFile(join(root, "index.html"), "ok");
  const identities = [];
  let drawCalls = 0;
  let ready = false;
  const database = {
    async getHonKhiSession(identity) { identities.push(identity); return { ok: true }; },
    async listHonKhiItems() { return []; },
    async getHonKhiLeaderboard() { return { entries: [], self: null, totalPlayers: 0 }; },
    async drawHonKhi() { drawCalls += 1; return {}; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === "https://discord.com/api/oauth2/token") {
      const form = new URLSearchParams(init?.body);
      if (form.get("code") === "invalid-code")
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "test-access-token" }), { status: 200 });
    }
    if (url === "https://discord.com/api/users/@me")
      return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    return originalFetch(url, init);
  };
  const server = createMiniappServer({
    database,
    signingSecret: "s".repeat(64),
    publicRoot: root,
    guildId: "guild-1",
    discordClientId: "client-1",
    discordClientSecret: "secret-1",
    isReady: () => ready,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    let response = await fetch(base + "/health");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, ready: false });
    ready = true;
    response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ready: true });
    response = await fetch(base + "/api/activity/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ code: "valid-code" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /launch_session=.*HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    response = await fetch(base + "/api/gacha/session", { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(response.status, 200);
    assert.equal(identities[0].userId, "user-1");

    response = await fetch(base + "/api/gacha/draw", {
      method: "POST",
      headers: {
        cookie: cookie.split(";")[0],
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ requestId: "evil-request" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "csrf_rejected");
    assert.equal(drawCalls, 0);

    response = await fetch(base + "/api/gacha/draw", {
      method: "POST",
      headers: {
        cookie: cookie.split(";")[0],
        origin: base,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "same-origin-request" }),
    });
    assert.equal(response.status, 200);
    assert.equal(drawCalls, 1);

    response = await fetch(base + "/api/gacha/draw", {
      method: "POST",
      headers: {
        cookie: cookie.split(";")[0],
        origin: base,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId: "discord-activity-request" }),
    });
    assert.equal(response.status, 200);
    assert.equal(drawCalls, 2);

    response = await fetch(base + "/api/gacha/session", { headers: { authorization: "Bearer malformed" } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "invalid launch token");

    response = await fetch(base + "/%2e%2e/package.json");
    assert.equal(response.status, 404);

    for (let attempt = 0; attempt < 9; attempt += 1) {
      response = await fetch(base + "/api/activity/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "invalid-code" }),
      });
      assert.equal(response.status, 503);
    }
    response = await fetch(base + "/api/activity/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "invalid-code" }),
    });
    assert.equal(response.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});
