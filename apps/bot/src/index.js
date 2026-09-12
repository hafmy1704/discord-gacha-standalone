import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { createDatabase } from "./database.js";
import { createMiniappServer } from "./server.js";
import { validateChatContent } from "./content.js";
import { buildHonKhiCatalog } from "./hon-khi.js";
import {
  BEGINNER_ROLE_NAME,
  cultivationRoleName,
  cultivationRoleNames,
} from "./roles.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";

// ── Environment loading ───────────────────────────────────────────────────────
// Load variables from .env using Node's built-in loader. Tries the repo root
// first, then apps/bot, then the current working directory. System-provided
// environment variables always take precedence.

for (const envUrl of ["../../../.env", "../.env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(envUrl, import.meta.url)));
    break;
  } catch {
    // candidate not found — try the next location
  }
}

// ── Environment validation ────────────────────────────────────────────────────

const REQUIRED_VARS = [
  "DISCORD_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_CLIENT_SECRET",
  "WELCOME_CHANNEL_ID",
  "SON_MON_CATEGORY_ID",
  "MINIAPP_SIGNING_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
for (const name of REQUIRED_VARS) {
  if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
}

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SIGNING_SECRET = process.env.MINIAPP_SIGNING_SECRET;
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535)
  throw new Error("PORT must be an integer between 1 and 65535");
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const MINIAPP_ALLOWED_ORIGINS = (process.env.MINIAPP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// ── Services ──────────────────────────────────────────────────────────────────

let discordReady = false;
const database = createDatabase();
const miniappServer = createMiniappServer({
  database,
  signingSecret: SIGNING_SECRET,
  guildId: GUILD_ID,
  discordClientId: APP_ID,
  discordClientSecret: CLIENT_SECRET,
  allowedOrigins: MINIAPP_ALLOWED_ORIGINS,
  isReady: () => discordReady,
});

let whitelistMutation = Promise.resolve();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ── Slash command definitions ─────────────────────────────────────────────────

function configureSoulOrderSubcommand(subcommand, name, description) {
  return subcommand
    .setName(name)
    .setDescription(description)
    .addUserOption((o) =>
      o
        .setName("nguoi-choi")
        .setDescription("Người nhận Hồn Lệnh")
        .setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("so-luong")
        .setDescription("Số Hồn Lệnh điều chỉnh")
        .setMinValue(1)
        .setMaxValue(1_000_000)
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("ly-do").setDescription("Lý do giao dịch").setMaxLength(200),
    );
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Xem hồ sơ tu vi và Hồn Lệnh")
    .addUserOption((o) =>
      o
        .setName("nguoi-choi")
        .setDescription("Bỏ trống để xem hồ sơ của bản thân"),
    ),
  new SlashCommandBuilder()
    .setName("hon-lenh")
    .setDescription("Điều chỉnh Hồn Lệnh cho người chơi")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      configureSoulOrderSubcommand(subcommand, "them", "Cộng Hồn Lệnh"),
    )
    .addSubcommand((subcommand) =>
      configureSoulOrderSubcommand(subcommand, "xoa", "Trừ Hồn Lệnh"),
    ),
  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("Chọn kênh nhận EXP Tu Vi và Hồn Lệnh")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("gacha")
    .setDescription("Mở Activity triệu dẫn Hồn Khí"),
];

