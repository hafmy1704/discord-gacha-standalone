import { createHmac, timingSafeEqual } from "node:crypto";

export function createLaunchToken({
  guildId,
  userId,
  secret,
  now = Date.now(),
  ttlMs = 15 * 60_000,
}) {
  validateSecret(secret);
  if (
    !guildId ||
    !userId ||
    !Number.isInteger(now) ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1
  )
    throw new RangeError("invalid launch token input");
  const payload = Buffer.from(
    JSON.stringify({ guildId, userId, expiresAt: now + ttlMs }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyLaunchToken(token, { secret, now = Date.now() }) {
  validateSecret(secret);
  if (typeof token !== "string" || !token.includes("."))
    throw new Error("invalid launch token");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("invalid launch token");
  const expected = sign(payload, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  )
    throw new Error("invalid launch token");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (
    !data.guildId ||
    !data.userId ||
    !Number.isInteger(data.expiresAt) ||
    data.expiresAt < now
  )
    throw new Error("expired launch token");
  return data;
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error(
      "MINIAPP_SIGNING_SECRET must contain at least 32 characters",
    );
}
