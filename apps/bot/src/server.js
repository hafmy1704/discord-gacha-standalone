import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLaunchToken, verifyLaunchToken } from "./launch-token.js";

const DEFAULT_PUBLIC_ROOT = fileURLToPath(
  new URL("../../gacha/dist/", import.meta.url),
);

const ACTIVITY_RATE_LIMIT_WINDOW_MS = 60_000;
const ACTIVITY_RATE_LIMIT_MAX = 10;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export function createMiniappServer({
  database,
  signingSecret,
  publicRoot = DEFAULT_PUBLIC_ROOT,
  guildId,
  discordClientId,
  discordClientSecret,
  allowedOrigins = [],
  isReady = () => true,
}) {
  if (!database || !signingSecret)
    throw new Error("database and signingSecret are required");

  const activityRateLimits = new Map();
  const configuredOrigins = normalizeAllowedOrigins(allowedOrigins);

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.once("finish", () => {
      if (req.url?.includes("/api/"))
        console.log("miniapp request", {
          requestId,
          method: req.method,
          url: req.url?.split("?")[0],
          status: res.statusCode,
        });
    });
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname.replace(/^\/\.proxy(?=\/api\/)/u, "");
    try {
      // Health check
      if (req.method === "GET" && pathname === "/health") {
        const ready = Boolean(isReady());
        return json(res, ready ? 200 : 503, { ok: ready, ready });
      }

      if (pathname.startsWith("/api/") && STATE_CHANGING_METHODS.has(req.method)) {
        if (pathname !== "/api/activity/token")
          assertStateChangingRequest(req, configuredOrigins);
        requireJsonContentType(req);
      }

      // Activity OAuth token exchange (Discord → launch token)
      if (req.method === "POST" && pathname === "/api/activity/token") {
        if (!consumeActivityRateLimit(activityRateLimits, req.socket.remoteAddress))
          throw new Error("rate_limited");
        const { code } = await readJson(req);
        const userId = await exchangeActivityCode({
          code,
          clientId: discordClientId,
          clientSecret: discordClientSecret,
        });
        const launchToken = createLaunchToken({ guildId, userId, secret: signingSecret });
        setLaunchSessionCookie(res, launchToken, req);
        return json(res, 200, { ok: true });
      }

      // Authenticated API routes
      if (pathname.startsWith("/api/")) {
        const identity = authenticate(req, signingSecret);

        if (req.method === "GET" && pathname === "/api/gacha/session") {
          const session = await database.getHonKhiSession(identity);
          return json(res, 200, session);
        }

        if (req.method === "GET" && pathname === "/api/gacha/items") {
          const items = await database.listHonKhiItems();
          return json(res, 200, items);
        }

        if (req.method === "GET" && pathname === "/api/gacha/leaderboard") {
          const leaderboard = await database.getHonKhiLeaderboard({
            ...identity,
            limit: 20,
          });
          return json(res, 200, leaderboard);
        }

        if (req.method === "POST" && pathname === "/api/gacha/draw") {
          const { requestId } = await readJson(req);
          const result = await database.drawHonKhi({
            ...identity,
            requestId,
          });
          return json(res, 200, result);
        }

        return json(res, 404, { error: "not_found" });
      }

      // Static file serving
      if (req.method !== "GET")
        return json(res, 405, { error: "method_not_allowed" });

      let relativePath;
      try {
        relativePath = decodeURIComponent(pathname === "/" ? "index.html" : pathname)
          .replace(/^[/\\]+/u, "");
      } catch {
        return json(res, 400, { error: "invalid_path" });
      }
      const publicRootPath = resolve(publicRoot);
      const filePath = resolve(publicRootPath, relativePath);
      const pathFromRoot = relative(publicRootPath, filePath);

      if (
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathFromRoot) ||
        !existsSync(filePath) ||
        !statSync(filePath).isFile()
      )
        return json(res, 404, { error: "not_found" });

      const ext = extname(filePath);
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      const isImmutable = ext !== ".html" && relativePath !== "index.html";
      res.writeHead(200, {
        "cache-control": isImmutable
          ? "public, max-age=31536000, immutable"
          : "no-store",
        "content-type": contentType,
      });
      createReadStream(filePath).pipe(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const publicCode = publicErrorCode(msg);
      console.error("miniapp request failed", {
        requestId,
        method: req.method,
        pathname,
        error: msg,
        stack: error?.stack,
      });
      const status =
        msg === "invalid launch token" || msg === "expired launch token"
          ? 401
          : msg === "csrf_rejected" || msg === "not_enrolled" || msg === "not_awakened"
            ? 403
            : msg === "unsupported_media_type"
              ? 415
              : [
                    "gacha_empty",
                    "gacha_cooldown",
                    "insufficient_soul_orders",
                    "invalid_request_id",
                  ].includes(msg)
                ? 409
                : ["activity_auth_unavailable", "activity_auth_failed"].includes(
                      msg,
                    )
                  ? 503
                  : msg === "rate_limited"
                    ? 429
                    : 400;
      json(res, status, { error: publicCode });
    }
  });
}

