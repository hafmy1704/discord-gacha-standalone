import sharp from "sharp";
import { readFileSync } from "node:fs";

const numberFormat = new Intl.NumberFormat("vi-VN");

export async function buildActivityStatCard({ displayName, username, avatarUrl, serverIconUrl, joinedAt, createdAt, stats, channelNames = {} }) {
  const avatar = await fetchAvatar(avatarUrl, 96);
  const serverIcon = readFileSync(new URL("./assets/server-avatar-round.png", import.meta.url)).toString("base64");
  const background = readFileSync(new URL("./assets/activity-stat-background.png", import.meta.url));
  const discordLogo = readFileSync(new URL("./assets/discord-logo.png", import.meta.url)).toString("base64");
  const rows = [["1 ngày", stats.windows.one], ["7 ngày", stats.windows.seven], ["30 ngày", stats.windows.thirty]];
  const chatRows = rows.map(([label, value], index) => `<text x="214" y="${342 + index * 25}" class="muted">${label}</text><text x="520" y="${342 + index * 25}" text-anchor="end" class="rowValue">${numberFormat.format(value.chat)} tin nhắn</text>`).join("");
  const voiceRows = rows.map(([label, value], index) => `<text x="668" y="${342 + index * 25}" class="muted">${label}</text><text x="981" y="${342 + index * 25}" text-anchor="end" class="rowValue">${formatHours(value.voiceSeconds)} giờ</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#182128" stop-opacity=".96"/><stop offset="1" stop-color="#10171d" stop-opacity=".94"/></linearGradient>
    <linearGradient id="softPanel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#293238" stop-opacity=".9"/><stop offset="1" stop-color="#1d252b" stop-opacity=".9"/></linearGradient>
    <linearGradient id="subPanel" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#202b32"/><stop offset="1" stop-color="#121a20"/></linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="8"/><feOffset dy="5"/><feComponentTransfer><feFuncA type="linear" slope=".28"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="avatarGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <style>
      .title{font:700 30px Cambria,Georgia,serif;fill:#f8fafc}.username{font:400 17px 'Noto Sans',Arial,sans-serif;fill:#b8c0c8}.meta{font:600 16px 'Noto Sans',Arial,sans-serif;fill:#f1f3f5}.section{font:700 20px Cambria,Georgia,serif;fill:#f8fafc}.label{font:400 16px 'Noto Sans',Arial,sans-serif;fill:#c0c6cd}.total{font:700 31px Cambria,Georgia,serif;fill:#fff}.muted{font:400 16px 'Noto Sans',Arial,sans-serif;fill:#c0c6cd}.rowValue{font:600 16px 'Noto Sans',Arial,sans-serif;fill:#eef1f4}.rank{font:700 29px Cambria,Georgia,serif;fill:#fff}.small{font:400 14px 'Noto Sans',Arial,sans-serif;fill:#aab1b8}.channel{font:700 18px 'Noto Sans',Arial,sans-serif;fill:#f5f7fa}
    </style>
    <clipPath id="avatar"><circle cx="196" cy="82" r="46"/></clipPath>
    <clipPath id="serverIcon"><circle cx="643" cy="106" r="14"/></clipPath>
  </defs>
  <rect width="1200" height="800" fill="transparent"/>
  <circle cx="196" cy="82" r="49" fill="#2f353b" stroke="#d4b36a" stroke-width="2" filter="url(#avatarGlow)"/>
  ${avatar ? `<image href="data:image/png;base64,${avatar}" x="150" y="36" width="92" height="92" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/>` : `<text x="196" y="92" text-anchor="middle" class="rank">?</text>`}
  <text x="270" y="78" class="title">${escapeXml(truncate(displayName, 22))}</text><text x="270" y="111" class="username">@${escapeXml(truncate(username ?? displayName, 28))}</text>
  <g transform="translate(500 111)"><image href="data:image/png;base64,${discordLogo}" x="-4" y="-19" width="28" height="28" preserveAspectRatio="xMidYMid meet"/><text x="28" y="1" class="username">${escapeXml(formatDate(createdAt))}</text></g>
  <g transform="translate(630 111)">${serverIcon ? `<image href="data:image/png;base64,${serverIcon}" x="3" y="-16" width="22" height="22" preserveAspectRatio="xMidYMid slice"/>` : `<circle cx="13" cy="-5" r="14" fill="#5865f2"/><text x="13" y="1" text-anchor="middle" class="meta">G</text>`}<text x="34" y="1" class="username">${escapeXml(formatDate(joinedAt))}</text></g>
  <text x="170" y="202" class="section">💬 Số tin nhắn</text><text x="624" y="202" class="section">🔊 Số giờ voice</text>
  <rect x="170" y="216" width="405" height="218" rx="20" fill="url(#panel)" stroke="#71808a" stroke-opacity=".12" filter="url(#softShadow)"/><rect x="624" y="216" width="405" height="218" rx="20" fill="url(#panel)" stroke="#71808a" stroke-opacity=".12" filter="url(#softShadow)"/>
  <text x="194" y="250" class="label">Tổng tin nhắn</text><text x="194" y="290" class="total">${numberFormat.format(stats.total.chat)} tin nhắn</text><rect x="194" y="310" width="357" height="108" rx="14" fill="url(#softPanel)"/>${chatRows}
  <text x="648" y="250" class="label">Tổng giờ voice</text><text x="648" y="290" class="total">${formatHours(stats.total.voiceSeconds)} giờ</text><rect x="648" y="310" width="357" height="108" rx="14" fill="url(#softPanel)"/>${voiceRows}
  <text x="170" y="484" class="section">🏆 Xếp hạng</text><text x="624" y="484" class="section">🏅 Kênh tương tác nhiều nhất</text>
  <rect x="170" y="502" width="195" height="126" rx="18" fill="url(#subPanel)" stroke="#8799a4" stroke-opacity=".22" filter="url(#softShadow)"/><rect x="380" y="502" width="195" height="126" rx="18" fill="url(#subPanel)" stroke="#8799a4" stroke-opacity=".22" filter="url(#softShadow)"/>
  <text x="192" y="534" class="label">💬 Chat</text><text x="192" y="574" class="rank">#${stats.ranks?.chat?.rank ?? "-"}</text><text x="192" y="604" class="small">${numberFormat.format(stats.ranks?.chat?.value ?? 0)} tin</text>
  <text x="402" y="534" class="label">🔊 Voice</text><text x="402" y="574" class="rank">#${stats.ranks?.voice?.rank ?? "-"}</text><text x="402" y="604" class="small">${formatHours(stats.ranks?.voice?.value ?? 0)} giờ</text>
  <rect x="624" y="502" width="405" height="58" rx="16" fill="url(#subPanel)" stroke="#8799a4" stroke-opacity=".22" filter="url(#softShadow)"/><rect x="624" y="570" width="405" height="58" rx="16" fill="url(#subPanel)" stroke="#8799a4" stroke-opacity=".22" filter="url(#softShadow)"/>
  <text x="646" y="537" class="label"># Chat</text><text x="730" y="537" class="channel">${escapeXml(truncate(channelNames.chat ?? "N/A", 22))}</text><text x="1004" y="537" text-anchor="end" class="small">${numberFormat.format(stats.channels?.chat?.value ?? 0)} tin</text>
  <text x="646" y="605" class="label">🔊 Voice</text><text x="730" y="605" class="channel">${escapeXml(truncate(channelNames.voice ?? "N/A", 20))}</text><text x="1004" y="605" text-anchor="end" class="small">${formatHours(stats.channels?.voice?.value ?? 0)} giờ</text>
  </svg>`;
  return sharp(background).resize(1200, 800, { fit: "cover" }).composite([{ input: Buffer.from(svg), blend: "over" }]).png().toBuffer();
}
export async function buildActivityRankingCard({ metric, entries, self, profiles = new Map() }) {
  const label = metric === "voice" ? "VOICE" : "CHAT";
  const accent = metric === "voice" ? "#f4c866" : "#59e3ca";
  const visibleEntries = (entries ?? []).slice(0, 10);
  const avatars = await Promise.all(visibleEntries.map((entry) => fetchAvatar(profiles.get(entry.userId)?.avatarUrl, 42)));
  const rows = visibleEntries.map((entry, index) => {
    const profile = profiles.get(entry.userId) ?? {};
    const y = 184 + index * 45;
    const avatar = avatars[index];
    return `<rect x="58" y="${y - 29}" width="1084" height="38" rx="12" fill="${index % 2 ? "#142235" : "#1b2a3b"}"/><text x="84" y="${y}" class="rank" fill="${accent}">#${entry.rank}</text>${avatar ? `<image href="data:image/png;base64,${avatar}" x="142" y="${y - 23}" width="42" height="42" clip-path="url(#rowAvatar${index})" preserveAspectRatio="xMidYMid slice"/>` : `<circle cx="163" cy="${y - 2}" r="21" fill="#294057"/>`}<text x="198" y="${y + 5}" class="name">${escapeXml(truncate(profile.displayName ?? `Đạo Hữu #${entry.userId.slice(-5)}`, 42))}</text><text x="1112" y="${y + 5}" text-anchor="end" class="value">${metric === "voice" ? `${formatHours(entry.value)} giờ` : `${numberFormat.format(entry.value)} tin`}</text>`;
  }).join("");
  const clips = visibleEntries.map((_, index) => `<clipPath id="rowAvatar${index}"><circle cx="163" cy="${182 + index * 45}" r="21"/></clipPath>`).join("");
  const selfText = self ? `Hạng của bạn  #${self.rank}  ·  ${metric === "voice" ? `${formatHours(self.value)} giờ` : `${numberFormat.format(self.value)} tin nhắn`}` : "Chưa có dữ liệu trong 30 ngày";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><defs><linearGradient id="rankBg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b1220"/><stop offset="1" stop-color="#17263a"/></linearGradient><style>.title{font:700 34px Arial;fill:#f8fbff}.sub{font:400 17px Arial;fill:#9eafc2}.rank{font:700 21px Arial}.name{font:600 18px Arial;fill:#f5f8fc}.value{font:700 17px Arial;fill:#f5f8fc}.self{font:700 18px Arial;fill:#fff}.empty{font:400 21px Arial;fill:#aeb8c5}</style>${clips}</defs><rect width="1200" height="760" rx="34" fill="#080e17"/><rect x="18" y="18" width="1164" height="724" rx="28" fill="url(#rankBg)" stroke="#2b4057"/><text x="58" y="84" class="title">BXH ${label}</text><text x="58" y="116" class="sub">Toàn server · 30 ngày gần nhất · Top 10</text><rect x="58" y="142" width="1084" height="3" rx="2" fill="${accent}"/>${rows.length ? rows : `<text x="600" y="390" text-anchor="middle" class="empty">Chưa có dữ liệu hoạt động</text>`}<rect x="58" y="650" width="1084" height="1" fill="#2b4057"/><text x="58" y="696" class="self">${escapeXml(selfText)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function formatDate(value) {
  if (!value) return "--/--/----";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--/--/----";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}
function formatHours(seconds) { return (Number(seconds ?? 0) / 3600).toFixed(2); }
function truncate(value, max) { const text = String(value ?? ""); return [...text].slice(0, max).join("") + ([...text].length > max ? "…" : ""); }
async function fetchAvatar(url, size) {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return (await sharp(Buffer.from(await response.arrayBuffer())).resize(size, size).png().toBuffer()).toString("base64");
  } catch { return null; }
}
function escapeXml(value) { return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]); }