// ── Bot ready ─────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const existingConfig = await database.getGuildRewardConfig(GUILD_ID);
    const seedChannels = existingConfig ? [...existingConfig.channelIds] : [];
    await database.configureGuild({
      guildId: GUILD_ID,
      channelIds: seedChannels,
    });
    await database
      .cleanupActivityLog()
      .catch((error) =>
        console.error("activity log cleanup failed", error.message),
      );
    const cleanupTimer = setInterval(
      () => {
        database
          .cleanupActivityLog()
          .catch((error) =>
            console.error("activity log cleanup failed", error.message),
          );
      },
      24 * 60 * 60 * 1000,
    );
    cleanupTimer.unref?.();
    await database.seedHonKhiCatalog(buildHonKhiCatalog());
    const guild = await readyClient.guilds.fetch(GUILD_ID);
    await initializeVoiceSessions(guild);
    await flushLevelUpEvents();
    await guild.commands.set(COMMANDS);
    discordReady = true;
    console.log(`✅ Bot ready: ${readyClient.user.tag} | server ${HOST}:${PORT}`);
  } catch (error) {
    discordReady = false;
    console.error("bot startup failed", error);
    await shutdown("startup failure", 1);
  }
});

// ── New member ────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;
  try {
    await database.enrollPlayer({
      guildId: GUILD_ID,
      userId: member.id,
    });
    await assignRoleByName(member, BEGINNER_ROLE_NAME);

    const welcomeChannel = await member.guild.channels.fetch(
      process.env.WELCOME_CHANNEL_ID,
    );
    if (!welcomeChannel?.isTextBased()) return;

    const link = (channelId, label) =>
      `[${label}](https://discord.com/channels/${GUILD_ID}/${channelId})`;

    await welcomeChannel.send({
      content: `Chào mừng **${member}** đã đến với **Thiên Cơ Tông**\n> *Cứ thong thả khám phá — một hành trình tu luyện mới vừa bắt đầu.*`,
      embeds: [
        new EmbedBuilder()
          .setColor(0xec4899)
          .setAuthor({ name: "THIÊN CƠ TÔNG · HƯỚNG DẪN NHẬP MÔN" })
          .setTitle("⚡ CHÀO MỪNG TÂN SINH")
          .setDescription(
            "Ngươi đã được Thiên Cơ Tông ghi danh là **Tân Sinh**. Hãy tích lũy Điểm Tu Vi để từng bước tiến lên các cảnh giới cao hơn.",
          )
          .addFields(
            {
              name: "`01` 📜 Pháp Tắc Tông Môn",
              value: `${link("1543687935663018124", "Pháp Tắc")} để hiểu rõ quy củ, giới luật và con đường tu luyện tại tông môn.`,
            },
            {
              name: "`02` ✨ Con Đường Tu Luyện",
              value: `${link("1543688097966063761", "Trò Chuyện")} để nhận Điểm Tu Vi và Hồn Lệnh, tiến cấp từ Tân Sinh lên Hồn Sĩ.`,
            },
          ),
        new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle("🏮 Sinh Hoạt Tông Môn")
          .setDescription(
            `Luận đạo tại ${link("1543688097966063761", "Trò Chuyện")} để nhận **Điểm Tu Vi** và **Hồn Lệnh**. Nếu cần chỉ điểm, ghé ${link("1544082189333831770", "Trợ Giúp")}.\n\n*Mỗi cuộc trò chuyện là một bước nhỏ trên con đường tiến tới cảnh giới cao hơn.*`,
          )
          .setFooter({
            text: "Thiên Cơ Dẫn Lộ · Đồng hành cùng hành trình của ngươi",
          }),
      ],
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    console.error("member onboarding failed", {
      userId: member.id,
      error: error.message,
    });
  }
});
// ── Interactions ──────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.guildId !== GUILD_ID) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith("whitelist-page:")) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return;
      const page = Number(interaction.customId.split(":")[1]);
      await interaction.update(await buildWhitelistPanel(interaction.guild, page));
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("whitelist-select:")) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return;
      const page = Number(interaction.customId.split(":")[1]);
      const channels = await listRewardChannels(interaction.guild);
      const pageChannels = channels.slice(page * 25, page * 25 + 25);
      const selected = new Set(interaction.values);
      await Promise.all(pageChannels.map((channel) =>
        selected.has(channel.id)
          ? database.addRewardChannel({ guildId: GUILD_ID, channelId: channel.id })
          : database.removeRewardChannel({ guildId: GUILD_ID, channelId: channel.id }),
      ));
      await interaction.update(await buildWhitelistPanel(interaction.guild, page));
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // /gacha
    if (interaction.commandName === "gacha") {
      await interaction.launchActivity({ withResponse: true });
      return;
    }

    // /profile
    if (interaction.commandName === "profile") {
      await interaction.deferReply({ flags: 0 });
      const target =
        interaction.options.getUser("nguoi-choi") ?? interaction.user;
      const profile = await database.getProfile({
        guildId: GUILD_ID,
        userId: target.id,
      });
      if (profile && target.id === interaction.user.id && interaction.member)
        await syncCultivationRole(interaction.member, profile.cultivationLevel);
      const equipment = profile
        ? await database.getProfileEquipment({
            guildId: GUILD_ID,
            userId: target.id,
          })
        : [];
      const ranking = profile
        ? await database.getServerPowerRank({
            guildId: GUILD_ID,
            userId: target.id,
          })
        : null;
      const card = await buildProfileCard({
        user: target,
        profile,
        equipment,
        ranking,
      });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x66ead1)
            .setImage("attachment://profile-card.png"),
        ],
        files: [new AttachmentBuilder(card, { name: "profile-card.png" })],
      });
      return;
    }

    // /hon-lenh
    if (interaction.commandName === "hon-lenh") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Chỉ **Administrator** được dùng lệnh này.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const operation = interaction.options.getSubcommand(true);
      if (!new Set(["them", "xoa"]).has(operation))
        throw new Error("invalid_operation");
      const target = interaction.options.getUser("nguoi-choi", true);
      const amount = interaction.options.getInteger("so-luong", true);
      const reason =
        interaction.options.getString("ly-do") ??
        (operation === "them" ? "admin_grant" : "admin_remove");
      const result =
        operation === "them"
          ? await database.grantSoulOrders({
              guildId: GUILD_ID,
              userId: target.id,
              amount,
              sourceId: `admin_grant:${interaction.id}`,
              adminUserId: interaction.user.id,
              reason,
            })
          : await database.removeSoulOrders({
              guildId: GUILD_ID,
              userId: target.id,
              amount,
              sourceId: `admin_remove:${interaction.id}`,
              adminUserId: interaction.user.id,
              reason,
            });
      const verb = operation === "them" ? "cộng" : "trừ";
      await interaction.reply({
        content: result.duplicate
          ? "Giao dịch đã được xử lý trước đó."
          : `Đã ${verb} **${amount} Hồn Lệnh** ${operation === "them" ? "cho" : "của"} <@${target.id}>. Số dư mới: **${result.soul_orders}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /whitelist
    if (interaction.commandName === "whitelist") {
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ) {
        await interaction.reply({
          content: "Chỉ **Administrator** được dùng whitelist.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        ...(await buildWhitelistPanel(interaction.guild)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (error) {
    console.error("interaction failed", error);
    if (error.code === 40060 || error.code === 10062) return;
    const msg = error.message;
    const content =
      error.code === 50234 || error.code === 50231
        ? "Activity gacha chưa được bật trong Discord Developer Portal. Vào Activities > Settings > Supported Platforms và bật Web."
        : msg === "not_enrolled"
          ? "Người chơi chưa có profile."
          : msg === "invalid_amount"
            ? "Số Hồn Lệnh phải từ 1 đến 1.000.000."
            : msg === "insufficient_soul_orders"
              ? "Số dư Hồn Lệnh không đủ để trừ."
            : "Không thể xử lý thao tác. Thử lại sau.";
    if (interaction.replied || interaction.deferred)
      await interaction
        .followUp({ content, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    else
      await interaction
        .reply({ content, flags: MessageFlags.Ephemeral })
        .catch(() => {});
  }
});

// ── Chat messages ─────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (
    !message.guildId ||
    message.guildId !== GUILD_ID ||
    message.author.bot ||
    message.webhookId
  )
    return;
  try {
    const config = await database.getGuildRewardConfig(message.guildId);
    if (!config?.channelIds.has(message.channelId)) return;

    const validation = validateChatContent(message.content);
    if (!validation.eligible) return;

    const isHumanReply = Boolean(
      message.reference?.messageId &&
      (await message
        .fetchReference()
        .then(
          (ref) =>
            !ref.author.bot &&
            !ref.webhookId &&
            ref.author.id !== message.author.id,
        )
        .catch(() => false)),
    );

    const result = await database.awardChatMessage({
      guildId: message.guildId,
      userId: message.author.id,
      messageId: message.id,
      fingerprint: validation.fingerprint,
      uniqueCharacters: validation.uniqueCharacters,
      sentenceCount: validation.sentenceCount,
      isHumanReply,
    });

    if (!result.skipped && result.leveled_up && message.member)
      await syncCultivationRole(message.member, result.new_level);
    if (!result.skipped) await flushLevelUpEvents();
  } catch (error) {
    console.error("chat reward failed", {
      messageId: message.id,
      error: error.message,
    });
  }
});

const VOICE_SCAN_INTERVAL_MS = 60 * 1000;

async function initializeVoiceSessions(guild) {
  const config = await database.getGuildRewardConfig(guild.id);
  const selected = config?.channelIds ?? new Set();
  const requests = [];
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || state.member?.user.bot) continue;
    requests.push(database.setVoiceSession({ guildId: guild.id, userId: state.id, active: selected.has(state.channelId) }));
  }
  await Promise.allSettled(requests);
}

async function awardVoiceMember(guild, userId, channelId, selectedChannels) {
  if (selectedChannels && !selectedChannels.has(channelId)) return;
  const result = await database.awardVoiceActivity({ guildId: guild.id, userId, channelId });
  if (!result?.skipped && result?.leveled_up) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) await syncCultivationRole(member, result.new_level);
  }
  if (!result?.skipped) await flushLevelUpEvents();
}

async function scanVoice() {
  const requests = [];
  for (const guild of client.guilds.cache.values()) {
    const config = await database.getGuildRewardConfig(guild.id);
    const selected = config?.channelIds ?? new Set();
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.member?.user.bot || !selected.has(state.channelId)) continue;
      requests.push(awardVoiceMember(guild, state.id, state.channelId, selected).catch((error) => console.error("voice reward failed", { userId: state.id, error: error.message })));
    }
  }
  await Promise.allSettled(requests);
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (oldState.member?.user.bot || newState.member?.user.bot) return;
  if (oldState.channelId === newState.channelId) return;
  try {
    const config = await database.getGuildRewardConfig(newState.guild.id);
    const selected = config?.channelIds ?? new Set();
    if (oldState.channelId) await awardVoiceMember(newState.guild, newState.id, oldState.channelId, selected);
    await database.setVoiceSession({ guildId: newState.guild.id, userId: newState.id, active: Boolean(newState.channelId && selected.has(newState.channelId)) });
  } catch (error) {
    console.error("voice session update failed", error.message);
  }
});

client.once(Events.ClientReady, () => {
  const voiceTimer = setInterval(() => {
    scanVoice().catch((error) => console.error("voice scan failed", error.message));
  }, VOICE_SCAN_INTERVAL_MS);
  voiceTimer.unref?.();
  const levelEventTimer = setInterval(() => {
    flushLevelUpEvents().catch((error) =>
      console.error("level-up queue failed", error.message),
    );
  }, 30 * 1000);
  levelEventTimer.unref?.();
});

async function buildProfileCard({ user, profile, equipment, ranking }) {
  const root = fileURLToPath(new URL("../../gacha/public/", import.meta.url));
  const level = profile?.cultivationLevel ?? 0;

  const points = profile?.cultivationPoints ?? 0;
  const required = profile?.cultivationPointsRequired ?? 100;
  const soulOrders = profile?.soulOrders ?? 0;
  const role = cultivationRoleName(level);
  const combatPower = profile?.power ?? 0;
  const displayName = escapeXml(
    String(user.globalName ?? user.displayName ?? user.username).slice(0, 27),
  );
  const progress = Math.max(
    0,
    Math.min(1, Number(profile?.cultivationProgress ?? 0) || 0),
  );
  const avatarResponse = await fetch(
    user.displayAvatarURL({ extension: "png", size: 256 }),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!avatarResponse.ok)
    throw new Error(`Avatar fetch failed: ${avatarResponse.status}`);
  const avatar = await sharp(Buffer.from(await avatarResponse.arrayBuffer()))
    .resize(132, 132)
    .composite([
      {
        input: Buffer.from(
          '<svg width="132" height="132"><circle cx="66" cy="66" r="66" fill="white"/></svg>',
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  const statTotals = profile?.equipmentStats ?? {};
  const statValues = [
    "hp",
    "attack",
    "accuracy",
    "speed",
    "critRate",
    "critDamage",
    "skillHaste",
    "evasion",
    "basicPower",
    "skillPower",
    "ultimatePower",
    "damageReduction",
  ].map((key) =>
    statTotals[key] === undefined
      ? "-"
      : Math.round(statTotals[key]).toLocaleString("vi-VN"),
  );
  const statCenters = [117, 272, 430, 588, 744, 901];
  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><defs><filter id="avatarGlow"><feGaussianBlur stdDeviation="5"/></filter></defs><g font-family="Noto Serif,Noto Sans,serif"><circle cx="114" cy="116" r="78" fill="none" stroke="#66ead1" stroke-width="3" opacity=".6" filter="url(#avatarGlow)"/><circle cx="114" cy="116" r="76" fill="none" stroke="#d7b879" stroke-width="2"/><circle cx="114" cy="116" r="71" fill="none" stroke="#66ead1" stroke-width="2"/><path d="M114 35v12M114 185v12M33 116h12M183 116h12" stroke="#d7b879" stroke-width="3"/><path d="M59 61l8 8M161 61l-8 8M59 171l8-8M161 171l-8-8" stroke="#66ead1" stroke-width="2"/><g fill="#fff0c6"><text x="205" y="91" font-size="27" font-weight="bold">${displayName}</text><text x="205" y="124" fill="#d7b879" font-size="17">${escapeXml(role)} · Cấp ${level}</text><rect x="205" y="143" width="260" height="18" rx="9" fill="#140f0a" stroke="#b88b48"/><rect x="209" y="147" width="${Math.round(progress * 252)}" height="10" rx="5" fill="#e3bd70"/><text x="205" y="185" fill="#ead7a2" font-size="14">EXP ${points.toLocaleString("vi-VN")} / ${required.toLocaleString("vi-VN")}</text><text x="465" y="185" fill="#d7b879" text-anchor="end" font-size="14">${soulOrders.toLocaleString("vi-VN")} Hồn Lệnh</text></g><g fill="#fff0c6" text-anchor="middle"><text x="216" y="738" font-size="28" font-weight="bold">${escapeXml(role)}</text><text x="522" y="738" font-size="30" font-weight="bold">${Math.round(combatPower).toLocaleString("vi-VN")}</text><text x="808" y="738" font-size="24" font-weight="bold">${ranking?.rank ? `#${ranking.rank}` : "-"}</text>${statValues.map((value, index) => `<text x="${statCenters[index % 6]}" y="${index < 6 ? 990 : 1147}" font-size="24" font-weight="bold">${value}</text>`).join("")}</g></g></svg>`;
  const composites = [
    { input: avatar, top: 50, left: 48 },
    { input: Buffer.from(textSvg), top: 0, left: 0 },
  ];
  const itemCenters = [116, 272, 432, 590, 742, 896];
  const itemRows = [1298, 1428];
  const itemOffsets = [4, 0, 0, 0, 4, 5, 6, 0, -3, 0, 7, 0];
  const itemFineOffsets = [2, 3, -1, 1, 0, 3, 1, -1, -1, -1, 0, 0];
  const tierGlowColors = [
    "#b6c5c1",
    "#63da95",
    "#61c8ff",
    "#bd78ff",
    "#ffc45e",
    "#ffb14e",
    "#ff8795",
    "#ff6673",
    "#ff5965",
    "#ff4757",
  ];
  await Promise.all(
    (equipment ?? []).slice(0, 12).map(async (item, index) => {
      if (!item.asset?.startsWith("/hon-khi/")) return;
      try {
        const assetPath = resolve(root, item.asset.slice(1));
        const pathFromRoot = relative(root, assetPath);
        if (
          pathFromRoot === ".." ||
          pathFromRoot.startsWith(`..${sep}`) ||
          isAbsolute(pathFromRoot)
        )
          return;
        const input = await sharp(readFileSync(assetPath))
          .resize(108, 108, { fit: "contain" })
          .png()
          .toBuffer();
        const left =
          itemCenters[index % 6] -
          54 +
          itemOffsets[index] +
          itemFineOffsets[index];
        const top = itemRows[Math.floor(index / 6)] - 54;
        const color =
          tierGlowColors[
            Math.max(
              0,
              Math.min(tierGlowColors.length - 1, Number(item.tier) - 1),
            )
          ];
        const glowSvg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop stop-color="' +
          color +
          '" stop-opacity=".42"/><stop offset=".52" stop-color="' +
          color +
          '" stop-opacity=".16"/><stop offset=".78" stop-color="' +
          color +
          '" stop-opacity=".05"/><stop offset="1" stop-color="' +
          color +
          '" stop-opacity="0"/></radialGradient><filter id="b"><feGaussianBlur stdDeviation="8"/></filter></defs><circle cx="54" cy="54" r="51" fill="url(#g)" filter="url(#b)"/><circle cx="54" cy="54" r="30" fill="url(#g)" opacity=".45"/></svg>';
        composites.push({ input: Buffer.from(glowSvg), left, top });
        composites.push({ input, left, top });
      } catch {}
    }),
  );
  return sharp(readFileSync(new URL("../profile-card.png", import.meta.url)))
    .composite(composites)
    .png()
    .toBuffer();
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
async function listRewardChannels(guild) {
  return [...(await guild.channels.fetch()).values()]
    .filter((channel) => channel?.type === 0 || channel?.isVoiceBased?.())
    .sort((a, b) => {
      const categoryPosition = (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1);
      return categoryPosition || a.rawPosition - b.rawPosition || a.name.localeCompare(b.name, "vi");
    });
}

async function buildWhitelistPanel(guild, page = 0) {
  const config = await database.getGuildRewardConfig(GUILD_ID);
  const selected = config?.channelIds ?? new Set();
  const channels = await listRewardChannels(guild);
  const pageCount = Math.max(1, Math.ceil(channels.length / 25));
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const pageChannels = channels.slice(currentPage * 25, currentPage * 25 + 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("whitelist-select:" + currentPage)
    .setPlaceholder("Chọn kênh nhận thưởng")
    .setMinValues(0)
    .setMaxValues(Math.max(1, pageChannels.length));
  for (const channel of pageChannels) {
    const category = channel.parent?.name ? channel.parent.name + " / " : "Ngoài category / ";
    const kind = channel.isVoiceBased?.() ? "Voice" : "Chat";
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel((category + channel.name).slice(0, 100))
        .setValue(channel.id)
        .setDescription((kind + " · " + (selected.has(channel.id) ? "Đang bật" : "Đang tắt")).slice(0, 100))
        .setDefault(selected.has(channel.id)),
    );
  }
  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("whitelist-page:" + (currentPage - 1))
      .setLabel("‹ Trang trước")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("whitelist-page:" + (currentPage + 1))
      .setLabel("Trang sau ›")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= pageCount - 1),
  );
  return {
    content: "**Whitelist nhận EXP chat và voice**\nTrang " + (currentPage + 1) + "/" + pageCount + " · Kênh voice được chọn sẽ nhận thưởng treo voice.",
    components: [new ActionRowBuilder().addComponents(menu), navigation],
  };
}
// ── Helpers ───────────────────────────────────────────────────────────────────

