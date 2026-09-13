import {
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { cultivationRoleName } from "./roles.js";

export const RANKING_CARD_WIDTH = 1024;
export const RANKING_CARD_HEIGHT = 1536;
const MAX_RANKING_ENTRIES = 10;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DISCORD_AVATAR_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);
export const RANKING_TEMPLATE_PATH = fileURLToPath(
  new URL("../ranking-card-v2.png", import.meta.url),
);
const numberFormat = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 0,
});

export const RANKING_COMMAND = new SlashCommandBuilder()
  .setName("ranking")
  .setDescription("Xem Top 10 người chơi có lực chiến cao nhất")
  .addBooleanOption((option) =>
    option
      .setName("all")
      .setDescription("Hiển thị bảng xếp hạng cho mọi người"),
  );

export function rankingReplyFlags(showAll = false) {
  return showAll === true ? 0 : MessageFlags.Ephemeral;
}

export function deferRankingReply(interaction) {
  const showAll = interaction.options.getBoolean("all") === true;
  return interaction.deferReply({ flags: rankingReplyFlags(showAll) });
}

export function topRankingEntries(leaderboard) {
  return Array.isArray(leaderboard?.entries)
    ? leaderboard.entries.slice(0, MAX_RANKING_ENTRIES)
    : [];
}

export async function buildRankingCard({
  leaderboard,
  avatarLoader = loadDiscordAvatar,
  background = RANKING_TEMPLATE_PATH,
} = {}) {
  const entries = topRankingEntries(leaderboard).map(normalizeEntry);
  const avatars = await Promise.all(
    entries.map(async (entry, index) => {
      const avatarUrl = normalizeDiscordAvatarUrl(entry.avatarUrl);
      if (!avatarUrl) return null;
      try {
        const source = await avatarLoader(avatarUrl);
        if (!source) return null;
        const { size } = avatarGeometry(index);
        return await sharp(source, {
          failOn: "error",
          limitInputPixels: 4096 * 4096,
        })
          .resize(size, size, { fit: "cover", position: "centre" })
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
              ),
              blend: "dest-in",
            },
          ])
          .png()
          .toBuffer();
      } catch {
        return null;
      }
    }),
  );

  const composites = [
    { input: Buffer.from(buildHeaderSvg(entries.length, leaderboard?.totalPlayers)) },
  ];
  for (let index = 0; index < avatars.length; index += 1) {
    if (!avatars[index]) continue;
    const geometry = avatarGeometry(index);
    composites.push({
      input: avatars[index],
      left: geometry.left,
      top: geometry.top,
    });
  }
  composites.push({ input: Buffer.from(buildContentSvg(entries, avatars)) });

  const card = await sharp(background)
    .resize(RANKING_CARD_WIDTH, RANKING_CARD_HEIGHT, {
      fit: "fill",
      position: "centre",
    })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (card.length > MAX_ATTACHMENT_BYTES)
    throw new Error("ranking_card_too_large");
  return card;
}

async function loadDiscordAvatar(url) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("ranking_avatar_unavailable");
  if (!String(response.headers.get("content-type") ?? "").startsWith("image/"))
    throw new Error("ranking_avatar_invalid_content");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 2 * 1024 * 1024)
    throw new Error("ranking_avatar_too_large");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 2 * 1024 * 1024)
    throw new Error("ranking_avatar_too_large");
  return body;
}

