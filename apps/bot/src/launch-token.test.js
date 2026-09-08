import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchToken, verifyLaunchToken } from "./launch-token.js";

const secret = "s".repeat(64);

test("launch tokens expire at the exact expiry instant", () => {
  const token = createLaunchToken({
    guildId: "guild-1",
    userId: "user-1",
    secret,
    now: 1_000,
    ttlMs: 5_000,
  });

  assert.equal(verifyLaunchToken(token, { secret, now: 5_999 }).userId, "user-1");
  assert.throws(
    () => verifyLaunchToken(token, { secret, now: 6_000 }),
    /expired launch token/u,
  );
});