async function assignRoleByName(member, roleName) {
  const roles = await member.guild.roles.fetch();
  const role = roles.find((r) => r.name === roleName);
  if (!role) throw new Error(`Missing Discord role: ${roleName}`);
  await member.roles.add(role);
  return role;
}

async function notifyLevelUp(member, level) {
  const channelId = process.env.LEVEL_UP_CHANNEL_ID?.trim();
  if (!channelId || !member?.guild) return false;
  try {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel?.isTextBased())
      throw new Error("LEVEL_UP_CHANNEL_ID must point to a text channel");
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle("✨ Đột Phá Cảnh Giới")
          .setDescription("Chúc mừng <@" + member.id + "> đã đạt **Cấp " + level + "**!")
          .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
          .setFooter({ text: "Thiên Cơ Tông · Tu vi tiến thêm một bước" }),
      ],
      allowedMentions: { users: [member.id] },
    });
    return true;
  } catch (error) {
    console.error("level-up notification failed", { userId: member.id, error: error.message });
    return false;
  }
}

async function flushLevelUpEvents() {
  if (!process.env.LEVEL_UP_CHANNEL_ID?.trim()) return;
  const events = await database.claimLevelUpEvents(50);
  const guild = await client.guilds.fetch(GUILD_ID);
  for (const event of events ?? []) {
    const eventId = event.id;
    const claimToken = event.claim_token ?? event.claimToken;
    const member = await guild.members.fetch(event.user_id ?? event.userId).catch(() => null);
    if (!member) {
      await database.markLevelUpEventSent({ eventId, claimToken });
      continue;
    }
    const sent = await notifyLevelUp(member, Number(event.level));
    if (sent)
      await database.markLevelUpEventSent({ eventId, claimToken });
    else
      await database.markLevelUpEventFailed({ eventId, claimToken, error: "notification_failed" });
  }
}