function normalizeDiscordAvatarUrl(value) {
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

function normalizeEntry(entry, index) {
  const cultivationLevel = Math.max(0, safeInteger(entry?.cultivationLevel, 0));
  return {
    rank: Math.max(1, safeInteger(entry?.rank, index + 1)),
    power: Math.max(0, safeNumber(entry?.power, 0)),
    vaultLevel: Math.max(1, safeInteger(entry?.vaultLevel, 1)),
    cultivationLevel,
    highestTier: Math.max(0, Math.min(10, safeInteger(entry?.highestTier, 0))),
    isSelf: entry?.isSelf === true,
    displayName: safeDisplayName(entry?.displayName),
    avatarUrl: entry?.avatarUrl ?? null,
  };
}

function safeDisplayName(value) {
  const compact = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  const bounded = [...compact].slice(0, 32).join("");
  return bounded || "Đạo Hữu";
}

function safeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const ROW_CENTERS = [335, 463, 590, 704, 807, 911, 1016, 1122, 1228, 1334];

function avatarGeometry(index) {
  const size = index === 0 ? 92 : index < 3 ? 86 : 76;
  const centerX = index === 0 ? 156 : index < 3 ? 158 : 157;
  const centerY = ROW_CENTERS[index] ?? ROW_CENTERS.at(-1);
  return {
    size,
    left: Math.round(centerX - size / 2),
    top: Math.round(centerY - size / 2),
    centerX,
    centerY,
  };
}

function buildHeaderSvg(entryCount, totalPlayers) {
  const safeTotal = Math.max(entryCount, safeInteger(totalPlayers, entryCount));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RANKING_CARD_WIDTH}" height="${RANKING_CARD_HEIGHT}">
    <defs>
      <filter id="titleGlow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <g text-anchor="middle" filter="url(#titleGlow)">
      <text x="512" y="137" fill="#f8dca0" stroke="#513518" stroke-width="1" paint-order="stroke" font-family="Noto Serif, serif" font-size="47" font-weight="800" letter-spacing="7">THIÊN CƠ BẢNG</text>
      <text x="512" y="173" fill="#7de0d0" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="5">TOP 10 CAO THỦ LỰC CHIẾN</text>
    </g>
    <text x="512" y="231" text-anchor="middle" fill="#d7bb82" font-family="Noto Sans, sans-serif" font-size="13" font-weight="600" letter-spacing="2.5">${safeTotal.toLocaleString("vi-VN")} NGƯỜI CHƠI ĐÃ GHI DANH</text>
  </svg>`;
}

function buildContentSvg(entries, avatars) {
  const medalColors = ["#ffe194", "#e6f0f2", "#e7a778"];
  const rows = entries.map((entry, index) => {
    const { centerX, centerY, size } = avatarGeometry(index);
    const accent = medalColors[index] ?? "#64cdb9";
    const role = cultivationRoleName(entry.cultivationLevel);
    const tier = entry.highestTier > 0 ? `T${entry.highestTier}` : "Chưa có";
    const nameFontSize = [...entry.displayName].length > 24 ? 19 : index < 3 ? 27 : 23;
    const initial = escapeXml([...entry.displayName][0]?.toUpperCase() ?? "?");
    const fallbackAvatar = avatars[index]
      ? ""
      : `<circle cx="${centerX}" cy="${centerY}" r="${size / 2}" fill="#081a22"/><circle cx="${centerX}" cy="${centerY}" r="${size / 2 - 3}" fill="#102a31" stroke="${accent}" stroke-opacity=".38"/><text x="${centerX}" y="${centerY + 11}" text-anchor="middle" fill="${accent}" font-size="${index < 3 ? 34 : 29}" font-weight="700">${initial}</text>`;
    const selfBadge = entry.isSelf
      ? `<rect x="${centerX - 29}" y="${centerY + size / 2 - 21}" width="58" height="20" rx="10" fill="#0c332e" fill-opacity=".96" stroke="#75ddc8" stroke-opacity=".9"/><text x="${centerX}" y="${centerY + size / 2 - 7}" text-anchor="middle" fill="#a3f4e3" font-size="10" font-weight="800" letter-spacing="1">BẠN</text>`
      : "";
    return `<g font-family="Noto Sans, sans-serif">
      ${fallbackAvatar}
      <text x="232" y="${centerY - 9}" fill="${accent}" font-family="Noto Serif, serif" font-size="${index < 3 ? 21 : 17}" font-weight="800">#${entry.rank}</text>
      <text x="${index < 3 ? 284 : 275}" y="${centerY - 9}" fill="#fff0cd" stroke="#071217" stroke-width=".7" paint-order="stroke" font-family="Noto Serif, serif" font-size="${nameFontSize}" font-weight="700">${escapeXml(entry.displayName)}</text>
      ${selfBadge}
      <text x="232" y="${centerY + 25}" fill="#a9c9c2" stroke="#071217" stroke-width=".45" paint-order="stroke" font-size="${index < 3 ? 14.5 : 13.5}">${escapeXml(role)} · Tu vi ${entry.cultivationLevel}  |  Linh Khố ${entry.vaultLevel}  |  Hồn Khí ${tier}</text>
      <text x="824" y="${centerY - 5}" text-anchor="end" fill="${index < 3 ? accent : "#f2d28e"}" stroke="#071217" stroke-width=".8" paint-order="stroke" font-size="${index < 3 ? 29 : 25}" font-weight="800">${numberFormat.format(entry.power)}</text>
      <text x="824" y="${centerY + 21}" text-anchor="end" fill="#80a9a1" font-size="11" font-weight="700" letter-spacing="1.8">LỰC CHIẾN</text>
    </g>`;
  }).join("");
  const empty = entries.length === 0
    ? '<g font-family="Noto Sans, sans-serif" text-anchor="middle"><text x="512" y="765" fill="#f2d28e" font-size="31">Thiên Cơ Bảng chưa ghi nhận cao thủ</text><text x="512" y="808" fill="#8eb4ac" font-size="18">Hãy tu luyện và triệu dẫn Hồn Khí để khai bảng.</text></g>'
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RANKING_CARD_WIDTH}" height="${RANKING_CARD_HEIGHT}">
    ${rows}${empty}
    <g font-family="Noto Serif, serif" text-anchor="middle"><text x="512" y="1482" fill="#d3b77f" stroke="#071217" stroke-width=".5" paint-order="stroke" font-size="13" letter-spacing="3">THIÊN CƠ DẪN LỘ · HỒN KHÍ GIÁNG THẾ</text></g>
  </svg>`;
}

function escapeXml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
}
