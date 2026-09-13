import {
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { cultivationRoleName } from "./roles.js";

export const RANKING_CARD_WIDTH = 1200;
export const RANKING_CARD_HEIGHT = 1500;
const MAX_RANKING_ENTRIES = 10;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DISCORD_AVATAR_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);
const BACKGROUND_PATH = fileURLToPath(
  new URL(
    "../../gacha/public/ui/generated/inventory-vault-bg.webp",
    import.meta.url,
  ),
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
  background = BACKGROUND_PATH,
} = {}) {
  const entries = topRankingEntries(leaderboard).map(normalizeEntry);
  const avatars = await Promise.all(
    entries.map(async (entry) => {
      const avatarUrl = normalizeDiscordAvatarUrl(entry.avatarUrl);
      if (!avatarUrl) return null;
      try {
        const source = await avatarLoader(avatarUrl);
        if (!source) return null;
        return await sharp(source, {
          failOn: "error",
          limitInputPixels: 4096 * 4096,
        })
          .resize(76, 76, { fit: "cover", position: "centre" })
          .composite([
            {
              input: Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76"><circle cx="38" cy="38" r="38" fill="#fff"/></svg>',
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

  const base = await sharp(background)
    .resize(RANKING_CARD_WIDTH, RANKING_CARD_HEIGHT, {
      fit: "cover",
      position: "centre",
    })
    .modulate({ brightness: 0.52, saturation: 0.78 })
    .png()
    .toBuffer();
  const composites = [
    { input: Buffer.from(buildBackdropSvg(entries.length, leaderboard?.totalPlayers)) },
  ];
  for (let index = 0; index < avatars.length; index += 1) {
    if (!avatars[index]) continue;
    composites.push({
      input: avatars[index],
      left: 112,
      top: rowTop(index) + 10,
    });
  }
  composites.push({ input: Buffer.from(buildContentSvg(entries, avatars)) });

  const card = await sharp(base)
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

function rowTop(index) {
  return 276 + index * 111;
}

function buildBackdropSvg(entryCount, totalPlayers) {
  const safeTotal = Math.max(entryCount, safeInteger(totalPlayers, entryCount));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RANKING_CARD_WIDTH}" height="${RANKING_CARD_HEIGHT}">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#031018" stop-opacity=".72"/><stop offset=".48" stop-color="#031018" stop-opacity=".9"/><stop offset="1" stop-color="#02080d" stop-opacity=".96"/></linearGradient>
      <radialGradient id="aura" cx="50%" cy="0" r="80%"><stop stop-color="#60d8c0" stop-opacity=".2"/><stop offset=".48" stop-color="#d8ad5f" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      <linearGradient id="line" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#d9ad60" stop-opacity="0"/><stop offset=".5" stop-color="#f1cf86"/><stop offset="1" stop-color="#d9ad60" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="1200" height="1500" fill="url(#shade)"/>
    <rect width="1200" height="560" fill="url(#aura)"/>
    <circle cx="600" cy="91" r="53" fill="none" stroke="#d9ad60" stroke-width="2" opacity=".65"/>
    <circle cx="600" cy="91" r="42" fill="none" stroke="#69d9c4" stroke-width="1.5" opacity=".8"/>
    <path d="M600 52l11 24 26 3-19 18 5 26-23-13-23 13 5-26-19-18 26-3z" fill="#e8c77e" opacity=".92"/>
    <rect x="105" y="211" width="990" height="2" fill="url(#line)"/>
    <rect x="42" y="30" width="1116" height="1432" rx="30" fill="none" stroke="#d9ad60" stroke-width="2" opacity=".52"/>
    <rect x="52" y="40" width="1096" height="1412" rx="24" fill="none" stroke="#69d9c4" stroke-width="1" opacity=".19"/>
    <g fill="#f2d28e" font-family="Noto Sans, sans-serif" font-size="15" letter-spacing="3"><text x="600" y="248" text-anchor="middle">${safeTotal.toLocaleString("vi-VN")} NGƯỜI CHƠI ĐÃ GHI DANH</text></g>
  </svg>`;
}

function buildContentSvg(entries, avatars) {
  const medalColors = ["#ffd778", "#d8e4e5", "#dc9a68"];
  const rows = entries.map((entry, index) => {
    const y = rowTop(index);
    const accent = medalColors[index] ?? "#64cdb9";
    const fillOpacity = index < 3 ? ".19" : ".12";
    const role = cultivationRoleName(entry.cultivationLevel);
    const tier = entry.highestTier > 0 ? `T${entry.highestTier}` : "Chưa có";
    const nameFontSize = [...entry.displayName].length > 24 ? 23 : 27;
    const initial = escapeXml([...entry.displayName][0]?.toUpperCase() ?? "?");
    const fallbackAvatar = avatars[index]
      ? ""
      : `<circle cx="150" cy="${y + 48}" r="38" fill="#102a31"/><text x="150" y="${y + 58}" text-anchor="middle" fill="#e8c77e" font-size="29" font-weight="700">${initial}</text>`;
    const selfBadge = entry.isSelf
      ? `<rect x="708" y="${y + 19}" width="58" height="24" rx="12" fill="#65d7c1" fill-opacity=".15" stroke="#65d7c1" stroke-opacity=".55"/><text x="737" y="${y + 36}" text-anchor="middle" fill="#8ff1dc" font-size="12" font-weight="700" letter-spacing="1">BẠN</text>`
      : "";
    return `<g font-family="Noto Sans, sans-serif">
      <rect x="55" y="${y}" width="1090" height="96" rx="19" fill="#071820" fill-opacity="${fillOpacity}" stroke="${accent}" stroke-opacity="${index < 3 ? ".62" : ".24"}" stroke-width="1.5"/>
      <rect x="55" y="${y + 18}" width="4" height="60" rx="2" fill="${accent}"/>
      <text x="87" y="${y + 58}" text-anchor="middle" fill="${accent}" font-family="Noto Serif, serif" font-size="27" font-weight="700">#${entry.rank}</text>
      ${fallbackAvatar}
      <circle cx="150" cy="${y + 48}" r="39" fill="none" stroke="${accent}" stroke-width="2"/>
      <circle cx="150" cy="${y + 48}" r="43" fill="none" stroke="#65d7c1" stroke-opacity=".2"/>
      <text x="210" y="${y + 41}" fill="#fff1cd" font-family="Noto Serif, serif" font-size="${nameFontSize}" font-weight="700">${escapeXml(entry.displayName)}</text>
      ${selfBadge}
      <text x="210" y="${y + 72}" fill="#aac9c2" font-size="15.5">${escapeXml(role)} · Tu vi ${entry.cultivationLevel}  |  Linh Khố ${entry.vaultLevel}  |  Hồn Khí ${tier}</text>
      <text x="1090" y="${y + 48}" text-anchor="end" fill="${index < 3 ? accent : "#f2d28e"}" font-size="34" font-weight="800">${numberFormat.format(entry.power)}</text>
      <text x="1090" y="${y + 73}" text-anchor="end" fill="#7fa59d" font-size="12" font-weight="700" letter-spacing="2">LỰC CHIẾN</text>
    </g>`;
  }).join("");
  const empty = entries.length === 0
    ? '<g font-family="Noto Sans, sans-serif" text-anchor="middle"><text x="600" y="760" fill="#f2d28e" font-size="34">Thiên Cơ Bảng chưa ghi nhận cao thủ</text><text x="600" y="808" fill="#8eb4ac" font-size="20">Hãy tu luyện và triệu dẫn Hồn Khí để khai bảng.</text></g>'
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RANKING_CARD_WIDTH}" height="${RANKING_CARD_HEIGHT}">
    <g text-anchor="middle"><text x="600" y="164" fill="#f5d998" font-family="Noto Serif, serif" font-size="55" font-weight="800" letter-spacing="7">THIÊN CƠ BẢNG</text><text x="600" y="199" fill="#78d9c7" font-family="Noto Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="6">TOP 10 CAO THỦ LỰC CHIẾN</text></g>
    ${rows}${empty}
    <g font-family="Noto Sans, sans-serif" text-anchor="middle"><text x="600" y="1432" fill="#c9a96d" font-size="14" letter-spacing="3">THIÊN CƠ DẪN LỘ · HỒN KHÍ GIÁNG THẾ</text></g>
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