async function syncCultivationRole(member, level) {
  if (!member?.roles?.add) return;
  const roles = await member.guild.roles.fetch();
  const targetName = cultivationRoleName(level);
  const targetRole = roles.find((r) => r.name === targetName);
  if (!targetRole) throw new Error(`Missing Discord role: ${targetName}`);

  const managed = roles.filter(
    (r) =>
      r.name === BEGINNER_ROLE_NAME || cultivationRoleNames().includes(r.name),
  );
  await Promise.all(
    [...managed.values()]
      .filter((r) => r.id !== targetRole.id && member.roles.cache.has(r.id))
      .map((r) => member.roles.remove(r)),
  );
  if (!member.roles.cache.has(targetRole.id))
    await member.roles.add(targetRole);
}

// ── Startup & shutdown ────────────────────────────────────────────────────────

async function shutdown(signal, exitCode = 0) {
  console.log(`Shutdown: ${signal}`);
  discordReady = false;
  client.destroy();
  if (miniappServer.listening)
    await new Promise((resolve) => miniappServer.close(resolve));
  process.exit(exitCode);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await new Promise((resolve, reject) => {
  const onError = (error) => {
    miniappServer.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    miniappServer.off("error", onError);
    resolve();
  };
  miniappServer.once("error", onError);
  miniappServer.once("listening", onListening);
  miniappServer.listen(PORT, HOST);
});
console.log(`🌐 Miniapp server listening on ${HOST}:${PORT}`);
try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  discordReady = false;
  client.destroy();
  if (miniappServer.listening)
    await new Promise((resolve) => miniappServer.close(resolve));
  throw error;
}