async function exchangeActivityCode({ code, clientId, clientSecret }) {
  if (
    typeof code !== "string" ||
    !/^[A-Za-z0-9._-]{8,2048}$/u.test(code) ||
    !clientId ||
    !clientSecret
  )
    throw new Error("activity_auth_unavailable");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
  });
  let tokenRes;
  try {
    tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("activity_auth_unavailable");
  }
  let token;
  try {
    token = await tokenRes.json();
  } catch {
    throw new Error("activity_auth_failed");
  }
  if (!tokenRes.ok || !token.access_token) {
    console.error("activity oauth token exchange failed", {
      status: tokenRes.status,
      error: token.error,
    });
    throw new Error("activity_auth_failed");
  }

  let userRes;
  try {
    userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("activity_auth_unavailable");
  }
  let user;
  try {
    user = await userRes.json();
  } catch {
    throw new Error("activity_auth_failed");
  }
  if (!userRes.ok || !user.id) {
    console.error("activity oauth user lookup failed", {
      status: userRes.status,
    });
    throw new Error("activity_auth_failed");
  }
  return user.id;
}

function authenticate(req, signingSecret) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : readCookie(req.headers.cookie, "launch_session");
  if (!token) throw new Error("invalid launch token");
  return verifyLaunchToken(token, { secret: signingSecret });
}

function assertStateChangingRequest(req, allowedOrigins) {
  const origin = headerValue(req.headers.origin);
  if (!origin) {
    if (headerValue(req.headers["sec-fetch-site"]) === "cross-site")
      throw new Error("csrf_rejected");
    return;
  }

  let normalizedOrigin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new Error("csrf_rejected");
  }

  const requestOrigin = getRequestOrigin(req);
  if (
    !allowedOrigins.has(normalizedOrigin) &&
    requestOrigin !== normalizedOrigin
  )
    throw new Error("csrf_rejected");
}

function requireJsonContentType(req) {
  const contentType = headerValue(req.headers["content-type"])
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json")
    throw new Error("unsupported_media_type");
}

function normalizeAllowedOrigins(values) {
  const entries = Array.isArray(values) ? values : [values];
  const origins = new Set();
  for (const value of entries) {
    if (!String(value ?? "").trim()) continue;
    let origin;
    try {
      origin = new URL(String(value).trim());
    } catch {
      throw new Error("invalid allowed origin");
    }
    if (!["http:", "https:"].includes(origin.protocol))
      throw new Error("invalid allowed origin");
    origins.add(origin.origin);
  }
  return origins;
}

function getRequestOrigin(req) {
  const protocol =
    headerValue(req.headers["x-forwarded-proto"]).split(",", 1)[0].trim() ||
    (req.socket.encrypted ? "https" : "http");
  const host =
    headerValue(req.headers["x-forwarded-host"]).split(",", 1)[0].trim() ||
    headerValue(req.headers.host);
  return host ? `${protocol}://${host}` : null;
}

function headerValue(value) {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function readCookie(header, name) {
  const prefix = `${name}=`;
  return String(header ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}

function setLaunchSessionCookie(res, token, req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const secure = req.socket.encrypted || forwardedProto === "https";
  res.setHeader(
    "set-cookie",
    `launch_session=${token}; Max-Age=900; Path=/; HttpOnly; SameSite=${secure ? "None; Secure" : "Lax"}`,
  );
}

function consumeActivityRateLimit(store, address, now = Date.now()) {
  const key = address || "unknown";
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + ACTIVITY_RATE_LIMIT_WINDOW_MS });
    if (store.size > 10_000)
      for (const [entryKey, entry] of store) if (entry.resetAt <= now) store.delete(entryKey);
    return true;
  }
  if (current.count >= ACTIVITY_RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function publicErrorCode(message) {
  const known = new Set([
    "invalid launch token",
    "expired launch token",
    "not_enrolled",
    "not_awakened",
    "gacha_empty",
    "gacha_cooldown",
    "insufficient_soul_orders",
    "invalid_request_id",
    "activity_auth_unavailable",
    "activity_auth_failed",
    "csrf_rejected",
    "unsupported_media_type",
    "request_too_large",
    "rate_limited",
    "not_found",
    "method_not_allowed",
    "invalid_path",
  ]);
  return known.has(message) ? message : "request_failed";
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 16_384) throw new Error("request_too_large");
  }
  return body ? JSON.parse(body) : {};
}

function json(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value ?? { error: "empty_response" });
  } catch (error) {
    console.error("miniapp response serialization failed", error);
    status = 500;
    body = JSON.stringify({ error: "response_serialization_failed" });
  }
  if (res.headersSent) return res.end(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'self' https://discord.com https://*.discord.com",
  );
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}
